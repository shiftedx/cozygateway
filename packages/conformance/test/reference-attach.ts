import { once } from "node:events";

import { WebSocket } from "ws";
import { startGateway, type RunningGateway } from "cozygateway";

import { startFakeHermesServer, type FakeHermesServer } from "../../gateway/test/support/fake-hermes-server.ts";

type PeerKind = "echo" | "stall" | "approval";

interface Command {
  kind: string;
  threadId: string;
  turnId: string;
  messageId?: string;
  text?: string;
  approvalId?: string;
  decision?: "approve" | "deny";
}

interface CommandFrame {
  kind: "command";
  sequence: number;
  commandId: string;
  command: Command;
}

class AttachPeer {
  #socket: WebSocket | undefined;
  #eventSequence = 0;
  #pending = new Map<string, Command>();
  readonly #gateway: () => RunningGateway;
  readonly #token: string;
  readonly #kind: PeerKind;

  constructor(gateway: () => RunningGateway, token: string, kind: PeerKind) {
    this.#gateway = gateway;
    this.#token = token;
    this.#kind = kind;
  }

  async connect(): Promise<void> {
    const socket = new WebSocket(`${this.#gateway().url.replace("http", "ws")}/attach/v1`, {
      headers: { authorization: `Bearer ${this.#token}` },
    });
    this.#socket = socket;
    socket.on("message", (data) => this.#onMessage(JSON.parse(String(data)) as CommandFrame));
    await once(socket, "open");
    socket.send(JSON.stringify({
      kind: "hello",
      version: 1,
      instanceId: `conformance-${this.#kind}`,
      capabilities: ["draft", "approvals"],
      resume: { eventSequence: 0, commandSequence: 0 },
    }));
  }

  close(): void {
    const socket = this.#socket;
    if (socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) socket.close();
  }

  #onMessage(frame: CommandFrame): void {
    if (frame.kind !== "command") return;
    this.#socket?.send(JSON.stringify({ kind: "ack", channel: "command", sequence: frame.sequence, id: frame.commandId }));
    const command = frame.command;
    if (command.kind === "turn") this.#turn(command);
    else if (command.kind === "resolve_approval") this.#resolveApproval(command);
  }

  #turn(command: Command): void {
    if (this.#kind === "echo") {
      if (command.text?.includes("[[fail]]") === true) {
        this.#event({ kind: "failed", threadId: command.threadId, turnId: command.turnId, messageId: `failed:${command.turnId}`, message: "reference failure" });
        return;
      }
      // The attach adapter projects the final commit as the second draft, preserving the frozen
      // reference-echo contract of exactly two drafts without a special production adapter.
      this.#event({ kind: "draft", threadId: command.threadId, turnId: command.turnId, blocks: [{ type: "paragraph", text: "Echo:" }] });
      this.#event({ kind: "commit", threadId: command.threadId, turnId: command.turnId, messageId: `answer:${command.messageId ?? command.turnId}`, blocks: [{ type: "paragraph", text: `Echo: ${command.text ?? ""}` }] });
      return;
    }
    this.#event({ kind: "draft", threadId: command.threadId, turnId: command.turnId, blocks: [{ type: "paragraph", text: "Working…" }] });
    if (this.#kind === "approval") {
      this.#pending.set(command.turnId, command);
      this.#event({ kind: "approval", threadId: command.threadId, turnId: command.turnId, approvalId: `approval:${command.turnId}`, callId: `call:${command.turnId}`, name: "reference tool", status: "pending" });
    }
  }

  #resolveApproval(command: Command): void {
    const pending = this.#pending.get(command.turnId);
    if (pending === undefined || command.approvalId === undefined || command.decision === undefined) return;
    this.#pending.delete(command.turnId);
    this.#event({ kind: "approval", threadId: command.threadId, turnId: command.turnId, approvalId: command.approvalId, callId: `call:${command.turnId}`, name: "reference tool", status: command.decision === "approve" ? "approved" : "denied" });
    this.#event({ kind: "commit", threadId: command.threadId, turnId: command.turnId, messageId: `answer:${command.turnId}`, blocks: [{ type: "paragraph", text: command.decision === "approve" ? "Approved." : "Denied." }] });
  }

  #event(event: Record<string, unknown>): void {
    this.#eventSequence += 1;
    this.#socket?.send(JSON.stringify({ kind: "event", sequence: this.#eventSequence, eventId: `${this.#kind}:${this.#eventSequence}`, event }));
  }
}

export class ReferenceAttachGateway {
  gateway: RunningGateway | undefined;
  #hermes: FakeHermesServer | undefined;
  #peers: AttachPeer[] = [];
  readonly #withHooks: boolean;
  readonly #notifierLog: (line: string) => void;

  constructor(withHooks: boolean, notifierLog: (line: string) => void) {
    this.#withHooks = withHooks;
    this.#notifierLog = notifierLog;
  }

  async start(): Promise<RunningGateway> {
    process.env.CONFORMANCE_CONTROL_TOKEN = "control-secret";
    process.env.CONFORMANCE_ECHO_TOKEN = "echo-secret";
    if (this.#withHooks) {
      process.env.CONFORMANCE_STALL_TOKEN = "stall-secret";
      process.env.CONFORMANCE_APPROVAL_TOKEN = "approval-secret";
    }
    this.#hermes = await startFakeHermesServer({ methods: { "profiles.list": () => ({ profiles: [], bot_mode_protocol: true }) } });
    const profiles: Record<string, { tokenEnv: string; name: string }> = {
      "conformance-echo": { tokenEnv: "CONFORMANCE_ECHO_TOKEN", name: "Echo" },
    };
    if (this.#withHooks) {
      profiles["conformance-stall"] = { tokenEnv: "CONFORMANCE_STALL_TOKEN", name: "Stall" };
      profiles["conformance-approval"] = { tokenEnv: "CONFORMANCE_APPROVAL_TOKEN", name: "Approval" };
    }
    this.gateway = await startGateway({
      name: this.#withHooks ? "conformance-reference" : "conformance-reference-hookless",
      port: 0,
      dbPath: ":memory:",
      turnTimeoutSeconds: 0,
      capabilities: this.#withHooks ? { "com.cozylabs.test": 1 } : undefined,
      hermes: { url: this.#hermes.url, tokenEnv: "CONFORMANCE_CONTROL_TOKEN", profiles },
    }, { notifierLog: this.#notifierLog });
    this.#peers = [
      new AttachPeer(() => this.requireGateway(), "echo-secret", "echo"),
      ...(this.#withHooks ? [
        new AttachPeer(() => this.requireGateway(), "stall-secret", "stall"),
        new AttachPeer(() => this.requireGateway(), "approval-secret", "approval"),
      ] : []),
    ];
    await Promise.all(this.#peers.map((peer) => peer.connect()));
    return this.requireGateway();
  }

  async close(): Promise<void> {
    for (const peer of this.#peers) peer.close();
    await this.gateway?.close();
    await this.#hermes?.close();
    this.gateway = undefined;
    this.#hermes = undefined;
    this.#peers = [];
    delete process.env.CONFORMANCE_CONTROL_TOKEN;
    delete process.env.CONFORMANCE_ECHO_TOKEN;
    delete process.env.CONFORMANCE_STALL_TOKEN;
    delete process.env.CONFORMANCE_APPROVAL_TOKEN;
  }

  private requireGateway(): RunningGateway {
    if (this.gateway === undefined) throw new Error("reference gateway has not started");
    return this.gateway;
  }
}
