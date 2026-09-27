import type {
  ProviderAdapter,
  ProviderCapability,
  ProviderPollResult,
  ProviderRequest,
  ProviderSubmitResult,
} from '../../src/lib/studio/providers/interface';

// A test double whose result is computed from each request. Every id is prefixed "scripted_"
// so it can never be mistaken for a real provider response.

export type Responder = (
  request: ProviderRequest,
) => ProviderPollResult | Promise<ProviderPollResult>;

export class ScriptedAdapter implements ProviderAdapter {
  readonly requests: ProviderRequest[] = [];
  private readonly results = new Map<string, ProviderPollResult>();
  /** Polls that report "running" before the parked result is released. */
  pollsBeforeDone = 0;
  private polls = new Map<string, number>();

  constructor(
    readonly providerId: string,
    readonly capabilities: readonly ProviderCapability[],
    public respond: Responder,
    readonly costPence = 1,
  ) {}

  estimateCostPence(): number {
    return this.costPence;
  }

  async submit(request: ProviderRequest): Promise<ProviderSubmitResult> {
    this.requests.push(request);
    const id = `scripted_${this.providerId}_${this.requests.length}`;
    this.results.set(id, await this.respond(request));
    return { providerJobId: id, estimatedCostPence: this.costPence, estimatedReadyAt: new Date(0) };
  }

  async poll(providerJobId: string): Promise<ProviderPollResult> {
    const seen = this.polls.get(providerJobId) ?? 0;
    this.polls.set(providerJobId, seen + 1);
    if (seen < this.pollsBeforeDone) return { state: 'running' };
    return (
      this.results.get(providerJobId) ?? {
        state: 'failed',
        error: { class: 'result_expired', message: 'unknown id', retryable: true },
      }
    );
  }

  async cancel(providerJobId: string): Promise<void> {
    this.results.delete(providerJobId);
  }

  async healthCheck() {
    return { healthy: true };
  }
}
