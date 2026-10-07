// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { BrandPreview, readableOn } from './brand-preview';

describe('readableOn', () => {
  it('picks the text colour with more contrast, and gives up on a non-hex value', () => {
    expect(readableOn('#FFFFFF')).toBe('#111111');
    expect(readableOn('#1A1A2E')).toBe('#FFFFFF');
    expect(readableOn('tomato')).toBeNull();
  });
});

describe('BrandPreview (25.6)', () => {
  it('shows the picks as one card, in the chosen colour and font', () => {
    render(<BrandPreview palette={['#1A1A2E', '#E94560']} font="Fraunces" tones="Warm, Bold" />);
    const headline = screen.getByText('This is how your videos will look');
    expect(headline).toHaveStyle({ fontFamily: "'Fraunces', ui-sans-serif, system-ui" });
    expect(headline.parentElement).toHaveStyle({ backgroundColor: '#1A1A2E', color: '#FFFFFF' });
    expect(screen.getByText(/Fraunces · Warm, Bold/)).toBeInTheDocument();
  });

  it('says what is still to pick', () => {
    render(<BrandPreview palette={[]} font={null} tones="" />);
    expect(screen.getByText(/Default font · No tone picked yet/)).toBeInTheDocument();
  });
});
