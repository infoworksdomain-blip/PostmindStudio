import { describe, expect, it } from 'vitest';
import {
  isUntitledName,
  projectLabel,
  projectNameParam,
  realProjectName,
  UNTITLED_VIDEO_EN,
} from './project-name';

// BACKLOG 17.9 — "Untitled video" is a rendering fallback, never stored data.

describe('project names', () => {
  it('treats null, blank and the legacy stored English placeholder as untitled', () => {
    expect(isUntitledName(null)).toBe(true);
    expect(isUntitledName(undefined)).toBe(true);
    expect(isUntitledName('  ')).toBe(true);
    expect(isUntitledName('Untitled video')).toBe(true);
    expect(isUntitledName('Spring sale')).toBe(false);
  });

  it('gives English sentences a label and messages an empty parameter', () => {
    expect(projectLabel(null)).toBe(UNTITLED_VIDEO_EN);
    expect(projectLabel(' Spring sale ')).toBe('Spring sale');
    expect(projectNameParam(null)).toBe('');
    expect(projectNameParam('Untitled video')).toBe('');
    expect(projectNameParam('Spring sale')).toBe('Spring sale');
  });

  it('never hands the placeholder to a program (prompts, captions)', () => {
    expect(realProjectName(null)).toBeUndefined();
    expect(realProjectName('Untitled video')).toBeUndefined();
    expect(realProjectName('Spring sale')).toBe('Spring sale');
  });
});
