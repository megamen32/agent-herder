import { createHash, randomUUID } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";

/**
 * Chat commands of the harness chats: /pilot.
 *
 * The owner talks to the herder from the chat itself — the same window where
 * the agent works. `/pilot` toggles the autopilot of that one session;
 * `/pilot on`, `/pilot off` and `/pilot status` are explicit. The command is
 * executed against the same durable per-session switch the web panel and the
 * autopilot_set tool use — a per-session decision always wins over the
 * harness and the global policy — and the answer is delivered back into the
 * chat as a short automation message, so the new state is visible exactly
 * where the command was typed.
 *
 * The site-chat path is passive: the command is read from the messages of the
 * finished turn the browser turn observer already fetches, so a command costs
 * no request of its own. Every executed command message is remembered in a
 * durable ledger: a re-read of the same history never toggles twice.
 */

/** One chat command. */
export type ChatCommand = { kind: "pilot"; action: "on" | "off" | "status" | "toggle" };

const ON_WORDS = new Set(["on", "вкл", "включить", "включи", "enable", "1", "true"]);
const OFF_WORDS = new Set(["off", "выкл", "выключить", "выключи", "disable", "0", "false"]);
const STATUS_WORDS = new Set(["status", "статус", "состояние", "?"]);

/** Parse the text of one chat message. Only a message that is nothing but the
 * command counts: a command embedded in a longer text stays a message for the
 * agent, and an unknown argument is not a command either. */
export function parseChatCommand(text: string): ChatCommand | null {
  if (typeof text !== "string") return null;
  const match = /^\/(pilot|автопилот|autopilot)(?:\s+([^\s]+))?\s*$/i.exec(text.trim());
  if (!match) return null;
  const argument = (match[2] ?? "").toLowerCase().replace(/\?+$/, "");
  if (!argument) return { kind: "pilot", action: "toggle" };
  if (ON_WORDS.has(argument)) return { kind: "pilot", action: "on" };
  if (OFF_WORDS.has(argument)) return { kind: "pilot", action: "off" };
  if (STATUS_WORDS.has(argument)) return { kind: "pilot", action: "status" };
  return null;
}

/** The durable ledger of executed command messages: the same history is read
 * again after every restart, and a remembered command must never run twice. */
export class ChatCommandLedger {
  private entries: string[] | undefined;

  constructor(
    readonly path: string,
    private readonly cap = 500,
  ) {}

  private load(): string[] {
    if (this.entries) return this.entries;
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as { version?: number; seen?: unknown };
      this.entries = parsed?.version === 1 && Array.isArray(parsed.seen)
        ? parsed.seen.filter((item): item is string => typeof item === "string")
        : [];
    } catch {
      this.entries = [];
    }
    return this.entries;
  }

  has(key: string): boolean {
    return this.load().includes(key);
  }

  mark(key: string): void {
    const seen = this.load();
    if (seen.includes(key)) return;
    seen.push(key);
    while (seen.length > this.cap) seen.shift();
    try {
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      writeFileSync(temporary, JSON.stringify({ version: 1, seen }));
      renameSync(temporary, this.path);
    } catch {
      // The ledger is a fence against a double toggle; a lost write can cost
      // one redundant reply, never a wrong state.
    }
    this.entries = seen;
  }
}

/** Runs the autopilot command of one session: the same runner as the web
 * panel toggle and the autopilot_set tool. */
export type ChatCommandRunner = (input: {
  command: "on" | "off" | "status";
  harness: string;
  sessionId: string;
  cwd?: string;
}) => Promise<Record<string, unknown>>;

/** Delivers the answer of a command back into its chat. */
export type ChatCommandReply = (
  harness: string,
  sessionId: string,
  text: string,
  inputId?: string,
) => Promise<{ ok: boolean; error?: string } | undefined>;

/** What one executed command answers. */
export interface ChatCommandOutcome {
  ok: boolean;
  enabled?: boolean;
  humanStopHeld?: boolean;
  source?: string;
  reason?: string;
  reply: string;
}

/** One message of a chat turn, as the adapters read it. */
export interface ChatCommandMessage {
  id?: string;
  role?: string;
  text?: string;
}

export class ChatCommandPipeline {
  private readonly ledger: ChatCommandLedger;

  constructor(private readonly options: {
    run: ChatCommandRunner;
    reply: ChatCommandReply;
    ledgerPath: string;
    onError?: (message: string) => void;
  }) {
    this.ledger = new ChatCommandLedger(options.ledgerPath);
  }

