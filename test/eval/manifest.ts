import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

// BACKLOG 15.D10 / A14.2 launch-readiness evals:
//   "Business classifier accuracy >85% on the 50-site labelled test set."
//   "Website scan completes end-to-end in under 5 minutes for the 20 test sites in the QA fixture."
// The labelled sites are Playbook H-03 (people work, not code). This module is the manifest
// FORMAT and the grading; the real manifests are dropped in by the operator:
//   test/eval/fixtures/classifier-manifest.json   (or EVAL_CLASSIFIER_MANIFEST)
//   test/eval/fixtures/scan-sites.json            (or EVAL_SCAN_SITES)
// The *.example.json files beside them are ILLUSTRATIVE ONLY (marked "illustrative": true) and
// are never used to claim accuracy or timing.

export const CLASSIFIER_ACCURACY_THRESHOLD = 0.85;
export const CLASSIFIER_SET_SIZE = 50;
export const SCAN_MAX_SECONDS = 300;
export const SCAN_SET_SIZE = 20;

const site = z.object({
  id: z.string().min(1),
  url: z.url(),
});

/**
 * One labelled site. `acceptIndustry` lists the phrases a correct classification contains
 * (case-insensitive, any one matches) — the labeller writes the synonyms they accept, because
 * the classifier returns free text ("Consumer goods — pets"). `rejectIndustry` phrases make a
 * match wrong even if an accepted phrase is present (e.g. "pet insurance" for a pet shop).
 */
export const labelledSite = site.extend({
  acceptIndustry: z.array(z.string().trim().min(2)).min(1),
  rejectIndustry: z.array(z.string().trim().min(2)).default([]),
  labelledBy: z.string().min(1),
  notes: z.string().optional(),
});
export type LabelledSite = z.infer<typeof labelledSite>;

export const classifierManifest = z.object({
  /** true for the example fixture: never counted as the A14.2 evaluation. */
  illustrative: z.boolean().default(false),
  source: z.string().min(1),
  sites: z.array(labelledSite).min(1),
});
export type ClassifierManifest = z.infer<typeof classifierManifest>;

export const scanSites = z.object({
  illustrative: z.boolean().default(false),
  source: z.string().min(1),
  /** A business id in the staging org per site (scans are per business). */
  sites: z.array(site.extend({ businessId: z.string().min(1) })).min(1),
});
export type ScanSites = z.infer<typeof scanSites>;

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

/** Whether a classification is correct for a labelled site. */
export function gradeClassification(
  labelled: Pick<LabelledSite, 'acceptIndustry' | 'rejectIndustry'>,
  classified: { industry: string; subNiche: string },
): boolean {
  const text = norm(`${classified.industry} | ${classified.subNiche}`);
  if (labelled.rejectIndustry.some((p) => text.includes(norm(p)))) return false;
  return labelled.acceptIndustry.some((p) => text.includes(norm(p)));
}

export interface EvalOutcome {
  id: string;
  correct: boolean;
  detail: string;
}

export function accuracy(outcomes: EvalOutcome[]): number {
  if (outcomes.length === 0) return 0;
  return outcomes.filter((o) => o.correct).length / outcomes.length;
}

function load<T>(
  schema: z.ZodType<T>,
  envName: string,
  fileName: string,
  env: Record<string, string | undefined>,
): T | null {
  const path =
    env[envName]?.trim() || fileURLToPath(new URL(`./fixtures/${fileName}`, import.meta.url));
  if (!existsSync(path)) return null;
  return schema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

/** The operator's labelled manifest, or null when it has not been delivered (H-03). */
export function loadClassifierManifest(
  env: Record<string, string | undefined> = process.env,
): ClassifierManifest | null {
  return load(classifierManifest, 'EVAL_CLASSIFIER_MANIFEST', 'classifier-manifest.json', env);
}

export function loadScanSites(
  env: Record<string, string | undefined> = process.env,
): ScanSites | null {
  return load(scanSites, 'EVAL_SCAN_SITES', 'scan-sites.json', env);
}

/** Why a manifest can't be used as the A14.2 set, or null when it can. */
export function notTheRealSet(
  manifest: { illustrative: boolean; sites: unknown[] } | null,
  expectedSize: number,
): string | null {
  if (!manifest) return 'manifest not delivered yet (Playbook H-03)';
  if (manifest.illustrative) return 'manifest is marked illustrative';
  if (manifest.sites.length < expectedSize)
    return `manifest has ${manifest.sites.length} sites; A14.2 needs ${expectedSize}`;
  return null;
}
