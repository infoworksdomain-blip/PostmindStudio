import { formatDuration, PLATFORM_LABEL } from '@/lib/client/format';
import type { ProjectDetail } from '@/lib/client/types';

// The written script per target format, set as a readable manuscript.

export function ScriptView({ project }: { project: ProjectDetail }) {
  const { brief, scripts } = project;
  return (
    <div className="flex flex-col gap-8">
      {brief && (
        <dl className="grid gap-4 border-l-2 border-primary/60 pl-4 sm:grid-cols-2">
          {(
            [
              ['Hook', brief.hook],
              ['Key message', brief.keyMessage],
              ['Audience', brief.targetAudience],
              ['Tone', brief.tone],
            ] as const
          ).map(([term, value]) => (
            <div key={term}>
              <dt className="text-xs tracking-[0.14em] text-muted-foreground uppercase">{term}</dt>
              <dd className="mt-1 text-sm">{value || '—'}</dd>
            </div>
          ))}
        </dl>
      )}
      {scripts.length === 0 && (
        <p className="text-sm text-muted-foreground">The script hasn’t been written yet.</p>
      )}
      {scripts.map((script) => (
        <article key={script.id} aria-label={`Script for ${script.targetPlatform}`}>
          <header className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h3 className="font-display text-2xl">
              {PLATFORM_LABEL[script.targetPlatform] ?? script.targetPlatform}
            </h3>
            <p className="tabular text-xs text-muted-foreground">
              {script.targetAspectRatio} · {formatDuration(script.targetDurationSec)} ·{' '}
              {script.shots.length} shots
            </p>
          </header>
          <p className="max-w-prose font-display text-lg leading-relaxed whitespace-pre-wrap">
            {script.fullText}
          </p>
        </article>
      ))}
    </div>
  );
}
