import { describe, expect, it } from 'vitest';
import { createProviderRegistry } from '../providers/registry';
import { StubAdapter } from '../providers/test-adapter';
import { availableTreatments, SCRIPT_SYSTEM_PROMPT } from './scripting';

// 23.2 — presenters are made by actor providers first, so the planner offers AI_AVATAR whenever an
// actor provider (or an avatar provider) is configured, and writes them as creator-style lines.

describe('AI_AVATAR availability and guidance (23.2)', () => {
  it('is offered with only an actor provider (no HeyGen)', () => {
    const registry = createProviderRegistry([new StubAdapter('veo', ['actor_video'])]);
    expect(availableTreatments(registry)).toContain('AI_AVATAR');
  });

  it('is offered with only HeyGen, and not with neither', () => {
    expect(
      availableTreatments(createProviderRegistry([new StubAdapter('heygen', ['avatar_video'])])),
    ).toContain('AI_AVATAR');
    expect(
      availableTreatments(createProviderRegistry([new StubAdapter('runway', ['text_to_video'])])),
    ).not.toContain('AI_AVATAR');
  });

  it('asks for creator-style presenter lines that fit one 4–8 s clip', () => {
    expect(SCRIPT_SYSTEM_PROMPT).toContain('creator-style presenter');
    expect(SCRIPT_SYSTEM_PROMPT).toContain('4 to 8 seconds');
  });
});
