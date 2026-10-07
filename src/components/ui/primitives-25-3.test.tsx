// @vitest-environment jsdom
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Button } from './button';
import { ChoiceChips } from './choice-chips';
import { ConfirmDialog, useConfirm } from './confirm-dialog';
import { DataTable, sortRows, type DataTableColumn } from './data-table';
import { IconButton } from './icon-button';
import { NativeSelect } from './native-select';
import { nextEnabled } from './roving';
import { SegmentedControl } from './segmented-control';
import { StatusPill } from './status-pill';

// BACKLOG 25.3 — the core component library: behaviour and accessibility of each primitive.

if (typeof window !== 'undefined' && !('ResizeObserver' in window)) {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  Object.defineProperty(window, 'ResizeObserver', { value: ResizeObserverStub, writable: true });
}

describe('Button', () => {
  it('keeps the legacy variant names and maps tertiary/primary to designed variants', () => {
    render(
      <>
        <Button>Default</Button>
        <Button variant="primary">Primary</Button>
        <Button variant="tertiary">Tertiary</Button>
        <Button variant="outline">Outline</Button>
      </>,
    );
    expect(screen.getByRole('button', { name: 'Default' })).toHaveAttribute(
      'data-variant',
      'default',
    );
    expect(screen.getByRole('button', { name: 'Tertiary' }).className).toContain(
      'border-border-strong',
    );
  });

  it('shows a spinner, sets aria-busy and blocks clicks while loading', async () => {
    const onClick = vi.fn();
    render(
      <Button loading onClick={onClick}>
        Save
      </Button>,
    );
    const button = screen.getByRole('button', { name: 'Save' });
    expect(button).toHaveAttribute('aria-busy', 'true');
    expect(button).toBeDisabled();
    expect(button.querySelector('[data-slot="button-spinner"]')).not.toBeNull();
    await userEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe('IconButton', () => {
  it('names the button and shows the label as a tooltip on focus', async () => {
    render(
      <IconButton label="Delete brand kit">
        <svg />
      </IconButton>,
    );
    const button = screen.getByRole('button', { name: 'Delete brand kit' });
    await userEvent.tab();
    expect(button).toHaveFocus();
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Delete brand kit');
  });
});

describe('NativeSelect', () => {
  it('is a labelled native select with the usual value / onChange', async () => {
    const onChange = vi.fn();
    render(
      <>
        <label htmlFor="s">Platform</label>
        <NativeSelect id="s" defaultValue="a" onChange={(e) => onChange(e.target.value)}>
          <option value="a">A</option>
          <option value="b">B</option>
        </NativeSelect>
      </>,
    );
    await userEvent.selectOptions(screen.getByLabelText('Platform'), 'b');
    expect(onChange).toHaveBeenCalledWith('b');
  });
});

describe('StatusPill', () => {
  it('pulses a dot for live work and uses the soft wash for each tone', () => {
    render(
      <>
        <StatusPill tone="live">Generating</StatusPill>
        <StatusPill tone="bad">Failed</StatusPill>
        <StatusPill tone="good" dot>
          Posted
        </StatusPill>
      </>,
    );
    const live = screen.getByText('Generating');
    expect(live.querySelector('[data-slot="status-dot"]')?.className).toContain('animate-rec');
    expect(screen.getByText('Failed').className).toContain('bg-destructive-soft');
    expect(screen.getByText('Failed').querySelector('[data-slot="status-dot"]')).toBeNull();
    expect(screen.getByText('Posted').querySelector('[data-slot="status-dot"]')).not.toBeNull();
  });
});

describe('roving focus', () => {
  it('skips disabled options and wraps round', () => {
    expect(nextEnabled(0, 1, [false, true, false])).toBe(2);
    expect(nextEnabled(2, 1, [false, true, false])).toBe(0);
    expect(nextEnabled(0, -1, [false, false, true])).toBe(1);
    expect(nextEnabled(1, 5, [false, false, true])).toBe(1);
    expect(nextEnabled(0, 0, [])).toBeNull();
  });
});

function SegmentedHarness() {
  const [value, setValue] = useState<'7d' | '30d' | '90d'>('30d');
  return (
    <SegmentedControl
      label="Range"
      value={value}
      onChange={setValue}
      options={[
        { value: '7d', label: '7 days' },
        { value: '30d', label: '30 days' },
        { value: '90d', label: '90 days' },
      ]}
    />
  );
}

describe('SegmentedControl', () => {
  it('is a radiogroup with one tab stop; arrow keys move and select', async () => {
    render(<SegmentedHarness />);
    const group = screen.getByRole('radiogroup', { name: 'Range' });
    const radios = within(group).getAllByRole('radio');
    expect(radios.map((r) => r.tabIndex)).toEqual([-1, 0, -1]);
    await userEvent.tab();
    expect(radios[1]).toHaveFocus();
    await userEvent.keyboard('{ArrowRight}');
    expect(radios[2]).toHaveFocus();
    expect(radios[2]).toHaveAttribute('aria-checked', 'true');
    await userEvent.keyboard('{Home}');
    expect(radios[0]).toHaveAttribute('aria-checked', 'true');
  });
});

function ChipsHarness({ type }: { type: 'single' | 'multiple' }) {
  const [one, setOne] = useState<string | null>(null);
  const [many, setMany] = useState<string[]>(['tiktok']);
  const options = [
    { value: 'tiktok', label: 'TikTok' },
    { value: 'youtube', label: 'YouTube', disabled: true },
    { value: 'instagram', label: 'Instagram' },
  ];
  return type === 'single' ? (
    <ChoiceChips type="single" label="Tone" options={options} value={one} onChange={setOne} />
  ) : (
    <ChoiceChips
      type="multiple"
      label="Platforms"
      options={options}
      value={many}
      onChange={setMany}
    />
  );
}

describe('ChoiceChips', () => {
  it('multiple: checkboxes that toggle, arrow keys move focus past disabled chips', async () => {
    render(<ChipsHarness type="multiple" />);
    const group = screen.getByRole('group', { name: 'Platforms' });
    const boxes = within(group).getAllByRole('checkbox');
    expect(boxes[0]).toHaveAttribute('aria-checked', 'true');
    await userEvent.tab();
    expect(boxes[0]).toHaveFocus();
    await userEvent.keyboard('{ArrowRight}');
    expect(boxes[2]).toHaveFocus();
    expect(boxes[2]).toHaveAttribute('aria-checked', 'false');
    await userEvent.keyboard(' ');
    expect(boxes[2]).toHaveAttribute('aria-checked', 'true');
    await userEvent.click(boxes[0]!);
    expect(boxes[0]).toHaveAttribute('aria-checked', 'false');
  });

  it('single: a radiogroup where arrows select', async () => {
    render(<ChipsHarness type="single" />);
    const radios = within(screen.getByRole('radiogroup', { name: 'Tone' })).getAllByRole('radio');
    await userEvent.click(radios[0]!);
    expect(radios[0]).toHaveAttribute('aria-checked', 'true');
    await userEvent.keyboard('{ArrowRight}');
    expect(radios[2]).toHaveAttribute('aria-checked', 'true');
  });
});

describe('ConfirmDialog', () => {
  it('focuses Cancel for a destructive action and stays open while busy', async () => {
    let resolve: (ok: boolean) => void = () => undefined;
    const onOpenChange = vi.fn();
    render(
      <ConfirmDialog
        open
        onOpenChange={onOpenChange}
        title="Delete this kit?"
        description="It cannot be undone."
        confirmLabel="Delete"
        onConfirm={() => new Promise<boolean>((r) => (resolve = r))}
      />,
    );
    const dialog = await screen.findByRole('alertdialog', { name: 'Delete this kit?' });
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    expect(within(dialog).getByRole('button', { name: 'Delete' })).toHaveAttribute(
      'aria-busy',
      'true',
    );
    resolve(true);
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it('useConfirm resolves true on confirm and false on cancel', async () => {
    const results: boolean[] = [];
    function Harness() {
      const [confirm, dialog] = useConfirm();
      return (
        <>
          <button
            type="button"
            onClick={async () =>
              results.push(await confirm({ title: 'Cancel it?', confirmLabel: 'Yes, cancel' }))
            }
          >
            Go
          </button>
          {dialog}
        </>
      );
    }
    render(<Harness />);
    await userEvent.click(screen.getByRole('button', { name: 'Go' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Yes, cancel' }));
    await waitFor(() => expect(results).toEqual([true]));
    await userEvent.click(screen.getByRole('button', { name: 'Go' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(results).toEqual([true, false]));
  });
});

interface Row {
  id: string;
  name: string;
  spend: number | null;
}
const ROWS: Row[] = [
  { id: 'a', name: 'Beta', spend: 20 },
  { id: 'b', name: 'alpha', spend: null },
  { id: 'c', name: 'Gamma', spend: 5 },
];
const COLUMNS: DataTableColumn<Row>[] = [
  { id: 'name', header: 'Name', cell: (r) => r.name, sortValue: (r) => r.name },
  {
    id: 'spend',
    header: 'Spend',
    cell: (r) => r.spend ?? '—',
    sortValue: (r) => r.spend,
    align: 'end',
  },
];

describe('DataTable', () => {
  it('sortRows orders by value with empty values last in both directions', () => {
    expect(sortRows(ROWS, COLUMNS, { id: 'spend', direction: 'asc' }).map((r) => r.id)).toEqual([
      'c',
      'a',
      'b',
    ]);
    expect(sortRows(ROWS, COLUMNS, { id: 'spend', direction: 'desc' }).map((r) => r.id)).toEqual([
      'a',
      'c',
      'b',
    ]);
    expect(sortRows(ROWS, COLUMNS, null).map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('sorts from the header with aria-sort, selects rows and shows the bulk bar', async () => {
    function Harness() {
      const [ids, setIds] = useState<Set<string>>(new Set());
      return (
        <DataTable
          caption="Organisations"
          columns={COLUMNS}
          rows={ROWS}
          getRowId={(r) => r.id}
          rowLabel={(r) => r.name}
          selectedIds={ids}
          onSelectedIdsChange={setIds}
          bulkActions={(selected) => <button type="button">Archive {selected.length}</button>}
        />
      );
    }
    render(<Harness />);
    const table = screen.getByRole('table', { name: 'Organisations' });
    const nameHeader = within(table).getByRole('columnheader', { name: /Name/ });
    expect(nameHeader).toHaveAttribute('aria-sort', 'none');
    await userEvent.click(within(nameHeader).getByRole('button'));
    expect(nameHeader).toHaveAttribute('aria-sort', 'ascending');
    const firstCell = within(table).getAllByRole('row')[1];
    expect(firstCell).toHaveTextContent('alpha');

    await userEvent.click(screen.getByRole('checkbox', { name: 'Select Gamma' }));
    expect(screen.getByRole('region', { name: 'Actions for the selected rows' })).toHaveTextContent(
      '1 selected',
    );
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select all rows' }));
    expect(screen.getByRole('button', { name: 'Archive 3' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Clear selection' }));
    expect(screen.queryByRole('region', { name: 'Actions for the selected rows' })).toBeNull();
  });

  it('renders loading and empty rows', () => {
    const { rerender } = render(
      <DataTable caption="T" columns={COLUMNS} rows={undefined} getRowId={(r) => r.id} />,
    );
    expect(screen.getByRole('table')).toHaveAttribute('aria-busy', 'true');
    rerender(<DataTable caption="T" columns={COLUMNS} rows={[]} getRowId={(r) => r.id} />);
    expect(screen.getByText('Nothing to show yet.')).toBeInTheDocument();
  });
});
