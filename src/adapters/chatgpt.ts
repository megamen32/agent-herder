import type {
  AgentSession,
  ControlResult,
  CreateSessionOptions,
  HarnessAdapter,
  HarnessCapabilities,
  ListSessionsOptions,
  SendMessageOptions,
  SetPermissionsOptions,
} from "../types/index.js";
import { localSessionHostId } from "../types/index.js";
import type { ChatGptHarnessDriver, ChatGptHarnessChat } from "../cdp-chat.js";

export const CHATGPT_HARNESS_CWD = "/home/roomhacker/.chatgpt";

/**
 * ChatGPT adapter over Agent Herder's already-owned ChatGPT browser driver.
 *
 * Existing ChatGPT conversations are sessions, and the adapter can create one
 * more disposable chat when a session is launched. It never opens a second
 * browser lease: the chat page belongs to the driver.
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
    modelSwitch: true,
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
    void options;
    return (await this.driver.listChats()).map((chat) => this.toSession(chat));
  }

  async findNamedSessions(name: string, cwd: string): Promise<AgentSession[]> {
    void cwd;
    const normalized = name.trim();
    return (await this.driver.listChats())
      .filter((chat) => chat.title.trim() === normalized)
      .map((chat) => this.toSession(chat));
  }

  /** Launch one ChatGPT session: a new disposable chat becomes the session. */
  async createSession(options: CreateSessionOptions): Promise<AgentSession> {
    if (!this.driver.createChat) {
      throw new Error("This ChatGPT driver does not create chats");
    }
    const chat = await this.driver.createChat({ title: options.name });
    return {
      ...this.toSession(chat),
      meta: {
        ...this.toSession(chat).meta,
        ...(options.model ? { model: options.model } : {}),
      },
    };
  }

  /** Models the page's own model picker offers. */
  async listModels(): Promise<string[]> {
    return this.driver.listModels ? this.driver.listModels() : [];
  }

  /** Select one model for one chat through the page's own picker. */
  async changeModel(sessionId: string, model: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.driver.changeModel) {
      return { ok: false, error: "This ChatGPT driver does not expose a model picker" };
    }
    return this.driver.changeModel({ chatId: sessionId, model });
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
      hostId: localSessionHostId(),
      lastActivity: chat.updatedAt,
      needsPermission: false,
      meta: {
        unread: chat.unread,
        sourceRoute: chat.sourceRoute,
        transport: chat.sourceRoute ? "browserclaw-owned-page" : "owned-chat-page",
        timestampSemantics: chat.updatedAtSemantics ?? "native-or-visible-order",
      },
    };
  }
}
