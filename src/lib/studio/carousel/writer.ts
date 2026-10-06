// The carousel thread writer (21.6): Claude through the provider router, exactly as video scripts
// are written (cost-tracked per project, routed, budget-checked, failover to the next provider).
// Business facts, brand voice, restricted topics and language come from the same places as the
// caption writer (services/caption-suggestions.ts loadCopyContext) and the brand kit.
import type { PrismaClient, VideoProject } from '@prisma/client';
import { runProvider, jsonOutput, type ProviderRunDeps } from '../pipeline/provider-run';
import type { PlanTier } from '../providers/router';
import { loadCopyContext } from '../services/caption-suggestions';
import {
  buildPostRewritePrompt,
  buildThreadPrompt,
  parsePostRewrite,
  parseThreadResult,
  POST_OUTPUT_SCHEMA,
  THREAD_OUTPUT_SCHEMA,
  THREAD_SYSTEM_PROMPT,
  type ThreadPromptInput,
  type ThreadResult,
} from './thread-prompt';

/** A whole thread fits well inside this (12 posts × 600 characters + the JSON). */
export const THREAD_MAX_TOKENS = 6_000;
export const POST_REWRITE_MAX_TOKENS = 1_500;

export type TextGenerator = (request: {
  system: string;
  prompt: string;
  outputSchema: Record<string, unknown>;
  maxTokens: number;
}) => Promise<unknown>;

/** Claude via the router, charged to the project (cost caps and budgets apply). */
export function projectTextGenerator(
  providers: ProviderRunDeps,
  scope: { organisationId: string; projectId: string; planTier: PlanTier },
): TextGenerator {
  return async (request) => {
    const run = await runProvider(
      {
        need: { kind: 'capability', capability: 'text_generation' },
        planTier: scope.planTier,
        request: {
          capability: 'text_generation',
          // 23.2: thread writing and post rewrites stay on the planning model.
          task: 'carousel_thread',
          organisationId: scope.organisationId,
          projectId: scope.projectId,
          system: request.system,
          prompt: request.prompt,
          outputSchema: request.outputSchema,
          maxTokens: request.maxTokens,
        },
      },
      providers,
    );
    return jsonOutput(run.output);
  };
}

type ContextDb = Parameters<typeof loadCopyContext>[0] &
  Pick<PrismaClient, 'brandKit' | 'businessProfile'>;

export type ThreadContext = Omit<ThreadPromptInput, 'brief' | 'postCount'>;

/** Facts, voice, audience, restricted topics and language for a project's thread. */
export async function loadThreadContext(
  db: ContextDb,
  project: Pick<VideoProject, 'organisationId' | 'businessId' | 'brandKitId' | 'language'>,
  now: number,
): Promise<ThreadContext> {
  const copy = await loadCopyContext(db, project, now);
  const profile = await db.businessProfile.findUnique({
    where: {
      organisationId_businessId: {
        organisationId: project.organisationId,
        businessId: project.businessId,
      },
    },
    select: { toneIndicators: true, brandVoiceSummary: true },
  });
  const kit = await db.brandKit.findFirst({
    where: project.brandKitId
      ? { id: project.brandKitId, organisationId: project.organisationId }
      : {
          organisationId: project.organisationId,
          businessId: project.businessId,
          isDefault: true,
        },
    select: { toneKeywords: true, audienceProfile: true },
  });
  const voice = [
    ...(kit?.toneKeywords ?? []),
    ...(profile?.toneIndicators ?? []),
    ...(profile?.brandVoiceSummary ? [profile.brandVoiceSummary] : []),
  ];
  return {
    language: project.language || 'en-GB',
    facts: {
      businessName: copy.facts.businessName ?? null,
      industry: copy.facts.industry ?? null,
      subNiche: copy.facts.subNiche ?? null,
      products: copy.facts.products ?? [],
      services: copy.facts.services ?? [],
      regions: copy.facts.regions ?? [],
      audience: copy.facts.audienceKeywords ?? [],
    },
    voice: [...new Set(voice)],
    audienceProfile: kit?.audienceProfile ?? null,
    restrictedTopics: copy.restrictedTopics,
  };
}

export async function writeThread(
  generate: TextGenerator,
  input: ThreadPromptInput,
): Promise<ThreadResult> {
  const json = await generate({
    system: THREAD_SYSTEM_PROMPT,
    prompt: buildThreadPrompt(input),
    outputSchema: THREAD_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
    maxTokens: THREAD_MAX_TOKENS,
  });
  return parseThreadResult(json, input.postCount);
}

export async function rewritePost(
  generate: TextGenerator,
  input: Parameters<typeof buildPostRewritePrompt>[0],
): Promise<string> {
  const json = await generate({
    system: THREAD_SYSTEM_PROMPT,
    prompt: buildPostRewritePrompt(input),
    outputSchema: POST_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
    maxTokens: POST_REWRITE_MAX_TOKENS,
  });
  return parsePostRewrite(json);
}
