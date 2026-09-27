import { DeliveryChapters } from './system-delivery';
import { OpsChapters } from './system-ops';
import { PipelineChapters } from './system-pipeline';
import { SecurityChapters } from './system-security';
import { Pill, TourHeader, Toc } from './ui';

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
];

export function SystemTour() {
  return (
    <div>
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
      </div>
    </div>
  );
}
