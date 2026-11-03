import { describe, expect, it } from "vitest";
import { runInNewContext } from "node:vm";
import { ZAI_LIST_API_SCRIPT } from "../src/adapters/browser-chat-api-scripts.js";
import { ZaiCdpDriver } from "../src/adapters/zai-cdp-driver.js";
import type { ChromePageTools } from "../src/adapters/mac-mini-chrome-transport.js";

const evalJson = (value: unknown) => "Script ran on page and returned:\n```json\n" + JSON.stringify(value) + "\n```";
const state = () => ({
  origin: "https://chat.z.ai", path: "/", loggedIn: true, composer: true,
  titles: [] as string[], phase: "idle" as const, draftPresent: false,
});

/** Only the calls listChats needs: the page list plus the two evaluations. */
class NativeListTools implements ChromePageTools {
  constructor(private readonly chats: unknown[]) {}
  async call(name: string, args: Record<string, unknown> = {}): Promise<string> {
    if (name === "list_pages") return "11: Z.ai (https://chat.z.ai/) [selected]";
    if (name === "evaluate_script") {
      if (String(args.function) === ZAI_LIST_API_SCRIPT) {
        return evalJson({ scope: "a".repeat(64), chats: this.chats });
      }
      return evalJson(state());
    }
    throw new Error("unexpected tool: " + name);
  }
}

describe("ZAI native listing keeps chats without a title", () => {
  it("lists untitled account chats with a stable fallback title instead of dropping them", async () => {
    const tools = new NativeListTools([
      { id: "123e4567-e89b-12d3-a456-426614174010", title: "", updatedAt: 1730000000 },
      { id: "123e4567-e89b-12d3-a456-426614174011", updatedAt: 1730000001 },
      { id: "123e4567-e89b-12d3-a456-426614174012", title: "Named chat", updatedAt: 1730000002 },
    ]);
    const chats = await new ZaiCdpDriver(tools).listChats();
    expect(chats.map(chat => [chat.id, chat.title])).toEqual([
      ["route:123e4567-e89b-12d3-a456-426614174010", "ZAI conversation"],
      ["route:123e4567-e89b-12d3-a456-426614174011", "ZAI conversation"],
      ["route:123e4567-e89b-12d3-a456-426614174012", "Named chat"],
    ]);
    expect(chats.every(chat => chat.id.startsWith("route:"))).toBe(true);
  });

  it("keeps titleless chats in the account list script output", async () => {
    const listed = [
      { id: "123e4567-e89b-12d3-a456-426614174020", title: "", updated_at: 1730000000 },
      { id: "123e4567-e89b-12d3-a456-426614174021", updated_at: 1730000001, has_unread_msg: true },
      { id: "123e4567-e89b-12d3-a456-426614174022", title: "Named", updated_at: 1730000002 },
    ];
    const sandbox = {
      location: { origin: "https://chat.z.ai" },
      fetch: async (url: string) => ({
        ok: true,
        json: async () => (String(url).includes("page=") ? listed : { user_id: "owner-1" }),
      }),
      crypto: { subtle: { digest: async () => new Uint8Array(32).fill(0x61).buffer } },
      TextEncoder,
    };
    const result = await runInNewContext("(" + ZAI_LIST_API_SCRIPT + ")()", sandbox) as {
      scope: string; chats: Array<{ id: string; title: string }>;
    };
    expect(result.scope).toBe("61".repeat(32));
    expect(result.chats.map(chat => chat.id)).toEqual(listed.map(chat => chat.id));
    expect(result.chats.find(chat => chat.id === listed[0]!.id)?.title).toBe("");
    expect(result.chats.find(chat => chat.id === listed[1]!.id)?.title).toBe("");
    expect(result.chats.find(chat => chat.id === listed[2]!.id)?.title).toBe("Named");
  });
});
