import type {
  AgentSession,
  ControlResult,
  HarnessAdapter,
  HarnessCapabilities,
  ListSessionsOptions,
  SendMessageOptions,
  SetPermissionsOptions,
} from "../types/index.js";
import type { ChatGptHarnessDriver, ChatGptHarnessChat } from "../cdp-chat.js";

export const CHATGPT_HARNESS_CWD = "/home/roomhacker/.chatgpt";

/**
 * ChatGPT adapter over Agent Herder's already-owned ChatGPT browser driver.
 * Existing ChatGPT conversations are sessions. The adapter never opens a
 * second browser lease and intentionally does not create chats yet.
 */
export class ChatGptAdapter implements HarnessAdapter {
  readonly type = "chatgpt" as const;
  readonly name = "ChatGPT";
  readonly controlCapabilities: HarnessCapabilities = {
    cancelTurn: false,
    detach: false,
    resume: true,
    terminate: false,
    recover: false,
    fork: false,
    modelSwitch: false,
    subagents: false,
    events: false,
  };
  readonly lazyDiscovery = true;

  constructor(
    private readonly driver: ChatGptHarnessDriver,
    private readonly cwd = CHATGPT_HARNESS_CWD,
  ) {}

  async init(): Promise<void> {
    await this.driver.listChats();
  }

  async listSessions(options: ListSessionsOptions = {}): Promise<AgentSession[]> {
    if (options.cwd && options.cwd !== this.cwd) return [];
    return (await this.driver.listChats()).map((chat) => this.toSession(chat));
  }

  async findNamedSessions(name: string, cwd: string): Promise<AgentSession[]> {
    if (cwd !== this.cwd) return [];
    const normalized = name.trim();
    return (await this.driver.listChats())
      .filter((chat) => chat.title.trim() === normalized)
      .map((chat) => this.toSession(chat));
  }

  async getSession(id: string): Promise<AgentSession | null> {
    const chat = (await this.driver.listChats()).find((entry) => entry.id === id);
    return chat ? this.toSession(chat) : null;
  }

  async sendMessage(id: string, options: SendMessageOptions): Promise<{ ok: boolean; error?: string }> {
    try {
      await this.driver.sendMessage({
        chatId: id,
        text: options.message,
        waitForCompletion: options.queue !== true,
      });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** ChatGPT conversations are already resumable; a message is the resume action. */
  async resumeSession(id: string): Promise<ControlResult> {
    const session = await this.getSession(id);
    return session ? { ok: true, sessionId: id } : { ok: false, error: `ChatGPT chat '${id}' not found` };
  }

  async stopSession(): Promise<ControlResult> {
    return { ok: false, error: "ChatGPT turn cancellation is not exposed through this adapter yet" };
  }

  async respondPermission(): Promise<{ ok: boolean; error?: string }> {
    return { ok: false, error: "ChatGPT does not expose Herder permission prompts" };
  }

  async setPermissions(_sessionId: string, _options: SetPermissionsOptions): Promise<{ ok: boolean; error?: string }> {
    return { ok: false, error: "ChatGPT permissions are controlled by the ChatGPT product surface" };
  }

  private toSession(chat: ChatGptHarnessChat): AgentSession {
    return {
      id: chat.id,
      harness: "chatgpt",
      status: chat.working ? "running" : "idle",
      title: chat.title,
      cwd: this.cwd,
      lastActivity: chat.updatedAt,
      needsPermission: false,
      meta: {
        unread: chat.unread,
        sourceRoute: chat.sourceRoute,
        transport: "browserclaw-owned-page",
        timestampSemantics: chat.updatedAtSemantics ?? "native-or-visible-order",
      },
    };
  }
}
