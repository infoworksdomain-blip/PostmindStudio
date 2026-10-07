// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fail, mockFetch, ok, renderScreen } from '../publications/test-utils';
import { VoiceKitSelect } from './voice-kit-select';
import { VoiceProfilesPanel } from './voice-profiles-panel';
import type { VoiceProfile } from './voice-types';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
afterEach(() => vi.unstubAllGlobals());

const voice = (overrides: Partial<VoiceProfile> = {}): VoiceProfile => ({
  id: 'vp_1',
  businessId: 'biz_1',
  name: 'Amara (owner)',
  provider: 'elevenlabs',
  state: 'READY',
  isDefault: false,
  speakerName: 'Amara Okafor',
  consentGivenAt: '2026-09-01T10:00:00.000Z',
  sampleCount: 2,
  languagesSupported: ['en'],
  createdAt: '2026-09-01T10:00:00.000Z',
  deletedAt: null,
  ...overrides,
});

const audio = (name: string, size = 2048) =>
  new File([new Uint8Array(size)], name, { type: 'audio/mpeg' });

async function fillCloneForm(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'Clone a voice' }));
  const dialog = await screen.findByRole('dialog');
  await user.type(within(dialog).getByLabelText('Voice name'), 'Amara');
  await user.type(within(dialog).getByLabelText('Speaker name'), 'Amara Okafor');
  await user.upload(
    within(dialog).getByLabelText('Consent recording file'),
    audio('consent.mp3', 1000),
  );
  await user.upload(within(dialog).getByLabelText('Voice samples'), [
    audio('one.mp3'),
    audio('two.mp3'),
  ]);
  await user.click(within(dialog).getByRole('checkbox'));
  return dialog;
}

