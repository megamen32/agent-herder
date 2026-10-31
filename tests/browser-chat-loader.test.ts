import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadBrowserChatAdapters, loadBrowserChatProviderAdapter, configuredBrowserProviderIds } from "../src/adapters/browser-chat-loader.js";

let directory: string | null = null;
afterEach(async () => { if (directory) await rm(directory, { recursive: true, force: true }); directory = null; });

describe("separate site adapters sharing one browser base class", () => {
  it("loads two independent instances with exact site identity and capabilities", async () => {
    const config = JSON.stringify([
      { id: "chatgpt", name: "ChatGPT", cwd: "/browser/chatgpt", module: "builtin:chatgpt-mac-cdp" },
      { id: "zai", name: "Z.ai", cwd: "/browser/zai", module: "builtin:zai-cdp" },
    ]);
    expect(configuredBrowserProviderIds(config)).toEqual(["chatgpt", "zai"]);
    const [chatgpt, zai] = await loadBrowserChatAdapters(config);
    expect(chatgpt.type).toBe("chatgpt");
    expect(zai.type).toBe("zai");
    expect(chatgpt.constructor).toBe(zai.constructor);
    expect(chatgpt).not.toBe(zai);
    expect(chatgpt.browserFeatures).toMatchObject({
      nativeConversationIds: true, accountArchiveViaCdp: true, queueAfterGeneration: true,
    });
    expect(zai.browserFeatures).toMatchObject({
      nativeConversationIds: false, accountArchiveViaCdp: false, queueAfterGeneration: true,
    });
    expect(chatgpt.controlCapabilities).toMatchObject({ cancelTurn: false, modelSwitch: false });
    expect(zai.controlCapabilities).toMatchObject({ cancelTurn: false, modelSwitch: false });
  });

  it("scopes native chat IDs without mixing sessions or sending to another provider", async () => {
    directory = await mkdtemp(join(tmpdir(), "browser-providers-"));
    const module = join(directory, "fixture.mjs");
    await writeFile(module, `export async function createBrowserChatDriver() {
      return {
        listChats: async () => [{id:"same-native-id",title:"Test",working:false,unread:false,updatedAt:"2026-10-31T10:00:00Z"}],
        getChat: async id => id==="same-native-id" ? {id,title:"Test",working:false,unread:false,updatedAt:"2026-10-31T10:00:00Z"} : null,
        sendMessage: async ({chatId}) => {
          if(chatId!=="same-native-id")throw Error("wrong target");return {};
        },
      };
    }`);
    const config = JSON.stringify([
      { id: "chatgpt", name: "ChatGPT", cwd: "/browser/chatgpt", module },
      { id: "zai", name: "Z.ai", cwd: "/browser/zai", module },
    ]);
    const [chatgpt,zai] = await loadBrowserChatAdapters(config);
    await chatgpt.init();
    await zai.init();
    const [a] = await chatgpt.listSessions();
    const [b] = await zai.listSessions();
    expect(a).toMatchObject({id:"chatgpt::same-native-id",harness:"chatgpt",cwd:"/browser/chatgpt",meta:{browserProvider:"chatgpt"}});
    expect(b).toMatchObject({id:"zai::same-native-id",harness:"zai",cwd:"/browser/zai",meta:{browserProvider:"zai"}});
    expect(await chatgpt.getSession(a!.id)).toMatchObject({id:a!.id});
    expect(await zai.getSession(b!.id)).toMatchObject({id:b!.id});
    await expect(chatgpt.getSession(b!.id)).rejects.toThrow(/another provider/);
    await expect(zai.getSession(a!.id)).rejects.toThrow(/another provider/);
    expect(await zai.sendMessage(b!.id,{message:"hello"})).toMatchObject({ok:true});
    expect(await chatgpt.sendMessage(b!.id,{message:"hello"})).toMatchObject({ok:false,notSubmitted:true});
  });

  it("loads only one site on demand, without requiring the other to be available", async () => {
    directory = await mkdtemp(join(tmpdir(), "browser-provider-offline-"));
    const module = join(directory, "fixture.mjs");
    await writeFile(module, `export async function createBrowserChatDriver(){
      return {listChats: async()=>[],sendMessage: async()=>({})};
    }`);
    const config = JSON.stringify([
      { id: "chatgpt", name: "ChatGPT", cwd: "/browser/chatgpt", module },
      { id: "zai", name: "Z.ai", cwd: "/browser/zai", module: "/missing/driver.mjs" },
    ]);
    expect((await loadBrowserChatProviderAdapter("chatgpt",config)).type).toBe("chatgpt");
    await expect(loadBrowserChatProviderAdapter("zai",config)).rejects.toThrow();
  });

  it("rejects unsafe modules, unrecognized providers and duplicate IDs", async () => {
    await expect(loadBrowserChatAdapters(JSON.stringify([{id:"zai",name:"Z.ai",cwd:"/browser/zai",module:"https://invalid/"}]))).rejects.toThrow(/absolute local/);
    expect(()=>configuredBrowserProviderIds(JSON.stringify([{id:"deepseek",name:"DeepSeek",cwd:"/browser/deepseek",module:"builtin:zai-cdp"}]))).toThrow(/Unsupported/);
    expect(()=>configuredBrowserProviderIds(JSON.stringify([
      {id:"zai",name:"One",cwd:"/browser/zai",module:"builtin:zai-cdp"},
      {id:"zai",name:"Two",cwd:"/browser/zai",module:"builtin:zai-cdp"},
    ]))).toThrow(/Duplicate/);
  });
});
