import { randomBytes } from "node:crypto";
import type { ModelProviderConnectionInput } from "cozygateway-contract";

interface Handoff {
  agentId: string;
  expiresAt: number;
  input: ModelProviderConnectionInput;
}

/** A credential crosses authenticated HTTP once; only its opaque reference enters a config request.
 * No storage, trace, status, or WebSocket payload may receive the input held here. */
export class OneTimeProviderHandoffs {
  readonly #pending = new Map<string, Handoff>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) { this.#now = now; }

  create(agentId: string, input: ModelProviderConnectionInput): string {
    this.#expire();
    if (this.#pending.size >= 100) throw new Error("provider_setup_busy");
    const id = randomBytes(32).toString("hex");
    this.#pending.set(id, { agentId, input: structuredClone(input), expiresAt: this.#now() + 30_000 });
    return id;
  }

  consume(agentId: string, id: string): ModelProviderConnectionInput | undefined {
    this.#expire();
    const pending = this.#pending.get(id);
    if (!pending || pending.agentId !== agentId) return undefined;
    this.#pending.delete(id);
    return pending.input;
  }

  revoke(id: string): void { this.#pending.delete(id); }

  #expire(): void {
    const now = this.#now();
    for (const [id, pending] of this.#pending) if (pending.expiresAt <= now) this.#pending.delete(id);
  }
}
