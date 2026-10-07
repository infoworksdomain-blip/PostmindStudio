'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
  Archive,
  ArchiveRestore,
  Copy,
  Download,
  LayoutTemplate,
  MoreHorizontal,
  Share2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { api, newIdempotencyKey, useErrorMessage } from '@/lib/client/api';
import { ACTIVE_STATES } from '@/lib/client/format';
import type { ProjectDetail, Render } from '@/lib/client/types';
import { StudioCapability } from '@/lib/rbac';
import { ShareLinksPanel } from '../share/share-links-panel';
import { useCan } from '../use-can';
import { canSaveTemplate } from './automation-panel';
import { SaveTemplate } from './save-template';
import type { SignedUrl } from './types';

// BACKLOG 25.8 — the review screen's secondary actions in one menu: download the variant in the
// player, share for feedback, save as template, duplicate, archive. Each calls the same endpoint
// it always did (the projects list's row menu, the variant card's download, 15.E5 share links,
// spec 8.6 templates); sharing and saving a template open in a dialog.

type Dialogs = 'share' | 'template' | null;

export function ProjectMenu({
  project,
  selected,
  projectName,
  onChanged,
}: {
  project: ProjectDetail;
  /** The variant in the player (what Download downloads). */
  selected: Render | null;
  projectName: string;
  onChanged: () => void;
}) {
  const t = useTranslations('review.menu');
  const tl = useTranslations('projects.list.actions');
  const ts = useTranslations('review.saveTemplate');
  const tsh = useTranslations('share.links');
  const errorMessage = useErrorMessage();
  const router = useRouter();
  const mayWrite = useCan(StudioCapability.ProjectWrite);
  const [dialog, setDialog] = useState<Dialogs>(null);
  const isCarousel = project.sourceType === 'CAROUSEL';
  const archived = project.state === 'ARCHIVED';
  // The API refuses to archive a run in progress ("cancel generation first").
  const running = ACTIVE_STATES.has(project.state);
  const canShare = project.renders.length > 0 && !isCarousel;
  const canTemplate = mayWrite && canSaveTemplate(project);

  async function download() {
    if (!selected) return;
    try {
      const { url } = await api<SignedUrl>(`/renders/${selected.id}/download`);
      window.open(url, '_blank', 'noopener');
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  async function duplicate() {
    try {
      const res = await api<{ project: { id: string } }>(`/projects/${project.id}/duplicate`, {
        method: 'POST',
        idempotencyKey: newIdempotencyKey(),
      });
      toast.success(tl('done.duplicate'));
      router.push(`/projects/${res.project.id}`);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  async function archive(action: 'archive' | 'unarchive') {
    try {
      await api(`/projects/${project.id}/${action}`, {
        method: 'POST',
        idempotencyKey: newIdempotencyKey(),
      });
      toast.success(tl(`done.${action}`));
      onChanged();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  if (!selected && !canShare && !mayWrite) return null;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="icon-sm" aria-label={t('trigger', { name: projectName })}>
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-52">
          {selected && (
            <DropdownMenuItem onSelect={() => void download()}>
              <Download /> {t('download')}
            </DropdownMenuItem>
          )}
          {canShare && (
            <DropdownMenuItem onSelect={() => setDialog('share')}>
              <Share2 /> {tsh('title')}
            </DropdownMenuItem>
          )}
          {canTemplate && (
            <DropdownMenuItem onSelect={() => setDialog('template')}>
              <LayoutTemplate /> {ts('open')}
            </DropdownMenuItem>
          )}
          {mayWrite && (selected || canShare || canTemplate) && <DropdownMenuSeparator />}
          {mayWrite && (
            <DropdownMenuItem onSelect={() => void duplicate()}>
              <Copy /> {tl('duplicate')}
            </DropdownMenuItem>
          )}
          {mayWrite &&
            (archived ? (
              <DropdownMenuItem onSelect={() => void archive('unarchive')}>
                <ArchiveRestore /> {tl('unarchive')}
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem disabled={running} onSelect={() => void archive('archive')}>
                <Archive /> {tl('archive')}
              </DropdownMenuItem>
            ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={dialog === 'share'} onOpenChange={(open) => !open && setDialog(null)}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
          {/* The panel shows the visible title and description; the dialog names itself the same. */}
          <DialogHeader className="sr-only">
            <DialogTitle>{tsh('title')}</DialogTitle>
            <DialogDescription>{tsh('description')}</DialogDescription>
          </DialogHeader>
          {dialog === 'share' && (
            <ShareLinksPanel projectId={project.id} className="border-t-0 pt-0" />
          )}
        </DialogContent>
      </Dialog>
      <Dialog open={dialog === 'template'} onOpenChange={(open) => !open && setDialog(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{ts('open')}</DialogTitle>
            <DialogDescription>{t('templateDescription')}</DialogDescription>
          </DialogHeader>
          {dialog === 'template' && (
            <SaveTemplate
              projectId={project.id}
              defaultName={project.name ?? ''}
              defaultOpen
              onDone={() => setDialog(null)}
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
