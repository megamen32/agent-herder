import { BrowserChatAdapter } from "./browser-chat.js";
import type { ChatGptHarnessDriver } from "../cdp-chat.js";
export const CHATGPT_HARNESS_CWD = "/home/roomhacker/.chatgpt";
export class ChatGptAdapter extends BrowserChatAdapter {
 constructor(driver: ChatGptHarnessDriver, cwd = CHATGPT_HARNESS_CWD) {
  super(driver, { id: "chatgpt", name: "ChatGPT", harness: "chatgpt", cwd }, cwd);
 }
}
