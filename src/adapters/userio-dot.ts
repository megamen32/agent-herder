import { randomUUID } from "node:crypto";
import type { UserIoAgentChannel, UserIoAgentResult } from "./userio-agent-channel.js";

const DOT_URL = /^https:\/\/chatgpt\.com\/dots\/[A-Za-z0-9~_-]+$/u;
const MAX_TEXT = 16_000;
const MAX_ENTITIES = 200;

export type UserIoDotChannel = Pick<UserIoAgentChannel, "call">;
export type DotEntity = Record<string, unknown>;
export type DotMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  [key: string]: unknown;
};
export type DotSnapshot = UserIoAgentResult & {
  ok: true;
  room: string;
  messages: DotMessage[];
  cursor: string;
};
export type DotBinding = { url: string; room: string };
export type DotSendInput = DotBinding & {
  text: string;
  replyTo?: string | null;
  entities?: DotEntity[];
};
export type DotSendResult =
  | { ok: true; status: "confirmed"; message: DotMessage }
  | { ok: false; status: "unknown"; error: "dot_send_outcome_unknown" };

export type UserIoDotClientOptions = {
  wait?: (milliseconds: number) => Promise<void>;
  readbackAttempts?: number;
  readbackDelayMs?: number;
};

function validateBinding({ url, room }: DotBinding): void {
  if (typeof url !== "string" || !DOT_URL.test(url)) throw new Error("invalid_dot_url");
  if (typeof room !== "string" || !room.trim() || room.length > 160 || /\s/u.test(room)) {
    throw new Error("invalid_dot_room");
  }
}

function validateSnapshot(value: UserIoAgentResult, room: string): DotSnapshot {
  if (value.ok !== true || value.room !== room || !Array.isArray(value.messages)
    || typeof value.cursor !== "string" || !value.cursor) {
    throw new Error(typeof value.error === "string" ? value.error : "userio_dot_snapshot_invalid");
  }
  const messages = value.messages.filter((item): item is DotMessage => {
    if (!item || typeof item !== "object") return false;
    const row = item as Record<string, unknown>;
    return typeof row.id === "string" && (row.role === "user" || row.role === "assistant")
      && typeof row.text === "string";
  });
  if (messages.length !== value.messages.length) throw new Error("userio_dot_snapshot_invalid");
  return { ...value, messages } as DotSnapshot;
}

function validateText(text: string): void {
  if (typeof text !== "string" || !text.trim() || text.length > MAX_TEXT) {
    throw new Error("invalid_dot_text");
  }
}

export class UserIoDotClient {
  private readonly wait: (milliseconds: number) => Promise<void>;
  private readonly readbackAttempts: number;
  private readonly readbackDelayMs: number;

  constructor(
    private readonly channel: UserIoDotChannel,
    options: UserIoDotClientOptions = {},
  ) {
    this.wait = options.wait ?? ((milliseconds) => new Promise(resolve => setTimeout(resolve, milliseconds)));
    this.readbackAttempts = options.readbackAttempts ?? 4;
    this.readbackDelayMs = options.readbackDelayMs ?? 1_500;
    if (!Number.isSafeInteger(this.readbackAttempts) || this.readbackAttempts < 1 || this.readbackAttempts > 10) {
      throw new Error("invalid_dot_readback_attempts");
    }
    if (!Number.isSafeInteger(this.readbackDelayMs) || this.readbackDelayMs < 0 || this.readbackDelayMs > 30_000) {
      throw new Error("invalid_dot_readback_delay");
    }
  }

  private async command(binding: DotBinding, action: string, args: Record<string, unknown>): Promise<UserIoAgentResult> {
    validateBinding(binding);
    const probe = await this.channel.call("dot_profile_probe", binding);
    if (probe.ok !== true || probe.matches !== true) throw new Error("userio_dot_profile_mismatch");
    return this.channel.call(action, { ...binding, ...args });
  }

  async snapshot(binding: DotBinding & { after?: string | null }): Promise<DotSnapshot> {
    const { after = null, ...room } = binding;
    const result = await this.command(room, "dot_action", {
      operation: "snapshot",
      after,
    });
    return validateSnapshot(result, room.room);
  }

  async send(input: DotSendInput): Promise<DotSendResult> {
    validateBinding(input);
    validateText(input.text);
    if (input.replyTo !== undefined && input.replyTo !== null && typeof input.replyTo !== "string") {
      throw new Error("invalid_dot_reply");
    }
    if (input.entities !== undefined && (!Array.isArray(input.entities) || input.entities.length > MAX_ENTITIES)) {
      throw new Error("invalid_dot_entities");
    }

    const { text, replyTo = null, entities = [], ...room } = input;
    const before = await this.snapshot(room);
    const backupId = randomUUID();
    let draftBackedUp = false;
    let restoreFailed = false;
    let outcome: DotSendResult = { ok: false, status: "unknown", error: "dot_send_outcome_unknown" };
    try {
      try {
        const backup = await this.command(room, "dot_draft_backup", {
          backup_id: backupId,
          purpose: "automatic",
        });
        if (backup.ok !== true) throw new Error(typeof backup.error === "string" ? backup.error : "dot_draft_backup_failed");
        const cleared = await this.command(room, "dot_draft_recover", {
          backup_id: backupId,
          operation: "clear",
          confirm: "preserve_then_clear",
        });
        if (cleared.ok !== true) throw new Error(typeof cleared.error === "string" ? cleared.error : "dot_draft_clear_failed");
        draftBackedUp = true;
      } catch (error) {
        // An empty composer needs no preservation. Any other failure is a
        // preflight stop: do not click and do not leave an uncertain write.
        if (!(error instanceof Error) || error.message !== "empty_draft") throw error;
      }

      let sendAccepted = false;
      try {
        const result = await this.command(room, "dot_action", {
          operation: "send",
          text,
          reply_to: replyTo,
          entities,
        });
        sendAccepted = result.ok === true;
      } catch {
        // The command may have been accepted before its result was lost. Never
        // turn an uncertain Dot write into a second click.
      }

      if (sendAccepted) {
        for (let attempt = 0; attempt < this.readbackAttempts; attempt += 1) {
          if (attempt > 0) await this.wait(this.readbackDelayMs);
          try {
            const after = await this.snapshot({ ...room, after: before.cursor });
            const matches = after.messages.filter(message => message.role === "user" && message.text === text);
            if (matches.length === 1) {
              outcome = { ok: true, status: "confirmed", message: matches[0] };
              break;
            }
            if (matches.length > 1) break;
          } catch {
            // Readback failure does not authorize a replay of the already-issued
            // mutation; continue the bounded read-only confirmation window.
          }
        }
      }
    } finally {
      if (draftBackedUp) {
        try {
          const restored = await this.command(room, "dot_draft_recover", {
            backup_id: backupId,
            operation: "restore",
            confirm: "restore_preserved_draft",
          });
          restoreFailed = restored.ok !== true;
        } catch {
          restoreFailed = true;
        }
        if (restoreFailed) outcome = { ok: false, status: "unknown", error: "dot_send_outcome_unknown" };
      }
    }
    return outcome;
  }
}
