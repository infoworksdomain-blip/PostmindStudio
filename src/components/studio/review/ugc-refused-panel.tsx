'use client';

import { useTranslations } from 'next-intl';
import { UserX } from 'lucide-react';
import { parseFailure } from '@/lib/client/failure-reasons';
import type { ProjectDetail } from '@/lib/client/types';
import { StudioCapability } from '@/lib/rbac';
import { useCan } from '../use-can';
import {
  BriefEditor,
  GenerateError,
  NeedsInputPanel,
  useAnchorScroll,
  useGenerate,
} from './generate-brief';

// BACKLOG 21.4 — a UGC actor brief that asked for a real person, celebrity or public figure is
// refused before anything is generated (ugc/real-person.ts; DRAFT with errorReason
// ugc_real_person_refused). The owner rewrites the brief here and generates again.

export const UGC_REFUSED_ANCHOR = 'ugc-refused';

export function needsUgcRewrite(project: Pick<ProjectDetail, 'state' | 'errorReason'>): boolean {
  return (
    project.state === 'DRAFT' &&
    parseFailure(project.errorReason)?.code === 'ugc_real_person_refused'
  );
}

export function UgcRefusedPanel({
  project,
  onChanged,
}: {
  project: ProjectDetail;
  onChanged: () => void;
}) {
  const t = useTranslations('review.ugcRefused');
  const mayWrite = useCan(StudioCapability.ProjectWrite);
  const { pending, busy, error, generate } = useGenerate(project.id, onChanged);
  const ref = useAnchorScroll(UGC_REFUSED_ANCHOR);
  return (
    <NeedsInputPanel
      id={UGC_REFUSED_ANCHOR}
      panelRef={ref}
      icon={
        <UserX
          className="mt-0.5 size-5 shrink-0 text-warning-foreground"
          strokeWidth={1.5}
          aria-hidden
        />
      }
      title={t('title')}
      body={t('body')}
    >
      {mayWrite ? (
        <BriefEditor
          initial={project.description ?? ''}
          busy={busy}
          pending={pending === 'edit'}
          onSubmit={(brief) => void generate('edit', { rawInput: brief })}
        />
      ) : (
        <p className="text-sm text-muted-foreground">{t('noPermission')}</p>
      )}
      <GenerateError error={error} />
    </NeedsInputPanel>
  );
}
