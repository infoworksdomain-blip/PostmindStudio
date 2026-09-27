import type {
  ProviderAdapter,
  ProviderCapability,
  ProviderPollResult,
  ProviderRequest,
  ProviderSubmitResult,
} from './interface';

// A scriptable adapter for router / tracking tests and the offline part of test-router.ts.
// It never pretends to be a real provider: every id it returns is prefixed "stub_".

export class StubAdapter implements ProviderAdapter {
  submitCalls: ProviderRequest[] = [];
  nextSubmit: () => Promise<ProviderSubmitResult>;
  nextPoll: () => Promise<ProviderPollResult>;

  constructor(
    readonly providerId: string,
    readonly capabilities: readonly ProviderCapability[],
    readonly extras: { typicalLatencySec?: number; costPence?: number } = {},
  ) {
    this.nextSubmit = async () => ({
      providerJobId: `stub_${providerId}_${this.submitCalls.length}`,
      estimatedCostPence: extras.costPence ?? 0,
      estimatedReadyAt: new Date(0),
    });
    this.nextPoll = async () => ({
      state: 'succeeded',
      output: { url: 'https://stub.invalid/out', metadata: {} },
    });
  }

  get typicalLatencySec(): number | undefined {
    return this.extras.typicalLatencySec;
  }

  estimateCostPence(): number {
    return this.extras.costPence ?? 0;
  }

  async submit(request: ProviderRequest): Promise<ProviderSubmitResult> {
    this.submitCalls.push(request);
    return this.nextSubmit();
  }

  async poll(): Promise<ProviderPollResult> {
    return this.nextPoll();
  }

  async cancel(): Promise<void> {}

  async healthCheck() {
    return { healthy: true };
  }
}
