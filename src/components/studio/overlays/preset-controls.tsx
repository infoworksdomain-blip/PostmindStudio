'use client';

import { useState, type FormEvent } from 'react';
import { BookmarkPlus, Loader2, Plus, RefreshCw, Save } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Field, NativeSelect } from '../review/field';
import { useAction } from '../review/use-action';
import { styleOf } from './overlay-math';
import { PRESET_GROUPS, type Overlay, type OverlayPreset } from './types';

// Presets (A4.3): pick one when adding an overlay (the < 5-click hook path of A4.1), and save an
// overlay's current style as a business preset; edit your own presets (13.7).

const groupLabel = (g: string) => g.charAt(0).toUpperCase() + g.slice(1);

export function PresetSelect({
  id,
  presets,
  value,
  onChange,
}: {
  id: string;
  presets: OverlayPreset[];
  value: string;
  onChange: (presetId: string) => void;
}) {
  const groups = [...new Set(presets.map((p) => p.group))];
  return (
    <NativeSelect id={id} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">Default style</option>
      {groups.map((g) => (
        <optgroup key={g} label={groupLabel(g)}>
          {presets
            .filter((p) => p.group === g)
            .map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {p.scope === 'BUILT_IN' ? '' : ' (yours)'}
              </option>
            ))}
        </optgroup>
      ))}
    </NativeSelect>
  );
}

export function AddOverlay({
  presets,
  disabled,
  adding,
  onAdd,
  idPrefix = '',
}: {
  /** Keeps ids unique when several overlay sets share a page (13.3 / 13.4). */
  idPrefix?: string;
  presets: OverlayPreset[];
  disabled: boolean;
  adding: boolean;
  onAdd: (text: string, presetId: string | null) => Promise<boolean>;
}) {
  const [text, setText] = useState('');
  const [presetId, setPresetId] = useState('');

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!text.trim()) return;
    if (await onAdd(text.trim(), presetId || null)) setText('');
  }

  return (
    <form onSubmit={submit} className="grid gap-2 sm:grid-cols-[1fr_12rem_auto] sm:items-end">
      <Field id={`${idPrefix}add-overlay-text`} label="New overlay text">
        <Input
          id={`${idPrefix}add-overlay-text`}
          value={text}
          maxLength={500}
          disabled={disabled}
          placeholder="Wait for it…"
          onChange={(e) => setText(e.target.value)}
        />
      </Field>
      <Field id={`${idPrefix}add-overlay-preset`} label="Preset">
        <PresetSelect
          id={`${idPrefix}add-overlay-preset`}
          presets={presets}
          value={presetId}
          onChange={setPresetId}
        />
      </Field>
      <Button type="submit" disabled={disabled || adding || !text.trim()}>
        {adding ? <Loader2 className="animate-spin" /> : <Plus />} Add at playhead
      </Button>
    </form>
  );
}

