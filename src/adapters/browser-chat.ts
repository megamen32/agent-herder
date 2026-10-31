import type { AgentSession, ControlResult, CreateSessionOptions, HarnessAdapter, HarnessCapabilities, HarnessType, ListSessionsOptions, SendMessageOptions, SetPermissionsOptions } from "../types/index.js";
import { localSessionHostId } from "../types/index.js";
/** Normalized browser chat; native IDs belong to their provider driver. */
export interface BrowserChat {
  id: string;
  title: string;
  unread: boolean;
  working: boolean;
  updatedAt: string;
  sourceRoute?: string;
  updatedAtSemantics?: string;
  providerId?: string;
  cwd?: string;
}

/** A browser transport owns its authenticated page and implements these operations. */
export interface BrowserChatDriver {
  listChats(signal?: AbortSignal): Promise<readonly BrowserChat[]>;
  getChat?(chatId: string, signal?: AbortSignal): Promise<BrowserChat | null>;
  sendMessage(
    input: { chatId: string; text: string; waitForCompletion?: boolean },
    signal?: AbortSignal,
  ): Promise<{ assistantText?: string }>;
  createChat?(input: { title?: string }, signal?: AbortSignal): Promise<BrowserChat>;
  listModels?(signal?: AbortSignal): Promise<string[]>;
  changeModel?(input: { chatId: string; model: string }, signal?: AbortSignal): Promise<{ ok: boolean; error?: string }>;
}
export interface BrowserChatProvider { id: string; name: string; harness: HarnessType; cwd: string }


/**
 * One HarnessAdapter for a browser-owned conversation provider.
 *
 * Keeps authentication, Chrome profile, selectors and page leases in the
 * provider driver. Never starts an independent browser or silently creates
 * a chat while trying to resume an existing one.
 */
export class BrowserChatAdapter implements HarnessAdapter {
  readonly type: HarnessType;
  readonly name: string;
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
    private readonly driver: BrowserChatDriver,
    private readonly provider: BrowserChatProvider,
    private readonly cwd = provider.cwd,
  ) { this.type = provider.harness; this.name = provider.name; }

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
    const chat = this.driver.getChat
      ? await this.driver.getChat(id)
      : (await this.driver.listChats()).find((entry) => entry.id === id);
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

  private toSession(chat: BrowserChat): AgentSession {
    return {
      id: chat.id,
      harness: this.type,
      status: chat.working ? "running" : "idle",
      title: chat.title,
      cwd: chat.cwd ?? this.cwd,
      hostId: localSessionHostId(),
      lastActivity: chat.updatedAt,
      needsPermission: false,
      meta: {
        unread: chat.unread,
        sourceRoute: chat.sourceRoute,
        transport: chat.sourceRoute ? "browser-owned-page" : "owned-chat-page",
        browserProvider: chat.providerId ?? this.provider.id,
        timestampSemantics: chat.updatedAtSemantics ?? "native-or-visible-order",
      },
    };
  }
}
