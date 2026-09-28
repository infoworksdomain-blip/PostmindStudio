import { NotImplementedError } from '../../errors';
import type {
  ProviderAdapter,
  ProviderCapability,
  ProviderPollResult,
  ProviderSubmitResult,
} from './interface';

// BACKLOG 15.W6 — Ideogram as the still-image fallback (spec 6.5 "IMAGE → DALL-E 3 or Ideogram";
// A6.5 / A11.4 "falls back to Ideogram or the closest stock match"). Blocked: there is no Ideogram
// account or key (Ideogram is not in CLAUDE.md's confirmed provider list), so the adapter is a
// contract only. The router lists 'ideogram' last for IMAGE_STILL, but a provider is only ever
// selected when it is REGISTERED, and providers/default-registry.ts never registers this adapter —
// so without an account the router can never pick it. Every method is an honest 501 in case
// anything constructs it anyway, and healthCheck reports unhealthy.
// The buildable half of W6 — falling back to the closest stock match when generation is refused —
// is 15.B5 (Track B). When the account exists: read Ideogram's current API reference and implement
// submit/poll here before registering it (CLAUDE.md rule 2: never invent provider APIs).

export const IDEOGRAM_PENDING_MESSAGE =
  'Ideogram adapter not built: no Ideogram account or API key (15.W6)';

export class IdeogramAdapter implements ProviderAdapter {
  readonly providerId = 'ideogram';
  readonly capabilities: readonly ProviderCapability[] = ['text_to_image'];

  async submit(): Promise<ProviderSubmitResult> {
    throw new NotImplementedError(IDEOGRAM_PENDING_MESSAGE);
  }

  async poll(): Promise<ProviderPollResult> {
    throw new NotImplementedError(IDEOGRAM_PENDING_MESSAGE);
  }

  async cancel(): Promise<void> {
    throw new NotImplementedError(IDEOGRAM_PENDING_MESSAGE);
  }

  async healthCheck(): Promise<{ healthy: boolean; reason?: string }> {
    return { healthy: false, reason: IDEOGRAM_PENDING_MESSAGE };
  }
}
