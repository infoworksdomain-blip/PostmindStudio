// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { VideoModelView } from './generate-body';
import { VideoModelPicker } from './video-model-picker';

const MODELS: VideoModelView[] = [
  {
    providerId: 'seedance',
    displayName: 'Seedance 2.0',
    capabilities: ['text_to_video', 'image_to_video'],
    maxClipSec: 30,
    aspectRatios: ['9:16', '16:9', '1:1'],
    audio: false,
    typicalLatencySec: 120,
    tiers: ['STANDARD'],
    pencePerClip: 69,
    relativeCost: 2,
  },
  {
    providerId: 'kling',
    displayName: 'Kling 3.0',
    capabilities: ['text_to_video'],
    maxClipSec: 15,
    aspectRatios: ['9:16'],
    audio: false,
    typicalLatencySec: 180,
    tiers: ['STANDARD'],
  },
];

const openList = () => userEvent.click(screen.getByRole('button', { name: 'Change model' }));
const current = () => screen.getByTestId('video-model-current');

describe('VideoModelPicker (25.8)', () => {
  it('starts folded on the current choice; unfolded it lists Automatic then the models', async () => {
    render(<VideoModelPicker source="BRIEF" models={MODELS} value={null} onChange={vi.fn()} />);
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
    expect(current()).toHaveTextContent('Automatic (recommended)');
    await openList();
    expect(screen.getByRole('button', { name: 'Hide models' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(screen.getByRole('radiogroup', { name: 'Video model' })).toBeInTheDocument();
    const radios = screen.getAllByRole('radio');
    expect(radios.map((r) => r.getAttribute('aria-labelledby') && r.textContent)).toHaveLength(3);
    expect(screen.getByRole('radio', { name: 'Automatic (recommended)' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Seedance 2.0' })).toHaveAccessibleDescription(
      '2 min a clip · Text or photo · up to 30 s',
    );
    expect(screen.getByRole('radio', { name: 'Kling 3.0' })).toHaveAccessibleDescription(
      '3 min a clip · Text only · up to 15 s',
    );
    // Customers never see a price; there is no audio, camera, motion or resolution control.
    expect(screen.queryByText(/£/)).not.toBeInTheDocument();
    expect(screen.queryByText(/audio|camera|motion|resolution/i)).not.toBeInTheDocument();
    expect(screen.getByText('Makes the AI clips in this video.')).toBeInTheDocument();
  });

  it('shows platform staff the price of a 6 s clip', async () => {
    render(
      <VideoModelPicker
        source="BRIEF"
        models={MODELS}
        value="seedance"
        onChange={vi.fn()}
        showCosts
      />,
    );
    expect(current()).toHaveTextContent('Seedance 2.0');
    expect(current()).toHaveTextContent('£0.69 per 6 s clip');
    await openList();
    expect(screen.getByRole('radio', { name: 'Seedance 2.0' })).toBeChecked();
  });

  it('reports the choice (null for Automatic) by click and arrow keys', async () => {
    const onChange = vi.fn();
    render(<VideoModelPicker source="UGC" models={MODELS} value={null} onChange={onChange} />);
    expect(screen.getByText(/The creator’s own clips always use the creator models/)).toBeVisible();
    await openList();
    await userEvent.click(screen.getByRole('radio', { name: 'Kling 3.0' }));
    expect(onChange).toHaveBeenLastCalledWith('kling');
    screen.getByRole('radio', { name: 'Automatic (recommended)' }).focus();
    await userEvent.keyboard('{ArrowDown}');
    expect(onChange).toHaveBeenLastCalledWith('seedance');
    await userEvent.keyboard('{Home}');
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it('falls back to Automatic for a choice the tier dropped, and says so', async () => {
    render(
      <VideoModelPicker
        source="HOOK_DEMO"
        models={MODELS}
        value="runway"
        onChange={vi.fn()}
        droppedChoice
      />,
    );
    expect(current()).toHaveTextContent('Automatic (recommended)');
    expect(screen.getByText(/isn’t available at this quality tier/)).toBeInTheDocument();
    await openList();
    expect(screen.getByRole('radio', { name: 'Automatic (recommended)' })).toBeChecked();
  });

  it('renders nothing when no model is available', () => {
    const { container } = render(
      <VideoModelPicker source="BRIEF" models={[]} value={null} onChange={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