  /** A turn of a browser chat has finished; if its newest user message is a
   * new command, execute it and answer in the chat. Returns true when a
   * command ran: the Stop of that turn is the command exchange, not work, so
   * the caller skips the autopilot submission of it. */
  async handleTurnMessages(
    harness: string,
    sessionId: string,
    cwd: string,
    messages: ReadonlyArray<ChatCommandMessage>,
  ): Promise<boolean> {
    let newestUser: ChatCommandMessage | undefined;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message?.role === "user") {
        newestUser = message;
        break;
      }
    }
    if (!newestUser || typeof newestUser.text !== "string") return false;
    const command = parseChatCommand(newestUser.text);
    if (!command) return false;
    const messageId = typeof newestUser.id === "string" ? newestUser.id.trim() : "";
    // Without a message id there is no honest dedupe: the same text typed
    // again would toggle again, so the turn path leaves it to the web panel.
    if (!messageId) return false;
    const key = `${harness}:${sessionId}:${messageId}`;
    if (this.ledger.has(key)) return false;
    const replyInputId = `pilot-${createHash("sha256").update(key).digest("hex").slice(0, 12)}`;
    await this.execute(command, harness, sessionId, cwd, replyInputId);
    this.ledger.mark(key);
    return true;
  }

  /** A command from the herder's own composer: it runs at once, and its
   * answer is both returned to the caller and delivered into the chat. */
  async handleDirect(command: ChatCommand, harness: string, sessionId: string, cwd?: string): Promise<ChatCommandOutcome> {
    return await this.execute(command, harness, sessionId, cwd);
  }

  private async execute(
    command: ChatCommand,
    harness: string,
    sessionId: string,
    cwd?: string,
    replyInputId?: string,
  ): Promise<ChatCommandOutcome> {
    try {
      if (command.action === "status") {
        const status = await this.options.run({ command: "status", harness, sessionId, cwd });
        if (status.ok !== true) {
          return await this.answer(harness, sessionId, replyInputId,
            `[Agent Herder] Не удалось прочитать состояние автопилота: ${this.reasonOf(status)}.`,
            { ok: false, reason: this.reasonOf(status) });
        }
        const enabled = status.enabled === true;
        const source = typeof status.source === "string" ? status.source : undefined;
        const held = status.human_stop_held === true;
        const reply = `[Agent Herder] Автопилот этой сессии: ${enabled ? "включён" : "выключен"}`
          + `${source ? ` (решает ${this.sourceText(source)})` : ""}.${held
            ? " Действует явная остановка человека: автопилот продолжится только после возобновления работы."
            : ""} Команды: /pilot — переключить, /pilot on, /pilot off, /pilot status.`;
        return await this.answer(harness, sessionId, replyInputId, reply,
          { ok: true, enabled, humanStopHeld: held, ...(source ? { source } : {}) });
      }
      let action: "on" | "off";
      if (command.action === "toggle") {
        const status = await this.options.run({ command: "status", harness, sessionId, cwd });
        if (status.ok !== true) {
          return await this.answer(harness, sessionId, replyInputId,
            `[Agent Herder] Команда /pilot не выполнена: ${this.reasonOf(status)}.`,
            { ok: false, reason: this.reasonOf(status) });
        }
        action = status.enabled === true ? "off" : "on";
      } else {
        action = command.action;
      }
      const result = await this.options.run({ command: action, harness, sessionId, cwd });
      if (result.ok !== true) {
        return await this.answer(harness, sessionId, replyInputId,
          `[Agent Herder] Команда /pilot не выполнена: ${this.reasonOf(result)}.`,
          { ok: false, reason: this.reasonOf(result) });
      }
      if (action === "on" && result.human_stop_held === true) {
        return await this.answer(harness, sessionId, replyInputId,
          "[Agent Herder] Автопилот не включён: в этой сессии действует явная остановка человека. Сначала возобновите работу, затем повторите /pilot on.",
          { ok: true, enabled: false, humanStopHeld: true });
      }
      const enabled = result.enabled === true;
      const reply = enabled
        ? "[Agent Herder] Автопилот этой сессии включён: законченные ходы оцениваются, незаконченная цель продолжается автоматически. Выключить: /pilot off."
        : "[Agent Herder] Автопилот этой сессии выключен. Включить: /pilot on.";
      return await this.answer(harness, sessionId, replyInputId, reply,
        { ok: true, enabled, ...(typeof result.source === "string" ? { source: result.source } : {}) });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return await this.answer(harness, sessionId, replyInputId,
        `[Agent Herder] Команда /pilot не выполнена: ${reason}.`,
        { ok: false, reason });
    }
  }

  private reasonOf(result: Record<string, unknown>): string {
    const reason = result.reason ?? result.error;
    return typeof reason === "string" && reason.trim() ? reason.trim() : "неизвестная причина";
  }

  private sourceText(source: string): string {
    if (source === "session") return "настройка этой сессии";
    if (source === "goal-session") return "цель этой сессии";
    if (source === "policy") return "общая настройка автопилота";
    if (source === "plugin-default") return "настройка среды";
    return source;
  }

  private async answer(
    harness: string,
    sessionId: string,
    inputId: string | undefined,
    reply: string,
    outcome: Omit<ChatCommandOutcome, "reply">,
  ): Promise<ChatCommandOutcome> {
    try {
      const delivered = await this.options.reply(harness, sessionId, reply, inputId);
      if (delivered && delivered.ok === false) {
        this.options.onError?.(`chat command reply refused for ${harness}/${sessionId}: ${delivered.error ?? "unknown refusal"}`);
      }
    } catch (error) {
      this.options.onError?.(`chat command reply failed for ${harness}/${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
    }
    return { ...outcome, reply };
  }
}
