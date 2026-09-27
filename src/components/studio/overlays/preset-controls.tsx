'use client';

import { useState, type FormEvent } from 'react';
import { BookmarkPlus, Loader2, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Field, NativeSelect } from '../review/field';
import { useAction } from '../review/use-action';
import { styleOf } from './overlay-math';
import { PRESET_GROUPS, type Overlay, type OverlayPreset } from './types';

// Presets (A4.3): pick one when adding an overlay (the < 5-click hook path of A4.1), and save an
// overlay's current style as a business preset.

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
}: {
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
      <Field id="add-overlay-text" label="New overlay text">
        <Input
          id="add-overlay-text"
          value={text}
          maxLength={500}
          disabled={disabled}
          placeholder="Wait for it…"
          onChange={(e) => setText(e.target.value)}
        />
      </Field>
      <Field id="add-overlay-preset" label="Preset">
        <PresetSelect
          id="add-overlay-preset"
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
}: {
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
      <Field id="preset-name" label="Save this style as a preset">
        <Input
          id="preset-name"
          value={name}
          maxLength={80}
          placeholder="Preset name"
          onChange={(e) => setName(e.target.value)}
        />
      </Field>
      <Field id="preset-group" label="Group">
        <NativeSelect id="preset-group" value={group} onChange={(e) => setGroup(e.target.value)}>
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
