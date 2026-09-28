import { ArrowRight, ArrowUpRight, Bell } from 'lucide-react';
import { DEMO_BUSINESS_NAME } from '../api/ids';
import { BELL_NOTE, SCREEN_GROUPS, type ScreenEntry } from './screens-data';
import { Chapter, Pill, SceneThumb, SceneVideo, TourHeader, Toc } from './ui';
import { WORKFLOWS, type Workflow } from './workflows';

// #/tour — welcome, how to use the demo, the complete screen index and guided workflows.

const linkClass =
  'rounded-sm underline decoration-border underline-offset-4 transition-colors hover:decoration-primary focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none';

function HowTo() {
  const items = [
    [
      'Click anything.',
      'These are the real Studio screens. Buttons call a sample API running in this page, so approving, publishing or engaging a kill switch changes what you see next.',
    ],
    [
      'Nothing leaves the page.',
      'No platform is posted to and no AI provider is called. Images and clips are drawn in your browser and marked SAMPLE.',
    ],
    [
      'Reload to reset.',
      'The sample data starts fresh on every load, with dates relative to today.',
    ],
  ] as const;
  return (
    <ol className="mt-8 grid gap-4 md:grid-cols-3">
      {items.map(([title, body], i) => (
        <li key={title} className="border-t-2 border-foreground pt-3">
          <p className="text-sm font-semibold">
            <span className="mr-2 font-display text-lg text-primary">{i + 1}</span>
            {title}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">{body}</p>
        </li>
      ))}
    </ol>
  );
}

function ScreenCard({ screen, wide }: { screen: ScreenEntry; wide: boolean }) {
  return (
    <article
      className={
        wide
          ? 'grid gap-5 rounded-xl border border-border bg-card p-4 wrap-anywhere md:grid-cols-[minmax(0,15rem)_1fr] md:p-5'
          : 'flex flex-col gap-4 rounded-xl border border-border bg-card p-4'
      }
    >
      <a
        href={screen.href}
        className="group block overflow-hidden rounded-lg"
        aria-label={`Open ${screen.title}`}
      >
        {screen.video ? (
          <SceneVideo
            scene={screen.scene}
            aspect="16:9"
            caption={screen.video}
            label={`Sample clip: ${screen.video}`}
            className="rounded-lg"
          />
        ) : (
          <SceneThumb
            scene={screen.scene}
            aspect="16:9"
            className="rounded-lg transition-transform duration-300 group-hover:scale-[1.03]"
          />
        )}
      </a>
      <div className="min-w-0">
        <div className="flex items-baseline justify-between gap-3">
          <h3 className="font-display text-2xl leading-tight">
            <a href={screen.href} className={linkClass}>
              {screen.title}
            </a>
          </h3>
          <code className="shrink-0 text-[0.7rem] text-muted-foreground">
            {screen.href.slice(1)}
          </code>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">{screen.summary}</p>
        {screen.links && (
          <ul className="mt-3 divide-y divide-border/70 border-t border-border/70">
            {screen.links.map((l) => (
              <li
                key={`${l.href}${l.label}`}
                className={
                  wide
                    ? 'grid gap-x-4 py-2 text-sm sm:grid-cols-[13rem_1fr]'
                    : 'grid gap-0.5 py-2 text-sm'
                }
              >
                <a href={l.href} className={`font-medium ${linkClass}`}>
                  {l.label}
                </a>
                <span className="text-muted-foreground">{l.note}</span>
              </li>
            ))}
          </ul>
        )}
        {screen.tryIt && (
          <ul className="mt-3 space-y-1.5 border-t border-border/70 pt-3 text-sm text-muted-foreground">
            {screen.tryIt.map((t) => (
              <li key={t} className="flex gap-2">
                <ArrowRight aria-hidden className="mt-0.5 size-3.5 shrink-0 text-primary" />
                {t}
              </li>
            ))}
          </ul>
        )}
      </div>
    </article>
  );
}

function ScreenIndex() {
  return (
    <div className="space-y-12">
      {SCREEN_GROUPS.map((group) => (
        <div key={group.key}>
          <div className="mb-4 flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b border-border pb-2">
            <h3 className="text-[0.7rem] font-semibold tracking-[0.2em] text-muted-foreground uppercase">
              {group.label}
            </h3>
            <p className="text-sm text-muted-foreground">{group.intro}</p>
          </div>
          <div className="grid gap-4 lg:grid-cols-3">
            {group.screens.map((s) => {
              const wide = Boolean(s.links && s.links.length > 3) || Boolean(s.tryIt);
              return (
                <div key={s.href} className={wide ? 'lg:col-span-3' : ''}>
                  <ScreenCard screen={s} wide={wide} />
                </div>
              );
            })}
          </div>
        </div>
      ))}
      <div className="flex items-start gap-3 rounded-xl border border-dashed border-border p-4 text-sm">
        <Bell aria-hidden className="mt-0.5 size-4 shrink-0 text-primary" />
        <p>
          <span className="font-medium">Notifications. </span>
          <span className="text-muted-foreground">{BELL_NOTE}</span>
        </p>
      </div>
    </div>
  );
}

