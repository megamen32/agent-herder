import { expect, it } from "vitest";
import { runInNewContext } from "node:vm";
import { BrowserChatAdapter } from "../src/adapters/browser-chat.js";
import { ChatGptMacCdpDriver } from "../src/adapters/chatgpt-mac-cdp-driver.js";
import { CHATGPT_CREATE_SCOPE_SCRIPT } from "../src/adapters/browser-chat-new-page.js";
import type { ChromePageTools } from "../src/adapters/mac-mini-chrome-transport.js";

const chat = "6ada477c-7014-83ed-82ae-7881dbe3e109";
const oldMessage = "11111111-2222-4333-8444-555555555555";
const scope = "a".repeat(64);
const result = (value: unknown) => "Script ran on page and returned:\n```json\n" + JSON.stringify(value) + "\n```";

it("uses a first-draft native receipt without inventing a history baseline",async()=>{
  let reads=0,sends=0;
  const draft={id:'draft:11111111-1111-4111-8111-111111111111',title:'new',unread:false,working:false,updatedAt:new Date(0).toISOString(),pendingRemoteCreation:true};
  const driver={supportsFirstSendReceipt:true,listChats:async()=>[draft],getKnownChat:()=>draft,
    getMessages:async()=>{reads++;throw new Error('no native chat')},
    sendMessage:async()=>{sends++;return {nativeInputMessageId:oldMessage}}};
  const adapter=new BrowserChatAdapter(driver,{id:'chatgpt',name:'test',harness:'chatgpt',cwd:'/tmp'});
  const result=await adapter.sendMessage(draft.id,{message:'hello',inputId:'key'});
  expect(result).toMatchObject({ok:true,admitted:true,inputId:'key',nativeInputMessageId:oldMessage});
  expect(reads).toBe(0);expect(sends).toBe(1);
});

it("does not use another chat's empty DOM baseline to confirm an old identical message", async () => {
  const bubble = {
    innerText: "hello",
    getAttribute: (name: string) => name === "data-message-id" ? oldMessage : null,
    closest: (selector: string) => selector === "[data-message-id]"
      ? { getAttribute: () => oldMessage } : null,
  };
  const tools: ChromePageTools = { call: async (name, args = {}) => {
    if (name === "list_pages") return `1: Other (https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee)\n2: Target (https://chatgpt.com/c/${chat})`;
    if (name === "evaluate_script") {
      if (args.function === CHATGPT_CREATE_SCOPE_SCRIPT) return result({ scope });
      return result(runInNewContext(`(${String(args.function)})()`, {
        location: { pathname: Number(args.pageId) === 2 ? `/c/${chat}` : "/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" },
        document: { querySelectorAll: () => [bubble] },
      }));
    }
    throw new Error(`unexpected browser action ${name}`);
  } };
  const driver = new ChatGptMacCdpDriver(tools, 2, 0, scope);
  // Provider history is unavailable; the second tab already renders this
  // message. Simulate a send whose effect never appeared, without any network.
  driver.getMessages = async () => { throw new Error("HTTP 429"); };
  let sends = 0;
  driver.sendMessage = async () => { sends++; return {}; };
  const adapter = new BrowserChatAdapter(driver, {
    id: "receipt-review", name: "receipt-review", harness: "chatgpt", cwd: "/tmp/browser",
  });
  const receipt = await adapter.sendMessage(chat, { message: "hello", inputId: "new-operation" });
  expect(receipt.ok).toBe(false);
  expect(receipt.nativeInputMessageId).toBeUndefined();
  expect(sends).toBeLessThanOrEqual(1);
});
