import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { createPipelineDeps } from '../src/lib/studio/pipeline/create-deps';
import { createBullJobQueue, InlineJobQueue, jobIds } from '../src/lib/studio/queue/enqueue';
import type { ProjectJobData } from '../src/lib/studio/queue/queues';
import { redisConnectionFromEnv } from '../src/lib/studio/queue/redis';
import { drainInline } from '../src/lib/studio/queue/workers/runtime';
import { main, out } from './lib/harness';

// GATE 3 (BACKLOG): "Operator triggers a test project end-to-end (brief → script → one AI clip
// generated → composed → quality-checked)". Uses REAL providers, database, S3 and ffmpeg.
//
//   npm run gate3                 # runs the whole pipeline in this process (no Redis needed)
//   npm run gate3 -- --queue      # enqueues on BullMQ; run `npm run worker` in another terminal
//
// Spends real money: Claude calls, one ~5s Runway clip, ElevenLabs narration, a Shotstack
// render (use SHOTSTACK_ENVIRONMENT=stage) and a Hive scan.

const ORG = 'gate3-smoke-org';

main(async () => {
  const useQueue = process.argv.includes('--queue');
  const db = new PrismaClient();
  try {
    const runId = randomUUID();
    const project = await db.videoProject.create({
      data: {
        organisationId: ORG,
        businessId: 'gate3-business',
        createdByUserId: 'gate3-operator',
        name: 'Leeds Sourdough Co',
        description:
          'A 15-second TikTok announcing our new weekly sourdough subscription for busy Leeds professionals. Warm, friendly tone. Call to action: subscribe on our website.',
        state: 'QUEUED',
        sourceType: 'BRIEF',
        targetFormats: [{ platform: 'tiktok', aspectRatio: '9:16', duration: 15 }],
        costBudgetPence: 1_000,
        metadata: { runId },
      },
    });
    out(`project ${project.id} (run ${runId})`);
    const job: ProjectJobData = {
      projectId: project.id,
      organisationId: ORG,
      runId,
      planTier: 'STANDARD',
    };

    if (useQueue) {
      const queue = createBullJobQueue(redisConnectionFromEnv());
      await queue.add('plan-project', job, { jobId: jobIds.planProject(job) });
      await queue.close();
      out('plan-project enqueued. Watch progress with: npm run db:studio (video_projects.state)');
      return true;
    }

    const inline = new InlineJobQueue();
    const deps = createPipelineDeps({ db, queue: inline });
    await inline.add('plan-project', job);
    const result = await drainInline(inline, deps);
    const final = await db.videoProject.findUniqueOrThrow({
      where: { id: project.id },
      include: {
        scripts: { include: { shots: { orderBy: { sortOrder: 'asc' } } } },
        renders: true,
      },
    });

    out();
    out(`state: ${final.state}${final.errorReason ? ` — ${final.errorReason}` : ''}`);
    out(`jobs executed: ${result.executed}; failed: ${result.failedJobs.join(', ') || 'none'}`);
    for (const script of final.scripts) {
      out(
        `script ${script.targetPlatform} ${script.targetAspectRatio} ${script.targetDurationSec}s`,
      );
      for (const shot of script.shots) {
        out(
          `  #${shot.sortOrder + 1} ${shot.visualTreatment} ${shot.durationSec}s ${shot.state}${shot.errorReason ? ` (${shot.errorReason})` : ''}`,
        );
      }
    }
    for (const render of final.renders) {
      out(
        `render ${render.id}: s3://${render.s3Bucket}/${render.s3Key} ${render.resolution} ${render.durationSec}s → ${render.qualityCheckState}`,
      );
      for (const check of (render.qualityIssues as Array<{
        code: string;
        status: string;
        detail: string;
      }>) ?? []) {
        out(`  ${check.status.padEnd(7)} ${check.code}: ${check.detail}`);
      }
    }
    out(`cost: ${final.costActualPence}p`);
    return ['READY_FOR_REVIEW', 'QUALITY_FAILED'].includes(final.state);
  } finally {
    await db.$disconnect();
  }
});