function WorkflowCard({ flow, index }: { flow: Workflow; index: number }) {
  return (
    <article
      id={`flow-${flow.id}`}
      className="grid gap-5 rounded-xl border border-border bg-card p-4 wrap-anywhere sm:grid-cols-[7.5rem_1fr] md:p-5"
    >
      <SceneVideo
        scene={flow.scene}
        aspect="9:16"
        caption={flow.caption}
        label={`Sample clip for ${flow.title}`}
        className="mx-auto w-28 rounded-lg sm:w-full"
      />
      <div className="min-w-0">
        <p className="text-xs text-muted-foreground">Workflow {index + 1}</p>
        <h3 className="font-display text-2xl leading-tight">{flow.title}</h3>
        <p className="mt-1 text-sm text-muted-foreground">{flow.outcome}</p>
        <ol className="mt-4 space-y-2.5">
          {flow.steps.map((step, i) => (
            <li key={step.text} className="grid grid-cols-[1.5rem_1fr] gap-2 text-sm">
              <span className="font-display text-base leading-5 text-primary tabular-nums">
                {i + 1}
              </span>
              <span>
                {step.text}{' '}
                {step.href && step.cta && (
                  <a
                    href={step.href}
                    className="inline-flex items-center gap-0.5 font-medium whitespace-nowrap text-primary underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                  >
                    {step.cta}
                    <ArrowUpRight aria-hidden className="size-3.5" />
                  </a>
                )}
              </span>
            </li>
          ))}
        </ol>
      </div>
    </article>
  );
}

export function TourHome() {
  return (
    <div>
      <TourHeader
        eyebrow="PostMind Studio · guided demo"
        title={
          <>
            From one sentence to a video <em className="text-primary">on every platform.</em>
          </>
        }
        lede={
          <p>
            Studio turns a short brief into edited, captioned videos for TikTok, Shorts, Reels,
            LinkedIn, X and Facebook, checks them, and publishes them. This demo runs the real
            screens for a fictional bakery,{' '}
            <span className="text-foreground">{DEMO_BUSINESS_NAME}</span>.
          </p>
        }
      >
        <div className="mt-6 flex flex-wrap items-center gap-2">
          <a
            href="#/new"
            className="inline-flex h-9 items-center gap-1.5 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:outline-none"
          >
            Make a video <ArrowRight className="size-4" aria-hidden />
          </a>
          <a
            href="#/projects"
            className="inline-flex h-9 items-center rounded-md border border-border px-4 text-sm font-medium transition-colors hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            See the projects
          </a>
          <Pill tone="data">Sample data</Pill>
        </div>
        <HowTo />
        <Toc
          items={[
            { id: 'screens', label: 'Every screen' },
            { id: 'workflows', label: 'Guided workflows' },
            { id: 'more', label: 'Behind the scenes & not built' },
          ]}
        />
      </TourHeader>

      <Chapter
        id="screens"
        index="01"
        title="Every screen, and the states worth seeing"
        description="Grouped as the sidebar groups them. Each project below was set up to show one state of the pipeline."
      >
        <ScreenIndex />
      </Chapter>

      <Chapter
        id="workflows"
        index="02"
        title="Guided workflows"
        description="Short click paths through the demo, in order. Each step opens the screen where it happens."
      >
        <div className="grid gap-4 xl:grid-cols-2">
          {WORKFLOWS.map((flow, i) => (
            <WorkflowCard key={flow.id} flow={flow} index={i} />
          ))}
        </div>
      </Chapter>

      <Chapter
        id="more"
        index="03"
        title="What you can’t click"
        description="Much of Studio has no screen: the pipeline, queues, cost caps, alerting, security. And some of it isn’t built yet."
      >
        <div className="grid gap-4 md:grid-cols-2">
          <a
            href="#/tour/system"
            className="group rounded-xl border border-border bg-card p-5 transition-colors hover:border-primary focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            <p className="font-display text-2xl">Behind the scenes</p>
            <p className="mt-1 text-sm text-muted-foreground">
              The 9-layer pipeline, workers, provider routing, kill switch, cost caps, alerts, rate
              limits, security, internal endpoints and operations tooling, each with a sample of
              real output.
            </p>
            <span className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-primary">
              Open{' '}
              <ArrowRight
                className="size-4 transition-transform group-hover:translate-x-0.5"
                aria-hidden
              />
            </span>
          </a>
          <a
            href="#/tour/not-built"
            className="group rounded-xl border border-border bg-card p-5 transition-colors hover:border-primary focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            <p className="font-display text-2xl">Not built yet</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Every feature still missing, why, and a concrete plan (screens, endpoints, days,
              dependencies) to finish it.
            </p>
            <span className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-primary">
              Open{' '}
              <ArrowRight
                className="size-4 transition-transform group-hover:translate-x-0.5"
                aria-hidden
              />
            </span>
          </a>
        </div>
      </Chapter>
    </div>
  );
}
