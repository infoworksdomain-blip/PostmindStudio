import { ArrowUpRight } from 'lucide-react';
import { BillingStatesPanel } from './billing-switcher';
import { Chapter, SceneVideo, TourHeader, Toc, useSectionScroll } from './ui';
import { WORKFLOW_AREAS, WORKFLOWS, type Workflow } from './workflows';

// #/tour/workflows — every guided workflow, grouped by area. Each step links to the screen or
// state it happens on (links carrying ?demoPlan= switch the billing state first).

const stepLink =
  'inline-flex items-center gap-0.5 font-medium whitespace-nowrap text-primary underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none';

export function WorkflowCard({ flow, index }: { flow: Workflow; index: number }) {
  return (
    <article
      id={`flow-${flow.id}`}
      className="grid scroll-mt-24 gap-5 rounded-xl border border-border bg-card p-4 wrap-anywhere sm:grid-cols-[7.5rem_1fr] md:p-5"
    >
      <SceneVideo
        scene={flow.scene}
        aspect="9:16"
        caption={flow.caption}
        label={`Sample clip for ${flow.title}`}
        className="mx-auto w-28 rounded-lg sm:w-full"
      />
      <div className="min-w-0">
        <p className="text-xs text-muted-foreground">
          Workflow {index + 1} · {flow.steps.length} steps
        </p>
        <h3 className="font-display text-2xl leading-tight">{flow.title}</h3>
        <p className="mt-1 text-sm text-muted-foreground">{flow.outcome}</p>
        <ol className="mt-4 space-y-2.5">
          {flow.steps.map((step, i) => (
            <li key={`${i}-${step.cta}`} className="grid grid-cols-[1.5rem_1fr] gap-2 text-sm">
              <span className="font-display text-base leading-5 text-primary tabular-nums">
                {i + 1}
              </span>
              <span>
                {step.text}{' '}
                <a href={step.href} className={stepLink}>
                  {step.cta}
                  <ArrowUpRight aria-hidden className="size-3.5" />
                </a>
              </span>
            </li>
          ))}
        </ol>
      </div>
    </article>
  );
}

export function WorkflowsPage() {
  useSectionScroll();
  return (
    // English-only tour text: kept left-to-right in every interface language.
    <div lang="en" dir="ltr">
      <TourHeader
        eyebrow="PostMind Studio · guided workflows"
        title={
          <>
            Walk it through, <em className="text-primary">step by step.</em>
          </>
        }
        lede={
          <p>
            {WORKFLOWS.length} click paths through everything built so far, from the landing page to
            a paying customer and on to running the platform. Each step opens the screen where it
            happens; some links also switch the demo’s plan (you’ll see the banner change). The demo
            starts signed out: app screens ask you to sign in first (any email and password), or use
            “Enter app as sample user” in the demo bar.
          </p>
        }
      >
        <Toc items={WORKFLOW_AREAS.map((a) => ({ id: `area-${a.key}`, label: a.label }))} />
      </TourHeader>
      <Chapter
        id="plans"
        index="00"
        title="Plan and billing state"
        description="The demo organisation starts on 3 channels, monthly. Switch it here or in the demo bar; the banner, Your plan, gates and badges follow."
      >
        <BillingStatesPanel />
      </Chapter>
      {WORKFLOW_AREAS.map((area, a) => (
        <Chapter
          key={area.key}
          id={`area-${area.key}`}
          index={String(a + 1).padStart(2, '0')}
          title={area.label}
          description={area.intro}
        >
          <div className="grid gap-4 xl:grid-cols-2">
            {WORKFLOWS.filter((f) => f.area === area.key).map((flow) => (
              <WorkflowCard key={flow.id} flow={flow} index={WORKFLOWS.indexOf(flow)} />
            ))}
          </div>
        </Chapter>
      ))}
    </div>
  );
}