export function SavePreset({
  overlay,
  businessId,
  onSaved,
  idPrefix = '',
}: {
  idPrefix?: string;
  overlay: Overlay;
  businessId: string | null;
  onSaved: () => void;
}) {
  const [name, setName] = useState('');
  const [group, setGroup] = useState<string>('hook');
  const { pending, run } = useAction();

  async function save(e: FormEvent) {
    e.preventDefault();
    const ok = await run('preset', '/overlay-presets', {
      body: {
        name: name.trim(),
        group,
        ...(businessId ? { scope: 'business', businessId } : { scope: 'org' }),
        parameters: styleOf(overlay),
      },
      success: 'Preset saved.',
    });
    if (ok) {
      setName('');
      onSaved();
    }
  }

  return (
    <form
      onSubmit={save}
      className="grid grid-cols-[1fr_7rem] gap-2 sm:grid-cols-[1fr_8rem_auto] sm:items-end"
    >
      <Field id={`${idPrefix}preset-name`} label="Save this style as a preset">
        <Input
          id={`${idPrefix}preset-name`}
          value={name}
          maxLength={80}
          placeholder="Preset name"
          onChange={(e) => setName(e.target.value)}
        />
      </Field>
      <Field id={`${idPrefix}preset-group`} label="Group">
        <NativeSelect
          id={`${idPrefix}preset-group`}
          value={group}
          onChange={(e) => setGroup(e.target.value)}
        >
          {PRESET_GROUPS.map((g) => (
            <option key={g} value={g}>
              {groupLabel(g)}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <Button
        type="submit"
        variant="outline"
        className="col-span-2 sm:col-span-1"
        disabled={!name.trim() || pending !== null}
      >
        {pending ? <Loader2 className="animate-spin" /> : <BookmarkPlus />} Save preset
      </Button>
    </form>
  );
}

/**
 * 13.7: edit the organisation's / business's own presets (PATCH /overlay-presets/:id): rename,
 * move group, or replace the style with the selected overlay's. Built-ins are read-only.
 */
export function ManagePresets({
  presets,
  overlay,
  disabled,
  onChanged,
  idPrefix = '',
}: {
  idPrefix?: string;
  presets: OverlayPreset[];
  overlay: Overlay;
  disabled: boolean;
  onChanged: () => void;
}) {
  const own = presets.filter((p) => p.scope !== 'BUILT_IN');
  const [presetId, setPresetId] = useState('');
  const [name, setName] = useState('');
  const [group, setGroup] = useState('');
  const { pending, run } = useAction();
  const preset = own.find((p) => p.id === presetId);

  if (own.length === 0) return null;

  function choose(id: string) {
    setPresetId(id);
    const next = own.find((p) => p.id === id);
    setName(next?.name ?? '');
    setGroup(next?.group ?? '');
  }

  async function update(body: Record<string, unknown>, success: string) {
    if (!preset) return;
    const ok = await run('edit', `/overlay-presets/${preset.id}`, {
      method: 'PATCH',
      body,
      success,
    });
    if (ok) onChanged();
  }

  const renamed = preset && (name.trim() !== preset.name || group !== preset.group);

  return (
    <details className="rounded-lg border border-border px-3 py-2">
      <summary className="cursor-pointer text-sm font-medium">Edit your presets</summary>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <Field id={`${idPrefix}edit-preset`} label="Preset" className="sm:col-span-2">
          <NativeSelect
            id={`${idPrefix}edit-preset`}
            value={presetId}
            onChange={(e) => choose(e.target.value)}
          >
            <option value="">Choose one of your presets</option>
            {own.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({groupLabel(p.group)})
              </option>
            ))}
          </NativeSelect>
        </Field>
        {preset && (
          <>
            <Field id={`${idPrefix}edit-preset-name`} label="Name">
              <Input
                id={`${idPrefix}edit-preset-name`}
                value={name}
                maxLength={80}
                disabled={disabled}
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
            <Field id={`${idPrefix}edit-preset-group`} label="Group">
              <NativeSelect
                id={`${idPrefix}edit-preset-group`}
                value={group}
                disabled={disabled}
                onChange={(e) => setGroup(e.target.value)}
              >
                {PRESET_GROUPS.map((g) => (
                  <option key={g} value={g}>
                    {groupLabel(g)}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <div className="flex flex-wrap gap-2 sm:col-span-2">
              <Button
                size="sm"
                variant="outline"
                disabled={disabled || !renamed || !name.trim() || pending !== null}
                onClick={() => void update({ name: name.trim(), group }, 'Preset renamed.')}
              >
                {pending ? <Loader2 className="animate-spin" /> : <Save />} Save name
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={disabled || pending !== null}
                onClick={() =>
                  void update(
                    { parameters: styleOf(overlay) },
                    `“${preset.name}” now uses this overlay’s style.`,
                  )
                }
              >
                <RefreshCw /> Use this overlay’s style
              </Button>
            </div>
          </>
        )}
      </div>
    </details>
  );
}
