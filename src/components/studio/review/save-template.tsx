'use client';

import { useState } from 'react';
import { LayoutTemplate, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Field } from './field';
import { useAction } from './use-action';

// "Save as template" (spec 8.6 POST /templates): the project's formats, shot structure and
// publish defaults become a reusable template. Scripts are needed, so it appears once planned.

const CATEGORY = /^[a-z0-9_]{1,60}$/;

export function SaveTemplate({
  projectId,
  defaultName,
}: {
  projectId: string;
  defaultName: string;
}) {
  const { pending, run, busy } = useAction();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(defaultName.slice(0, 120));
  const [category, setCategory] = useState('custom');
  const categoryOk = CATEGORY.test(category);

  async function save() {
    const ok = await run('save', '/templates', {
      body: { projectId, name: name.trim(), category },
      success: 'Saved as a template — pick it on the Create screen.',
    });
    if (ok) setOpen(false);
  }

  if (!open)
    return (
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <LayoutTemplate /> Save as template
      </Button>
    );
  return (
    <div className="flex flex-col gap-3" role="group" aria-label="Save as template">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field id="template-name" label="Template name">
          <Input
            id="template-name"
            value={name}
            maxLength={120}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field
          id="template-category"
          label="Category"
          hint={categoryOk ? undefined : 'Lowercase letters, digits and _ only.'}
        >
          <Input
            id="template-category"
            value={category}
            maxLength={60}
            aria-invalid={!categoryOk}
            onChange={(e) => setCategory(e.target.value)}
          />
        </Field>
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
          Cancel
        </Button>
        <Button onClick={save} disabled={busy || !name.trim() || !categoryOk}>
          {pending && <Loader2 className="animate-spin" />} Save template
        </Button>
      </div>
    </div>
  );
}
