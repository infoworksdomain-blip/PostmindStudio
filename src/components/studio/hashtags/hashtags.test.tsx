// @vitest-environment jsdom
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockFetch, renderWithSWR } from '../review/test-helpers';
import { BusinessHashtagsNote, BusinessHashtagsPanel } from './business-hashtags-panel';
import { HashtagEditor } from './hashtag-editor';
import { cleanHashtag, composedLength, moveTag, withLocked } from './model';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
afterEach(() => vi.unstubAllGlobals());

const settings = {
  primaryHashtag: 'AheadAI',
  derivedHashtag: 'AheadAI',
  custom: false,
  alwaysHashtags: ['LeedsEats'],
  minHashtags: 5,
  maxChars: 30,
  maxAlways: 10,
  updatedAt: null,
};

describe('hashtag model (20.13)', () => {
  it('cleans, moves and locks tags; counts like the platform', () => {
    expect(cleanHashtag(' #Bread ')).toBe('Bread');
    expect(cleanHashtag('two words')).toBeNull();
    expect(moveTag(['a', 'b', 'c'], 2, -1)).toEqual(['a', 'c', 'b']);
    expect(moveTag(['a'], 0, -1)).toEqual(['a']);
    expect(withLocked(['b', 'A'], ['a', 'z'])).toEqual(['z', 'b', 'A']);
    expect(composedLength('Hi', ['a', 'b'], false)).toBe('Hi\n\n#a #b'.length);
    expect(composedLength('é', [], true)).toBe(2);
  });
});

function Harness({ locked = ['AheadAI'] }: { locked?: string[] }) {
  const [value, setValue] = useState(['AheadAI', 'bread']);
  return (
    <HashtagEditor
      id="tags"
      label="Hashtags"
      value={value}
      onChange={setValue}
      locked={locked}
      min={5}
      max={5}
    />
  );
}

describe('HashtagEditor', () => {
  it('adds, refuses invalid and duplicate tags, removes and keeps locked tags', async () => {
    renderWithSWR(<Harness />);
    expect(screen.getByText(/2 hashtags \(at least 5, at most 5\)/)).toBeInTheDocument();
    expect(screen.getByText(/still needed: 3/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove #AheadAI' })).not.toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Hashtags'), 'bad-tag{Enter}');
    expect(screen.getByRole('alert')).toHaveTextContent('letters, numbers and _');
    await userEvent.clear(screen.getByLabelText('Hashtags'));
    await userEvent.type(screen.getByLabelText('Hashtags'), 'BREAD{Enter}');
    expect(screen.getByRole('alert')).toHaveTextContent('#BREAD is already in the list');
    await userEvent.clear(screen.getByLabelText('Hashtags'));
    await userEvent.type(screen.getByLabelText('Hashtags'), '#cake buns,');
    expect(screen.getByText('#buns')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Remove #bread' }));
    expect(screen.queryByText('#bread')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Move #cake earlier' }));
    const chips = screen.getAllByRole('listitem').map((li) => li.textContent);
    expect(chips[0]).toContain('#cake');
  });
});

describe('BusinessHashtagsPanel', () => {
  it('shows the derived default and saves the business and always hashtags', async () => {
    const api = mockFetch([
      { match: '/businesses/biz_1/hashtags', body: { hashtags: settings } },
      {
        method: 'PUT',
        match: '/businesses/biz_1/hashtags',
        body: { hashtags: { ...settings, primaryHashtag: 'AheadBakes', custom: true } },
      },
    ]);
    renderWithSWR(<BusinessHashtagsPanel businessId="biz_1" />);
    expect(await screen.findByText(/Leave it empty to use #AheadAI/)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Business hashtag'), 'two words');
    expect(screen.getByRole('alert')).toHaveTextContent('at least one letter');
    expect(screen.getByRole('button', { name: /Save hashtags/ })).toBeDisabled();
    await userEvent.clear(screen.getByLabelText('Business hashtag'));
    await userEvent.type(screen.getByLabelText('Business hashtag'), '#AheadBakes');
    await userEvent.type(screen.getByLabelText('Always include'), 'Autumn2026{Enter}');
    await userEvent.click(screen.getByRole('button', { name: /Save hashtags/ }));
    await waitFor(() => expect(api.find('PUT', '/businesses/biz_1/hashtags')).toHaveLength(1));
    expect(api.find('PUT', '/businesses/biz_1/hashtags')[0]?.body).toEqual({
      primaryHashtag: 'AheadBakes',
      alwaysHashtags: ['LeedsEats', 'Autumn2026'],
    });
  });

  it('the read-only note lists the hashtags every post carries', async () => {
    mockFetch([{ match: '/businesses/biz_1/hashtags', body: { hashtags: settings } }]);
    renderWithSWR(<BusinessHashtagsNote businessId="biz_1" />);
    expect(
      await screen.findByText(
        '#AheadAI #LeedsEats on every post, plus suggestions (at least 5 in all).',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Edit' })).toHaveAttribute(
      'href',
      '/business?tab=hashtags',
    );
  });
});
