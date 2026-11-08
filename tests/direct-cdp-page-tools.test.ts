import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { DirectCdpPageTools } from "../src/adapters/direct-cdp-page-tools.js";
import type WebSocket from "ws";

type Frame = { id: number; method: string; params: Record<string, unknown>; sessionId?: string };
class FakeSocket extends EventEmitter {
  readyState = 0;
  sent: Frame[] = [];
  contextId = "ctx-A";
  targetId = "target-A";
  respond: (frame: Frame) => unknown = frame => this.result(frame);
  constructor() { super(); queueMicrotask(() => { this.readyState = 1; this.emit("open"); }); }
  send(raw: string) {
    const frame = JSON.parse(raw) as Frame;
    this.sent.push(frame);
    const result = this.respond(frame);
    if (result !== undefined) queueMicrotask(() => this.emit("message", Buffer.from(JSON.stringify({ id: frame.id, result }))));
  }
  close() { this.readyState = 3; this.emit("close"); }
  private result(frame: Frame): unknown {
    if (frame.method === "Target.getTargets") return { targetInfos: [{ targetId: this.targetId, type: "page", title: "ChatGPT", url: "https://chatgpt.com/", browserContextId: this.contextId }] };
    if (frame.method === "Target.attachToTarget") return { sessionId: `session-${this.targetId}` };
    if (frame.method === "Target.createTarget") { this.targetId = "target-created"; return { targetId: this.targetId }; }
    if (frame.method === "Runtime.evaluate") return { result: { value: { ok: true } } };
    if (frame.method === "Accessibility.getFullAXTree") return { nodes: [
      { role: { value: "textbox" }, name: { value: "Ask ChatGPT" }, backendDOMNodeId: 19 },
      { role: { value: "button" }, name: { value: "Send message" }, backendDOMNodeId: 20 },
    ] };
    if (frame.method === "DOM.resolveNode") return { object: { objectId: "object-19" } };
    if (frame.method === "Runtime.callFunctionOn") return { result: { value: { ok: true } } };
    return {};
  }
}

function create(socket: FakeSocket, config: Record<string, unknown> = {}) {
  return new DirectCdpPageTools({ endpoint: "ws://127.0.0.1:9222/devtools/browser/fake", contextId: "ctx-A", targetId: "target-A", ...config } as never,
    (() => socket) as unknown as (url: string) => WebSocket);
}

