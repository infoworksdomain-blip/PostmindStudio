import {
  assertCommitSha,
  createRenderRequest,
  deployCommit,
  parseServiceIds,
} from '../../src/lib/render/deploy';
import { ConfigurationError } from '../../src/lib/errors';

// Deployment: Render. Deploy one commit to a Render environment and wait until it is live.
//
//   RENDER_API_KEY=rnd_… RENDER_DEPLOY_SERVICE_IDS=srv-web,srv-orch,… \
//     npx tsx scripts/render/deploy.ts <commit-sha> [--rebuild]
//
// RENDER_DEPLOY_SERVICE_IDS lists the environment's web service FIRST (its pre-deploy command
// runs the migrations), then the six worker services. Reuses a retained build of the commit
// when there is one (a Render rollback), otherwise builds it. Exit 0 only when every service is
// live. As STAGING_DEPLOY_CMD for the rollback rehearsal (runbooks/staging-gate.md):
//   STAGING_DEPLOY_CMD='npx tsx scripts/render/deploy.ts {tag}'

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const commitArg = args.find((a) => !a.startsWith('--'));
  if (!commitArg) throw new ConfigurationError('usage: deploy.ts <commit-sha> [--rebuild]');
  const commit = assertCommitSha(commitArg);
  const apiKey = process.env.RENDER_API_KEY?.trim();
  if (!apiKey) throw new ConfigurationError('Missing required environment variable RENDER_API_KEY');
  const serviceIds = parseServiceIds(process.env.RENDER_DEPLOY_SERVICE_IDS);

  const log = (line: string) => process.stdout.write(`${line}\n`);
  log(`Deploying ${commit} to ${serviceIds.length} Render service(s)`);
  const results = await deployCommit(
    {
      request: createRenderRequest(apiKey),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      now: Date.now,
      log,
    },
    { serviceIds, commit, rebuild: args.includes('--rebuild') },
  );
  const failed = results.filter((r) => !r.ok);
  const skipped = serviceIds.length - results.length;
  if (failed.length || skipped) {
    log(
      `FAILED: ${failed.map((r) => `${r.serviceId}=${r.status}`).join(', ')}` +
        (skipped ? ` (${skipped} service(s) not deployed)` : ''),
    );
    process.exitCode = 1;
    return;
  }
  log(`All ${results.length} service(s) live on ${commit}`);
}

main().catch((err: unknown) => {
  process.stderr.write(`deploy: ${err instanceof Error ? err.message : 'failed'}\n`);
  process.exitCode = 1;
});
