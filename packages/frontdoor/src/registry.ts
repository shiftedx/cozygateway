import type { Frame } from "./frames.ts";

export interface AgentLink { send(frame: Frame): void; close(): void; }

export class AgentRegistry {
  #links = new Map<string, AgentLink>();
  #sid = 0;

  attach(householdId: string, link: AgentLink): void {
    this.#links.get(householdId)?.close();
    this.#links.set(householdId, link);
  }

  detach(householdId: string, link: AgentLink): void {
    if (this.#links.get(householdId) === link) this.#links.delete(householdId);
  }

  get(householdId: string): AgentLink | undefined {
    return this.#links.get(householdId);
  }

  nextStreamId(): number {
    return ++this.#sid;
  }
}
