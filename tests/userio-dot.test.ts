import { describe, expect, it } from "vitest";
import type { UserIoAgentResult } from "../src/adapters/userio-agent-channel.js";
import { UserIoDotClient } from "../src/adapters/userio-dot.js";
import { registerUserIoDotTools } from "../src/mcp/userio-dot-tools.js";

const URL = "https://chatgpt.com/dots/room~profile";
const ROOM = "room";

function fixture(results: Array<UserIoAgentResult | Error>) {
  const calls: Array<{ action: string; args: Record<string, unknown> }> = [];
  return {
    calls,
    channel: {
      call: async (action: string, args: Record<string, unknown>) => {
        calls.push({ action, args });
        const result = results.shift();
        if (!result) throw new Error("fixture_result_missing");
        if (result instanceof Error) throw result;
        return result;
      },
    },
  };
}

const probe = (): UserIoAgentResult => ({ ok: true, matches: true });
const snapshot = (messages: unknown[], cursor: string): UserIoAgentResult => ({
  ok: true, room: ROOM, messages, cursor,
});

describe("UserIO Dot client", () => {
  it("reads only the bound room through the existing command channel", async () => {
    const f = fixture([probe(), snapshot([{ id: "m1", role: "assistant", text: "hello" }], "m1")]);
    const client = new UserIoDotClient(f.channel);
    const result = await client.snapshot({ url: URL, room: ROOM, after: "m0" });
    expect(result.messages[0]?.text).toBe("hello");
    expect(f.calls).toEqual([
      { action: "dot_profile_probe", args: { url: URL, room: ROOM } },
      { action: "dot_action", args: { url: URL, room: ROOM, operation: "snapshot", after: "m0" } },
    ]);
  });

  it("refuses a profile mismatch before the Dot action", async () => {
    const f = fixture([{ ok: true, matches: false }]);
    const client = new UserIoDotClient(f.channel);
    await expect(client.snapshot({ url: URL, room: ROOM })).rejects.toThrow("userio_dot_profile_mismatch");
    expect(f.calls.map(call => call.action)).toEqual(["dot_profile_probe"]);
  });

  it("sends once and confirms the native user message by readback", async () => {
    const f = fixture([
      probe(), snapshot([], "before"),
      new Error("empty_draft"),
      probe(), { ok: true, status: "submitted_unconfirmed" },
      probe(), snapshot([{ id: "m2", role: "user", text: "hello Dot" }], "m2"),
    ]);
    const client = new UserIoDotClient(f.channel, { readbackAttempts: 1 });
    const result = await client.send({ url: URL, room: ROOM, text: "hello Dot" });
    expect(result).toMatchObject({ ok: true, status: "confirmed", message: { id: "m2" } });
    expect(f.calls.filter(call => call.action === "dot_action" && call.args.operation === "send")).toHaveLength(1);
  });

  it("classifies a lost send result as unknown and never retries", async () => {
    const f = fixture([probe(), snapshot([], "before"), new Error("empty_draft")]);
    f.channel.call = async (action, args) => {
      f.calls.push({ action, args });
      if (action === "dot_action" && args.operation === "send") throw new Error("transport_lost");
      return action === "dot_profile_probe" ? probe() : snapshot([], "before");
    };
    const client = new UserIoDotClient(f.channel, { readbackAttempts: 1 });
    await expect(client.send({ url: URL, room: ROOM, text: "one click" })).resolves.toEqual({
      ok: false, status: "unknown", error: "dot_send_outcome_unknown",
    });
    expect(f.calls.filter(call => call.action === "dot_action" && call.args.operation === "send")).toHaveLength(1);
  });

  it("registers only the bounded snapshot and send tools", () => {
    const f = fixture([]);
    const registered: string[] = [];
    const server = { registerTool(name: string) { registered.push(name); } };
    registerUserIoDotTools(server as never, {
      client: new UserIoDotClient(f.channel),
      binding: { url: URL, room: ROOM },
    });
    expect(registered).toEqual(["dot_snapshot", "dot_send"]);
  });
});
