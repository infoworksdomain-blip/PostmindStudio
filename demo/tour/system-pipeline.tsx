import { Chapter, Code, DataTable, Panel, Pill, SceneVideo } from './ui';

// Behind the scenes, part 1: the generation pipeline, queues and workers, provider routing.
// Sources: CLAUDE.md "9-layer generation pipeline", providers/router.ts (candidate lists),
// providers/default-registry.ts (adapters that exist), queue/queues.ts, queue/worker-host.ts,
// providers/circuit-breaker.ts.

interface Provider {
  id: string;
  /** An adapter exists in src/lib/studio/providers (registered when its API key is set). */
  built: boolean;
}

interface Layer {
  n: number;
  name: string;
  job: string;
  what: string;
  providers: Provider[];
}

const b = (id: string): Provider => ({ id, built: true });
const planned = (id: string): Provider => ({ id, built: false });

const LAYERS: Layer[] = [
  {
    n: 1,
    name: 'Ideation',
    job: 'plan-project',
    what: 'Brief → concrete idea; vague briefs return 3 directions, restricted topics stop for confirmation.',
    providers: [b('anthropic (claude-sonnet-5)'), planned('openai (text)')],
  },
  {
    n: 2,
    name: 'Script + storyboard',
    job: 'plan-project',
    what: 'One script per target format, shot list fitted to the duration, auto-suggested overlays, script-safety gate.',
    providers: [b('anthropic'), planned('openai (text)')],
  },
  {
    n: 3,
    name: 'Assets',
    job: 'generate-asset',
    what: 'Per shot, routed by treatment and plan tier: AI clip, image still, avatar, stock, text card.',
    providers: [
      b('runway (gen4.5 / gen4_turbo)'),
      b('openai (gpt-image-2)'),
      b('luma (ray-3.2)'),
      b('kling (kling-3.0, 720p, silent)'),
      b('veo (veo-3.1-fast-generate-preview)'),
      planned('fal'),
      planned('replicate'),
      b('heygen (avatar v3)'),
      planned('d-id'),
      planned('storyblocks'),
      planned('pexels'),
    ],
  },
  {
    n: 4,
    name: 'Voice',
    job: 'generate-asset',
    what: 'Narration per shot in the brand voice (or ELEVENLABS_DEFAULT_VOICE_ID).',
    providers: [b('elevenlabs'), planned('azure-speech')],
  },
  {
    n: 5,
    name: 'Music + SFX',
    job: 'compose-video',
    what: 'One instrumental track per run from a closed mood vocabulary, reused on re-render; sound effects from the script’s cues laid under the narration; STANDARD tier and above.',
    providers: [
      b('elevenlabs-music (music_v2_5)'),
      b('storyblocks-audio (SFX)'),
      planned('replicate'),
      planned('storyblocks'),
    ],
  },
  {
    n: 6,
    name: 'Composition',
    job: 'compose-video',
    what: 'Shotstack edit decision list: clips, narration, music bed, rich-text overlays, brand end card.',
    providers: [b('shotstack'), planned('creatomate')],
  },
  {
    n: 7,
    name: 'Multi-format render',
    job: 'compose-video',
    what: 'One render per target format (9:16, 16:9, 1:1, 4:5), copied to the renders bucket, probed, and mastered when needed (loudnorm to −14 LUFS, H.264 Baseline re-encode).',
    providers: [b('shotstack'), b('ffmpeg / ffprobe (local)')],
  },
  {
    n: 8,
    name: 'Quality gate + review',
    job: 'run-quality-gate',
    what: 'Duration ±2 s, black frames > 500 ms, loudness −18…−10 LUFS, aspect, H.264/MP4; content safety is recorded as “Not scanned” (no provider since 20.21); then human or trusted auto-approval.',
    providers: [planned('content-safety provider (none: Hive removed 20.21)')],
  },
  {
    n: 9,
    name: 'Publish + track',
    job: 'publish-video · poll-publication-analytics',
    what: 'Per-platform publishers, scheduled posts, analytics polling 30 s → 5 min → … → weekly for 12 months.',
    providers: [
      b('TikTok'),
      b('YouTube'),
      b('X'),
      b('LinkedIn'),
      b('Instagram Reels'),
      b('Facebook Reels'),
    ],
  },
];

