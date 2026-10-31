import type { BrowserChat, BrowserChatDriver } from "./browser-chat.js";

export interface BrowserChatEndpoint {
  /** Stable provider key, independent of the title or site URL. */
  id: string;
  name: string;
  cwd: string;
  driver: BrowserChatDriver;
}
export interface BrowserProviderState { id: string; available: boolean; error?: string }

/**
 * Provider-neutral driver multiplexing independent authenticated browser owners.
 * A message is always routed to the named provider and exact native chat ID;
 * it can never fall back to another provider or silently create a new chat.
 */
export class BrowserChatRouter implements BrowserChatDriver {
  private readonly providers = new Map<string, BrowserChatEndpoint>();
  private readonly states = new Map<string, BrowserProviderState>();

  constructor(providers: readonly BrowserChatEndpoint[]) {
    if (!providers.length) throw new Error("Browser chat router needs at least one provider");
    for (const provider of providers) {
      if (!/^[a-z][a-z0-9-]{0,47}$/.test(provider.id)) throw new Error("Invalid browser provider ID");
      if (!provider.cwd.startsWith("/")) throw new Error(`Provider '${provider.id}' requires an absolute CWD`);
      if (this.providers.has(provider.id)) throw new Error(`Duplicate browser provider '${provider.id}'`);
      this.providers.set(provider.id, provider);
      this.states.set(provider.id, { id: provider.id, available: false });
    }
  }

  static scopedId(providerId: string, nativeChatId: string): string {
    if (!nativeChatId) throw new Error("Empty native browser chat ID");
    return `${providerId}::${encodeURIComponent(nativeChatId)}`;
  }

  private resolve(scopedId: string): { provider: BrowserChatEndpoint; nativeId: string } {
    const at = scopedId.indexOf("::");
    if (at <= 0) throw new Error("Expected provider-scoped browser chat ID");
    const provider = this.providers.get(scopedId.slice(0, at));
    if (!provider) throw new Error("Unknown browser chat provider");
    let nativeId: string;
    try { nativeId = decodeURIComponent(scopedId.slice(at + 2)); }
    catch { throw new Error("Invalid encoded browser chat ID"); }
    if (!nativeId) throw new Error("Empty native browser chat ID");
    return { provider, nativeId };
  }

  private scoped(provider: BrowserChatEndpoint, chat: BrowserChat): BrowserChat {
    return { ...chat, id: BrowserChatRouter.scopedId(provider.id, chat.id),
      providerId: provider.id, cwd: provider.cwd };
  }

  providerStates(): BrowserProviderState[] {
    return [...this.states.values()].map(state => ({ ...state }));
  }

  async listChats(signal?: AbortSignal): Promise<readonly BrowserChat[]> {
    const providers = [...this.providers.values()];
    const results = await Promise.allSettled(providers.map(async provider => ({
      provider, chats: await provider.driver.listChats(signal),
    })));
    const chats: BrowserChat[] = [];
    const failures: string[] = [];
    results.forEach((result, index) => {
      const provider = providers[index]!;
      if (result.status === "fulfilled") {
        chats.push(...result.value.chats.map(chat => this.scoped(provider, chat)));
        this.states.set(provider.id, { id: provider.id, available: true });
      } else {
        const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
        failures.push(provider.id);
        this.states.set(provider.id, { id: provider.id, available: false, error: reason });
      }
    });
    if (failures.length === this.providers.size) throw new Error(`Browser chat providers unavailable: ${failures.join(", ")}`);
    return chats;
  }

  async getChat(scopedId: string, signal?: AbortSignal): Promise<BrowserChat | null> {
    const { provider, nativeId } = this.resolve(scopedId);
    const chat = provider.driver.getChat
      ? await provider.driver.getChat(nativeId, signal)
      : (await provider.driver.listChats(signal)).find(chat => chat.id === nativeId);
    return chat ? this.scoped(provider, chat) : null;
  }

  async sendMessage(input: { chatId: string; text: string; waitForCompletion?: boolean }, signal?: AbortSignal) {
    const { provider, nativeId } = this.resolve(input.chatId);
    return provider.driver.sendMessage({ ...input, chatId: nativeId }, signal);
  }

  supportsModelSwitch(): boolean {
    return [...this.providers.values()].some(provider => typeof provider.driver.changeModel === "function");
  }

  async listModels(signal?: AbortSignal): Promise<string[]> {
    const results = await Promise.allSettled([...this.providers.values()].map(async provider =>
      ({ provider, models: provider.driver.listModels ? await provider.driver.listModels(signal) : [] })));
    return results.flatMap(result => result.status === "fulfilled"
      ? result.value.models.map(model => BrowserChatRouter.scopedId(result.value.provider.id, model)) : []);
  }

  async changeModel(input: { chatId: string; model: string }, signal?: AbortSignal): Promise<{ ok: boolean; error?: string }> {
    const { provider, nativeId } = this.resolve(input.chatId);
    if (!provider.driver.changeModel) return { ok: false, error: "Model selection not supported by provider" };
    const model = input.model.startsWith(provider.id + "::")
      ? this.resolve(input.model).nativeId : input.model;
    if (input.model.includes("::") && !input.model.startsWith(provider.id + "::"))
      return { ok: false, error: "Model belongs to a different provider" };
    return provider.driver.changeModel({ chatId: nativeId, model }, signal);
  }
}