describe('VoiceProfilesPanel', () => {
  it('lists voices with state badges and explains verification', async () => {
    const api = mockFetch(() =>
      ok({
        data: [voice(), voice({ id: 'vp_2', name: 'Tom', state: 'REQUIRES_VERIFICATION' })],
      }),
    );
    renderScreen(<VoiceProfilesPanel businessId="biz_1" />);
    const list = await screen.findByRole('list', { name: 'Voice profiles' });
    expect(within(list).getByText('Ready')).toBeInTheDocument();
    expect(within(list).getByText('Needs verification')).toBeInTheDocument();
    expect(
      within(list).getByText(
        'ElevenLabs asks for voice verification before this voice can be used.',
      ),
    ).toBeInTheDocument();
    expect(within(list).getByRole('button', { name: 'Preview Amara (owner)' })).toBeInTheDocument();
    expect(within(list).queryByRole('button', { name: 'Preview Tom' })).toBeNull();
    expect(api.requests[0]!.url.searchParams.get('businessId')).toBe('biz_1');
  });

  it('clones a voice with a multipart form carrying consent, recording and samples', async () => {
    const api = mockFetch((req) =>
      req.method === 'POST'
        ? { status: 201, body: { ok: true, voiceProfile: voice() } }
        : ok({ data: [] }),
    );
    const user = userEvent.setup();
    renderScreen(<VoiceProfilesPanel businessId="biz_1" businessName="Leeds Sourdough" />);
    expect(await screen.findByText('No cloned voice yet')).toBeInTheDocument();
    const dialog = await fillCloneForm(user);
    expect(within(dialog).getByLabelText('Consent statement')).toHaveValue(
      'I, Amara Okafor, consent to PostMind Studio creating a synthetic copy of my voice for Leeds Sourdough videos.',
    );
    expect(within(dialog).getByText(/2 of 5 · 4 KB total/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Clone voice' }));

    await waitFor(() => expect(api.find('POST', '/voice-profiles')).toHaveLength(1));
    const form = api.find('POST', '/voice-profiles')[0]!.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get('name')).toBe('Amara');
    expect(form.get('businessId')).toBe('biz_1');
    expect(form.get('speakerName')).toBe('Amara Okafor');
    expect(form.get('consent')).toBe('true');
    expect(form.get('consentStatement')).toMatch(/^I, Amara Okafor, consent/);
    // 17.8: the statement's interface locale and catalogue key are recorded with it.
    expect(form.get('consentStatementLocale')).toBe('en-GB');
    expect(form.get('consentStatementKey')).toBe('business.voice.cloneDialog.consentPhrase');
    expect((form.get('consentRecording') as File).name).toBe('consent.mp3');
    expect(form.getAll('samples').map((f) => (f as File).name)).toEqual(['one.mp3', 'two.mp3']);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('refuses oversized samples and shows the plan error from the server', async () => {
    mockFetch((req) =>
      req.method === 'POST'
        ? fail(403, 'Voice cloning is available on the ENTERPRISE plan', 'forbidden')
        : ok({ data: [] }),
    );
    const user = userEvent.setup();
    renderScreen(<VoiceProfilesPanel businessId="biz_1" />);
    const dialog = await fillCloneForm(user);
    await user.upload(
      within(dialog).getByLabelText('Voice samples'),
      audio('huge.mp3', 10 * 1024 * 1024 + 1),
    );
    expect(within(dialog).getByText('huge.mp3 is larger than 10 MB.')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Clone voice' }));
    expect(
      await within(dialog).findByText(/Voice cloning is available on the ENTERPRISE plan/),
    ).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('keeps Clone voice disabled until consent is ticked', async () => {
    mockFetch(() => ok({ data: [] }));
    const user = userEvent.setup();
    renderScreen(<VoiceProfilesPanel businessId="biz_1" />);
    const dialog = await fillCloneForm(user);
    await user.click(within(dialog).getByRole('checkbox'));
    expect(within(dialog).getByRole('button', { name: 'Clone voice' })).toBeDisabled();
  });

  it('previews a ready voice and plays the returned clip', async () => {
    const api = mockFetch((req) =>
      req.method === 'POST'
        ? ok({ previewUrl: 'https://cdn.test/preview.mp3', expiresInSec: 600 })
        : ok({ data: [voice()] }),
    );
    const user = userEvent.setup();
    renderScreen(<VoiceProfilesPanel businessId="biz_1" />);
    await user.click(await screen.findByRole('button', { name: 'Preview Amara (owner)' }));
    await waitFor(() => expect(api.find('POST', '/voice-profiles/vp_1/preview')).toHaveLength(1));
    expect(api.find('POST', '/voice-profiles/vp_1/preview')[0]!.body).toEqual({
      text: 'Fresh bread every Friday',
    });
    const player = await screen.findByLabelText('Preview of Amara (owner)');
    expect(player).toHaveAttribute('src', 'https://cdn.test/preview.mp3');
  });

  it('deletes a voice only after confirming', async () => {
    const api = mockFetch((req) =>
      req.method === 'DELETE'
        ? ok({ deleted: true, brandKitsUnlinked: 1 })
        : ok({ data: [voice()] }),
    );
    const user = userEvent.setup();
    renderScreen(<VoiceProfilesPanel businessId="biz_1" />);
    await user.click(await screen.findByRole('button', { name: 'Delete Amara (owner)' }));
    const confirm = await screen.findByRole('alertdialog');
    expect(confirm).toHaveTextContent('revoked at ElevenLabs');
    expect(confirm).toHaveTextContent('go back to the stock voice');
    expect(api.find('DELETE', '/voice-profiles/vp_1')).toHaveLength(0);
    await user.click(within(confirm).getByRole('button', { name: 'Delete voice' }));
    await waitFor(() => expect(api.find('DELETE', '/voice-profiles/vp_1')).toHaveLength(1));
  });
});

describe('VoiceKitSelect', () => {
  it('offers the stock voice and ready voices, and PATCHes the kit', async () => {
    const api = mockFetch((req) =>
      req.method === 'PATCH'
        ? ok({ brandKit: {} })
        : ok({
            data: [voice(), voice({ id: 'vp_2', name: 'Tom', state: 'REQUIRES_VERIFICATION' })],
          }),
    );
    const onSaved = vi.fn();
    const user = userEvent.setup();
    renderScreen(
      <VoiceKitSelect
        kit={{ id: 'kit_1', name: 'Main', businessId: 'biz_1', voiceProfileId: null }}
        onSaved={onSaved}
      />,
    );
    const select = screen.getByRole('combobox', { name: 'Voice for Main' });
    await screen.findByRole('option', { name: 'Amara (owner)' });
    expect(screen.queryByRole('option', { name: 'Tom' })).toBeNull();
    expect(select).toHaveValue('');
    await user.selectOptions(select, 'vp_1');
    await waitFor(() => expect(api.find('PATCH', '/brand-kits/kit_1')).toHaveLength(1));
    expect(api.find('PATCH', '/brand-kits/kit_1')[0]!.body).toEqual({ voiceProfileId: 'vp_1' });
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });

  it('switches a kit back to the stock voice with null', async () => {
    const api = mockFetch((req) =>
      req.method === 'PATCH' ? ok({ brandKit: {} }) : ok({ data: [voice()] }),
    );
    const user = userEvent.setup();
    renderScreen(
      <VoiceKitSelect
        kit={{ id: 'kit_1', name: 'Main', businessId: 'biz_1', voiceProfileId: 'vp_1' }}
        onSaved={() => undefined}
      />,
    );
    await screen.findByRole('option', { name: 'Amara (owner)' });
    await user.selectOptions(screen.getByRole('combobox', { name: 'Voice for Main' }), '');
    await waitFor(() => expect(api.find('PATCH', '/brand-kits/kit_1')).toHaveLength(1));
    expect(api.find('PATCH', '/brand-kits/kit_1')[0]!.body).toEqual({ voiceProfileId: null });
  });
});