function PipelineDiagram() {
  return (
    <ol className="relative grid gap-3 md:grid-cols-3" aria-label="The nine pipeline layers">
      {LAYERS.map((l) => (
        <li key={l.n} className="relative rounded-xl border border-border bg-card p-4">
          <div className="flex items-baseline gap-3">
            <span className="font-display text-4xl leading-none text-primary">{l.n}</span>
            <div className="min-w-0">
              <p className="font-semibold">{l.name}</p>
              <code className="text-[0.68rem] text-muted-foreground">{l.job}</code>
            </div>
          </div>
          <p className="mt-2 text-sm break-words text-muted-foreground">{l.what}</p>
          <ul className="mt-3 flex flex-wrap gap-1" aria-label={`Providers for layer ${l.n}`}>
            {l.providers.map((p) => (
              <li key={p.id}>
                <Pill tone={p.built ? 'data' : 'neutral'}>
                  {p.built ? (
                    p.id
                  ) : (
                    <span className="line-through decoration-muted-foreground/50">{p.id}</span>
                  )}
                </Pill>
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ol>
  );
}

const QUEUE_ROWS: [string, string, number, number][] = [
  [
    'studio-orchestration',
    'plan-project, compose-video, run-quality-gate, populate-slideshow',
    10,
    3,
  ],
  ['studio-assets', 'generate-asset, scan-website, refresh-image-library', 15, 5],
  ['studio-publish', 'publish-video', 5, 3],
  ['studio-scheduled', 'fire-scheduled-publication', 3, 2],
  [
    'studio-analytics',
    'poll-publication-analytics, roll-up-analytics (02:15 UTC), check-pending-approvals (every 15 min)',
    5,
    2,
  ],
  ['studio-library', 'ingest-library-video (corpus, isolated)', 2, 1],
];

const ROUTER_SAMPLE = `// video_shots.providerRouting — the router's decision snapshot for one AI_CLIP shot,
// STANDARD plan, Kling's breaker open, a 10 s shot (Veo renders at most 8 s).
{
  "providerId": "runway",
  "capability": "text_to_video",
  "candidates": [
    { "providerId": "kling",  "skipped": "circuit_open" },
    { "providerId": "veo",    "skipped": "capability_unsupported" },
    { "providerId": "runway" }
  ],
  "decidedAt": "2026-09-27T09:14:03.118Z"
}
// Other skip reasons: capability_unsupported, provider_disabled (kill switch), over_budget,
// too_slow, no_cost_estimate, circuit_open. None left → NO_PROVIDER_AVAILABLE with the reasons.`;

export function PipelineChapters() {
  return (
    <>
      <Chapter
        id="pipeline"
        index="01"
        title="The 9-layer generation pipeline"
        description="Every video goes through the same nine layers. Highlighted providers have adapters in the code; struck-through ones are in the router’s candidate lists but have no adapter yet, so the router skips them as not_configured."
      >
        <div className="grid gap-4 lg:grid-cols-[1fr_11rem]">
          <PipelineDiagram />
          <div className="hidden lg:block">
            <SceneVideo
              scene="sourdough"
              aspect="9:16"
              caption="Layer 7 output"
              label="Sample 9:16 render"
              className="sticky top-20 rounded-xl"
            />
            <p className="mt-2 text-xs text-muted-foreground">
              A sample 9:16 render: narration captions, music bed, progress bar.
            </p>
          </div>
        </div>
        <p className="mt-4 text-xs text-muted-foreground">
          Slideshows skip layers 1–4 (no AI video); TEMPLATE projects from the library or a saved
          template constrain layer 2 to the reference’s shot blueprint.
        </p>
      </Chapter>

      <Chapter
        id="queues"
        index="02"
        title="Queues and workers"
        description="BullMQ on Redis DB 3. One queue per concern so each scales on its own; PLUS and ENTERPRISE jobs run at high priority, agency batches at low."
      >
        <Panel>
          <DataTable
            caption="Queues, their jobs, default concurrency and production replicas"
            head={['Queue', 'Jobs', 'Concurrency', 'Replicas (prod)']}
            rows={QUEUE_ROWS.map(([q, jobs, c, r]) => [
              <code key="q" className="text-xs">
                {q}
              </code>,
              <span key="j" className="text-muted-foreground">
                {jobs}
              </span>,
              c,
              r,
            ])}
          />
          <ul className="mt-4 grid gap-2 text-sm text-muted-foreground md:grid-cols-3">
            <li>
              <span className="font-medium text-foreground">Retries.</span> 6 attempts, backoff 5 s
              → 10 → 20 → 40 → 80 → cap 120 s; non-retryable errors stop at once.
            </li>
            <li>
              <span className="font-medium text-foreground">Dead letter.</span> Failed jobs are kept
              (removeOnFail: false) for an operator to re-drive.
            </li>
            <li>
              <span className="font-medium text-foreground">Runs.</span> Every job carries a runId;
              jobs from a superseded run are no-ops, so regenerate and cancel are safe.
            </li>
          </ul>
        </Panel>
      </Chapter>

      <Chapter
        id="router"
        index="03"
        title="Provider router and circuit breakers"
        description="The router picks a provider per shot from the treatment and plan tier, skipping anything disabled, over budget, too slow or broken."
      >
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <Panel title="AI clip candidates by plan tier">
            <DataTable
              head={['Tier', 'Candidates, in order']}
              rows={[
                ['BASIC', 'fal → replicate'],
                ['STANDARD', 'kling → veo → runway → luma'],
                ['PLUS / ENTERPRISE', 'kling → veo → runway → luma'],
                ['Avatar (≤ STANDARD)', 'd-id → heygen'],
                ['Stock footage', 'storyblocks → pexels'],
                ['Image still', 'openai → fal'],
              ]}
            />
            <div
              className="mt-5 grid grid-cols-3 gap-2 text-center text-xs"
              aria-label="Circuit breaker states"
            >
              {[
                ['Closed', 'requests flow', 'good'],
                ['Open', '5 failures in 60 s → skipped for 5 min', 'bad'],
                ['Half-open', 'one trial; success closes, failure re-opens', 'warn'],
              ].map(([s, d, tone]) => (
                <div key={s} className="rounded-lg border border-border p-2">
                  <Pill tone={tone as 'good' | 'bad' | 'warn'}>{s}</Pill>
                  <p className="mt-1.5 text-muted-foreground">{d}</p>
                </div>
              ))}
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              Breaker state is shared by every process through Redis (each process falls back to its
              own state if Redis is down) and exported as studio_provider_circuit_state (0 closed, 1
              half-open, 2 open).
            </p>
          </Panel>
          <Code label="sample: routing decision (illustrative values)">{ROUTER_SAMPLE}</Code>
        </div>
      </Chapter>
    </>
  );
}
