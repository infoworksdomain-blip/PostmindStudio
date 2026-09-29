import { DeliveryChapters } from './system-delivery';
import { HardeningChapters } from './system-hardening';
import { OpsChapters } from './system-ops';
import { PipelineChapters } from './system-pipeline';
import { SecurityChapters } from './system-security';
import { Pill, TourHeader, Toc, useSectionScroll } from './ui';

// #/tour/system — "Behind the scenes": the parts of Studio with no screen, each shown with a
// representative artifact taken from (or formatted exactly like) the real code's output.

const TOC = [
  { id: 'pipeline', label: 'Pipeline' },
  { id: 'queues', label: 'Queues' },
  { id: 'router', label: 'Router' },
  { id: 'kill-switch', label: 'Kill switch' },
  { id: 'redrive', label: 'Re-drive' },
  { id: 'cost', label: 'Cost caps' },
  { id: 'rate-limits', label: 'Rate limits' },
  { id: 'security', label: 'Security' },
  { id: 'internal', label: 'Meta endpoints' },
  { id: 'alerts', label: 'Alerting' },
  { id: 'corpus', label: 'Corpus' },
  { id: 'k6', label: 'Load test' },
  { id: 'deploy', label: 'Deployment' },
  { id: 'runbooks', label: 'Runbooks' },
  { id: 'golden', label: 'Golden paths' },
  { id: 'reliability', label: 'Reliability jobs' },
  { id: 'failover', label: 'Failover alert' },
  { id: 'storage', label: 'R2 storage' },
  { id: 'backup', label: 'Storage backup' },
];

export function SystemTour() {
  useSectionScroll();
  return (
    // English-only tour text: kept left-to-right in every interface language.
    <div lang="en" dir="ltr">
      <TourHeader
        eyebrow="Behind the scenes"
        title={
          <>
            The machinery <em className="text-primary">you don’t click.</em>
          </>
        }
        lede={
          <p>
            Most of Studio runs in workers, queues and ops tooling. Each section shows what it does
            and a sample of what it produces: files quoted from the repository, and command output
            in the exact format the code prints (values are samples).
          </p>
        }
      >
        <div className="mt-4 flex flex-wrap gap-1.5">
          <Pill tone="data">From the code</Pill>
          <Pill>Sample values</Pill>
        </div>
        <Toc items={TOC} />
      </TourHeader>
      <div className="divide-y divide-border/70">
        <PipelineChapters />
        <OpsChapters />
        <SecurityChapters />
        <DeliveryChapters />
        <HardeningChapters />
      </div>
    </div>
  );
}