describe("DirectCdpPageTools", () => {
  it("bounds a websocket connection that never opens", async () => {
    vi.useFakeTimers();
    try {
      const socket = new EventEmitter() as EventEmitter & { readyState:number; send:()=>void; close:()=>void };
      socket.readyState=0; socket.send=()=>{}; socket.close=()=>{socket.readyState=3;};
      const tools = create(socket as unknown as FakeSocket, { timeoutMs:100 });
      let settled = false;
      const call = tools.call("list_pages").catch(() => { settled=true; });
      await vi.advanceTimersByTimeAsync(101);
      expect(settled).toBe(true);
      await call;
      tools.close();
    } finally { vi.useRealTimers(); }
  });
  it("pins browser context and target and formats pages for the existing driver", async () => {
    const socket = new FakeSocket();
    const tools = create(socket);
    expect(await tools.call("list_pages")).toBe("1: ChatGPT (https://chatgpt.com/) [selected]");
    socket.contextId = "foreign-context";
    await expect(tools.call("list_pages")).rejects.toThrow("target_context_mismatch");
    tools.close();
  });

  it("correlates out-of-order CDP replies and binds evaluation to the pinned target session", async () => {
    const socket = new FakeSocket();
    socket.respond = frame => frame.method === "Target.getTargets"
      ? { targetInfos: [{ targetId: "target-A", type: "page", title: "ChatGPT", url: "https://chatgpt.com/", browserContextId: "ctx-A" }] }
      : frame.method === "Target.attachToTarget" ? { sessionId: "exact-session" }
        : { result: { value: String(frame.params.expression).includes("'one'") ? "one" : "two" } };
    const tools = create(socket);
    const first = tools.call("evaluate_script", { pageId: 1, function: "() => 'one'" });
    const second = tools.call("evaluate_script", { pageId: 1, function: "() => 'two'" });
    let evaluations = socket.sent.filter(frame => frame.method === "Runtime.evaluate");
    for (let index = 0; index < 20 && evaluations.length < 2; index += 1) {
      await new Promise(resolve => setTimeout(resolve, 0));
      evaluations = socket.sent.filter(frame => frame.method === "Runtime.evaluate");
    }
    socket.emit("message", Buffer.from(JSON.stringify({ id: evaluations[1]!.id, result: { result: { value: "two" } } })));
    socket.emit("message", Buffer.from(JSON.stringify({ id: evaluations[0]!.id, result: { result: { value: "one" } } })));
    expect(await first).toContain('"one"');
    expect(await second).toContain('"two"');
    expect(evaluations.every(frame => frame.sessionId === "exact-session")).toBe(true);
    expect(new Set(evaluations.map(frame => frame.id)).size).toBe(2);
    tools.close();
  });

  it("creates and navigates only ChatGPT pages in the pinned context", async () => {
    const socket = new FakeSocket();
    const tools = create(socket);
    expect(await tools.call("new_page", { url: "https://chatgpt.com/" })).toContain("opened");
    expect(socket.sent.find(frame => frame.method === "Target.createTarget")?.params.browserContextId).toBe("ctx-A");
    expect(await tools.call("list_pages")).toContain("1: ChatGPT");
    await tools.call("navigate_page", { pageId: 1, url: "https://chatgpt.com/c/123" });
    expect(socket.sent.find(frame => frame.method === "Page.navigate")?.sessionId).toBe("session-target-created");
    await expect(tools.call("navigate_page", { pageId: 1, url: "https://example.com/" })).rejects.toThrow("origin_rejected");
    tools.close();
  });

  it("binds editable DOM refs to the current snapshot, target and context", async () => {
    const socket = new FakeSocket();
    const tools = create(socket);
    const snapshot = await tools.call("take_snapshot", { pageId: 1 });
    const uid = snapshot.match(/uid=([\w-]+) textbox "Ask ChatGPT"/)?.[1];
    expect(uid).toBeTruthy();
    await tools.call("fill", { pageId: 1, uid, value: "draft" });
    expect(socket.sent.find(frame => frame.method === "DOM.resolveNode")?.params.backendNodeId).toBe(19);
    expect(socket.sent.find(frame => frame.method === "Runtime.callFunctionOn")?.sessionId).toBe("session-target-A");
    await expect(tools.call("fill", { pageId: 1, uid, value: "replay" })).rejects.toThrow("dom_ref_stale_or_foreign");

    const oldUid = uid!;
    await tools.call("take_snapshot", { pageId: 1 });
    await expect(tools.call("fill", { pageId: 1, uid: oldUid, value: "stale" })).rejects.toThrow("dom_ref_stale_or_foreign");
    await expect(tools.call("fill", { pageId: 1, uid: "foreign-ref", value: "foreign" })).rejects.toThrow("dom_ref_stale_or_foreign");
    tools.close();
  });

  it("invalidates DOM refs when the selected page navigates", async () => {
    const socket = new FakeSocket();
    const tools = create(socket);
    const snapshot = await tools.call("take_snapshot", { pageId: 1 });
    const uid = snapshot.match(/uid=([\w-]+) textbox/)?.[1];
    await tools.call("navigate_page", { pageId: 1, url: "https://chatgpt.com/c/123" });
    await expect(tools.call("fill", { pageId: 1, uid, value: "too late" })).rejects.toThrow("dom_ref_stale_or_foreign");
    tools.close();
  });

  it("does not retry unknown timed-out mutations or unsupported gateway methods", async () => {
    const socket = new FakeSocket();
    socket.respond = frame => frame.method === "Target.getTargets"
      ? { targetInfos: [{ targetId: "target-A", type: "page", title: "ChatGPT", url: "https://chatgpt.com/", browserContextId: "ctx-A" }] }
      : frame.method === "Target.attachToTarget" ? { sessionId: "session-target-A" } : undefined;
    const tools = create(socket, { timeoutMs: 100 });
    const failed = tools.call("new_page", { url: "https://chatgpt.com/" });
    await expect(failed).rejects.toThrow("outcome may be unknown; do not retry");
    expect(socket.sent.filter(frame => frame.method === "Target.createTarget")).toHaveLength(1);
    await expect(tools.call("click")).rejects.toThrow("unsupported_direct_cdp_tool:click");
    tools.close();
  });

  it("rejects in-flight commands on disconnect without replay", async () => {
    const socket = new FakeSocket();
    socket.respond = frame => frame.method === "Target.getTargets"
      ? { targetInfos: [{ targetId: "target-A", type: "page", title: "ChatGPT", url: "https://chatgpt.com/", browserContextId: "ctx-A" }] }
      : frame.method === "Target.attachToTarget" ? { sessionId: "session-target-A" } : undefined;
    const tools = create(socket, { timeoutMs: 5_000 });
    const pending = tools.call("evaluate_script", { pageId: 1, function: "() => ({ ok: true })" });
    for (let index = 0; index < 20 && !socket.sent.some(frame => frame.method === "Runtime.evaluate"); index += 1) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    socket.close();
    await expect(pending).rejects.toThrow("direct_cdp_disconnected; operation outcome may be unknown");
    expect(socket.sent.filter(frame => frame.method === "Runtime.evaluate")).toHaveLength(1);
  });
});

