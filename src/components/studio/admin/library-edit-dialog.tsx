'use client';

import { useState, type FormEvent } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { api, errorMessage, newIdempotencyKey } from '@/lib/client/api';
import { selectClass } from '../library/library-filters';
import { parseTags, type CategoryOption } from '../library/library-utils';
import type { LibraryVideoSummary } from '../library/types';
import type { LibraryPatchBody, LicenseScenario } from './types';

// A3.8 — override a corpus item's metadata, category or licence (PATCH /admin/library/videos/:id).
// Only changed fields are sent; the API rejects an empty patch.

export function buildPatch(
  video: LibraryVideoSummary,
  form: {
    title: string;
    description: string;
    category: string;
    tags: string;
    scenario: string;
    licenseSource: string;
  },
): LibraryPatchBody {
  const patch: LibraryPatchBody = {};
  if (form.title.trim() && form.title.trim() !== video.title) patch.title = form.title.trim();
  const description = form.description.trim() || null;
  if (description !== (video.description ?? null)) patch.description = description;
  if (form.category && form.category !== video.category.slug) patch.category = form.category;
  const tags = parseTags(form.tags);
  if (tags.join(',') !== video.tags.join(',')) patch.tags = tags;
  if (form.scenario) patch.licenseScenario = form.scenario as LicenseScenario;
  if (form.licenseSource.trim()) patch.licenseSource = form.licenseSource.trim();
  return patch;
}

export function LibraryEditDialog({
  video,
  categories,
  onClose,
  onSaved,
}: {
  video: LibraryVideoSummary;
  categories: CategoryOption[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState({
    title: video.title,
    description: video.description ?? '',
    category: video.category.slug,
    tags: video.tags.join(', '),
    scenario: '',
    licenseSource: '',
  });
  const [pending, setPending] = useState(false);
  const patch = buildPatch(video, form);
  const options = categories.some((c) => c.slug === video.category.slug)
    ? categories
    : [{ slug: video.category.slug, label: video.category.name, depth: 0 }, ...categories];
  const dirty = Object.keys(patch).length > 0;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!dirty || pending) return;
    setPending(true);
    try {
      await api(`/admin/library/videos/${video.id}`, {
        method: 'PATCH',
        body: patch,
        idempotencyKey: newIdempotencyKey(),
      });
      toast.success('Library video updated');
      onSaved();
      onClose();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setPending(false);
    }
  };

  const field = (key: keyof typeof form) => ({
    value: form[key],
    onChange: (e: { target: { value: string } }) => setForm({ ...form, [key]: e.target.value }),
  });

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Edit reference</DialogTitle>
            <DialogDescription className="font-mono text-xs">{video.id}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor="edit-title">Title</Label>
            <Input id="edit-title" maxLength={200} {...field('title')} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="edit-description">Description</Label>
            <Textarea id="edit-description" rows={3} maxLength={2000} {...field('description')} />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="edit-category">Category</Label>
              <select id="edit-category" className={selectClass} {...field('category')}>
                {options.map((c) => (
                  <option key={c.slug} value={c.slug}>
                    {`${'  '.repeat(c.depth)}${c.label}`}
                  </option>
                ))}
              </select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="edit-tags">Tags</Label>
              <Input id="edit-tags" {...field('tags')} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="edit-scenario">Licence</Label>
              <select id="edit-scenario" className={selectClass} {...field('scenario')}>
                <option value="">
                  Unchanged ({video.allowedModes.join(' + ') || 'no licence'})
                </option>
                <option value="LICENSED">Licensed</option>
                <option value="OWNED">Owned</option>
                <option value="SCRAPED">Scraped (Inspire only)</option>
                <option value="NOT_REQUIRED">Not required (operator-owned)</option>
              </select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="edit-license-source">Licence source</Label>
              <Input
                id="edit-license-source"
                maxLength={500}
                placeholder="Unchanged"
                {...field('licenseSource')}
              />
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!dirty || pending}>
              {pending && <Loader2 className="animate-spin" />}
              Save changes
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
