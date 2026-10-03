import { describe, expect, it } from 'vitest';
import {
  buildIdeationPrompt,
  DIRECTION_CHOSEN_INSTRUCTION,
  IDEATION_SCHEMA,
  IDEATION_SYSTEM_PROMPT,
} from './ideation';

// BACKLOG 20.18 — ideation picks a direction itself for any named topic, keeps "too vague" for
// empty or meaningless requests, and never asks again once the owner has chosen.

describe('IDEATION_SYSTEM_PROMPT (20.18)', () => {
  it('tells the model to pick a direction itself when the request names a topic', () => {
    expect(IDEATION_SYSTEM_PROMPT).toContain('Be decisive');
    expect(IDEATION_SYSTEM_PROMPT).toContain('"space video"');
    expect(IDEATION_SYSTEM_PROMPT).toContain('"social media automation platform"');
    expect(IDEATION_SYSTEM_PROMPT).toMatch(/pick the best direction for this business yourself/);
  });

  it('reserves actionable=false for empty or meaningless requests without business facts', () => {
    expect(IDEATION_SYSTEM_PROMPT).toMatch(
      /actionable=false only when the request is genuinely empty or meaningless/,
    );
    expect(IDEATION_SYSTEM_PROMPT).toContain('"make a video", "hi", or a single generic word');
    expect(IDEATION_SYSTEM_PROMPT).toContain('no business facts to build on');
    expect(IDEATION_SYSTEM_PROMPT).toContain('exactly three concrete, different directions');
    // The old, strict wording is gone.
    expect(IDEATION_SYSTEM_PROMPT).not.toContain('If the request is too vague to act on');
  });

  it('never asks again once the owner has chosen a direction', () => {
    expect(IDEATION_SYSTEM_PROMPT).toMatch(
      /already chosen a direction, always set actionable=true/,
    );
  });

  it('describes the actionable field the same way in the output schema', () => {
    expect(IDEATION_SCHEMA.properties.actionable.description).toMatch(
      /only if the request is empty/,
    );
  });
});

describe('buildIdeationPrompt (20.18)', () => {
  const base = { rawInput: 'space video', targetPlatforms: ['tiktok'] };

  it('adds the "already chosen" instruction only when the owner chose a direction', () => {
    expect(buildIdeationPrompt({ ...base, directionChosen: true })).toContain(
      DIRECTION_CHOSEN_INSTRUCTION,
    );
    expect(buildIdeationPrompt(base)).not.toContain(DIRECTION_CHOSEN_INSTRUCTION);
    expect(buildIdeationPrompt({ ...base, directionChosen: false })).not.toContain(
      DIRECTION_CHOSEN_INSTRUCTION,
    );
  });

  it('puts the instruction before the fenced owner request', () => {
    const prompt = buildIdeationPrompt({ ...base, directionChosen: true });
    expect(prompt.indexOf(DIRECTION_CHOSEN_INSTRUCTION)).toBeLessThan(
      prompt.indexOf('Owner request:'),
    );
    expect(prompt.endsWith('"""\nspace video\n"""')).toBe(true);
  });

  it('labels the business and the project name separately', () => {
    const prompt = buildIdeationPrompt({
      ...base,
      businessName: 'Orbit Labs',
      projectName: 'Launch teaser',
    });
    expect(prompt).toContain('Business: Orbit Labs');
    expect(prompt).toContain('Project name: Launch teaser');
    expect(buildIdeationPrompt(base)).not.toContain('Project name:');
  });
});