it("supports the default context of each separate Chrome profile without mixing their targets", async () => {
  const a=new FakeSocket(), b=new FakeSocket();
  a.contextId=undefined as unknown as string; b.contextId=undefined as unknown as string;
  // Two Chrome processes can expose the same local target id. The endpoint,
  // not that target id alone, is part of the connection identity.
  const first=create(a,{endpoint:"ws://127.0.0.1:19221/browser/a",contextId:"default"});
  const second=create(b,{endpoint:"ws://127.0.0.1:19222/browser/b",contextId:"default"});
  await Promise.all([first.call("list_pages"),second.call("list_pages")]);
  await first.call("evaluate_script",{pageId:1,function:"() => 'read-account-A'"});
  await second.call("evaluate_script",{pageId:1,function:"() => 'archive-account-B'"});
  expect(a.sent.filter(x=>x.method==="Runtime.evaluate").map(x=>x.params.expression)).toEqual(["(() => 'read-account-A')()"]);
  expect(b.sent.filter(x=>x.method==="Runtime.evaluate").map(x=>x.params.expression)).toEqual(["(() => 'archive-account-B')()"]);
  await second.call("new_page",{url:"https://chatgpt.com/"});
  expect(b.sent.find(x=>x.method==="Target.createTarget")!.params).not.toHaveProperty("browserContextId");
  second.close();
  await expect(second.call("list_pages")).rejects.toThrow("closed");
  await expect(first.call("list_pages")).resolves.toContain("ChatGPT");
  expect(a.sent.some(x=>x.method==="Target.createTarget")).toBe(false);
  first.close();
});


it("recovers the account-owned target after restart without creating a second tab", async () => {
  const socket = new FakeSocket();
  const scope = "a".repeat(64);
  socket.respond = frame => {
    if (frame.method === "Target.getTargets") return { targetInfos: [
      { targetId: "other-profile", type: "page", browserContextId: "ctx-B", url: "https://chatgpt.com/" },
      { targetId: "recovered", type: "page", browserContextId: "ctx-A", url: "https://chatgpt.com/c/123" },
    ] };
    if (frame.method === "Target.attachToTarget") return { sessionId: "session-recovered" };
    if (frame.method === "Runtime.evaluate") return { result: { value: "herder-owned:chatgpt:" + scope } };
    return {};
  };
  const tools = create(socket, { accountScope: scope });
  expect(await tools.call("list_pages")).toContain("https://chatgpt.com/c/123");
  expect(await tools.call("list_pages")).toContain("https://chatgpt.com/c/123");
  expect(socket.sent.filter(frame => frame.method === "Target.attachToTarget").map(frame => frame.params.targetId)).toEqual(["recovered"]);
  expect(socket.sent.some(frame => frame.method === "Target.createTarget")).toBe(false);
  tools.close();
});
