import type { BridgeAdapter, BridgeResumeSessionCandidate } from "../bridge/bridge-types.ts";
import type { RuntimeHost } from "./runtime-types.ts";

export class LegacyAdapterRuntime implements RuntimeHost {
  readonly runtimeKind = "legacy_adapter" as const;
  private readonly adapter: BridgeAdapter;

  constructor(adapter: BridgeAdapter) {
    this.adapter = adapter;
  }

  setEventSink(sink: Parameters<BridgeAdapter["setEventSink"]>[0]): void {
    this.adapter.setEventSink(sink);
  }

  async start(): Promise<void> {
    await this.adapter.start();
  }

  async sendInput(text: string): Promise<void> {
    await this.adapter.sendInput(text);
  }

  async listResumeSessions(limit?: number): Promise<BridgeResumeSessionCandidate[]> {
    return await this.adapter.listResumeSessions(limit);
  }

  async resumeSession(sessionId: string): Promise<void> {
    await this.adapter.resumeSession(sessionId);
  }

  async createSession(): Promise<void> {
    if (!this.adapter.createSession) {
      throw new Error(`/${this.adapter.getState().kind} does not support creating sessions from WeChat.`);
    }
    await this.adapter.createSession();
  }

  async interrupt(): Promise<boolean> {
    return await this.adapter.interrupt();
  }

  async reset(): Promise<void> {
    await this.adapter.reset();
  }

  async resolveApproval(action: "confirm" | "deny"): Promise<boolean> {
    return await this.adapter.resolveApproval(action);
  }

  async resolveAllApprovals(action: "confirm" | "deny"): Promise<number> {
    return await this.adapter.resolveAllApprovals(action);
  }

  async submitUserInput(answers: Record<string, string[]>): Promise<boolean> {
    return await this.adapter.submitUserInput(answers);
  }

  async dispose(): Promise<void> {
    await this.adapter.dispose();
  }

  getState() {
    return this.adapter.getState();
  }
}
