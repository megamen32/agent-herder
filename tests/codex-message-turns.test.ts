import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CodexAdapter } from "../src/adapters/codex.js";
import { groupSessionMessages } from "../src/web-ui/message-groups.js";

const record = (type: string, payload: unknown) => JSON.stringify({ type, timestamp: "2026-10-08T11:26:39.833Z", payload });
const message = (id: string, text: string, turnId?: string, phase = "commentary") => record("response_item", {
  type: "message", id, role: "assistant", phase, content: [{ type: "output_text", text }],
  ...(turnId ? { internal_chat_message_metadata_passthrough: { turn_id: turnId } } : {}),
});

async function withRollout(lines: string[], test: (adapter: CodexAdapter) => Promise<void>, delimiter = "\n") {
  const codexDir = await mkdtemp(join(tmpdir(), "herder-message-turns-"));
  try {
    const sessionDir = join(codexDir, "sessions", "2026", "10", "08");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, "rollout-thread-1.jsonl"), [
      record("session_meta", { id: "thread-1", cwd: "/workspace" }), ...lines, "",
    ].join(delimiter));
    await writeFile(join(codexDir, "session_index.jsonl"), JSON.stringify({ id: "thread-1", updated_at: "2026-10-08T11:26:39.833Z" }) + "\n");
    // Reads the actual adapter path; never starts a Codex process or turn.
    await test(new CodexAdapter({ codexDir, codexBin: "/not-started" }));
  } finally {
    await rm(codexDir, { recursive: true, force: true });
  }
}

describe("Codex native transcript turn identity", () => {
  it("retains scalar public summaries and one identity for legacy/native activity updates", async () => {
    await withRollout([
      record("response_item", {type: "reasoning", id: "scalar-summary", summary: "Public legacy summary", encrypted_content: "PRIVATE_ENCRYPTED"}),
      record("event_msg", {type: "item_completed", item: {type: "Reasoning", id: "native-summary", summary_text: "Public native summary", raw_content: "PRIVATE_RAW"}}),
      record("response_item", {type: "function_call", id: "fc-1", call_id: "call-1", name: "command", arguments: "pwd"}),
      record("event_msg", {type: "item_completed", item: {type: "CommandExecution", id: "call-1", command: ["pwd"], aggregated_output: "/workspace", exit_code: 0}}),
      record("response_item", {type: "function_call_output", call_id: "call-1", output: "/workspace"}),
    ], async adapter => {
      const messages = await adapter.getSessionMessages("thread-1", 12);
      expect(messages?.flatMap(m => m.parts).filter(p => p.type === "thinking").map(p => p.text)).toEqual(["Public legacy summary", "Public native summary"]);
      expect(messages?.filter(m => m.id === "call-1")).toHaveLength(1);
      expect(messages?.find(m => m.id === "call-1")?.parts.map(p => p.type)).toEqual(["tool_call", "tool_result"]);
      expect(JSON.stringify(messages)).not.toMatch(/PRIVATE_RAW|PRIVATE_ENCRYPTED/);
    });
  });

  it("shows persisted public activity before a final answer without exposing encrypted reasoning", async () => {
    await withRollout([
      record("event_msg", {type: "task_started", turn_id: "live-turn"}),
      record("response_item", {type: "reasoning", id: "hidden", summary: [], encrypted_content: "PRIVATE_ENCRYPTED"}),
      record("event_msg", {type: "item_completed", turn_id: "live-turn", item: {type: "Reasoning", id: "public-event-only", summary_text: [], raw_content: ["PRIVATE_RAW"]}}),
      record("event_msg", {type: "item_completed", turn_id: "live-turn", item: {type: "Reasoning", id: "public-summary", summary_text: ["Checking the changed files"], raw_content: ["PRIVATE_RAW"]}}),
      record("response_item", {type: "custom_tool_call", call_id: "call-edit", name: "apply_patch", input: "small patch"}),
      record("response_item", {type: "custom_tool_call_output", call_id: "call-edit", output: "Success"}),
      record("event_msg", {type: "item_completed", turn_id: "live-turn", item: {type: "CommandExecution", id: "call-command", command: ["pwd"], status: "completed", aggregated_output: "/workspace", exit_code: 0}}),
      record("event_msg", {type: "item_completed", turn_id: "live-turn", item: {type: "SubAgentActivity", id: "collab-1", kind: "interacted", agent_thread_id: "child-1", agent_path: "/root/worker"}}),
    ], async adapter => {
      const messages = await adapter.getSessionMessages("thread-1", 12);
      const parts = messages!.flatMap(m => m.parts);
      expect(parts).toContainEqual({type: "thinking", text: "Checking the changed files"});
      expect(parts).toContainEqual({type: "thinking"});
      expect(parts).toContainEqual({type: "tool_call", name: "apply_patch", input: "small patch"});
      expect(parts).toContainEqual({type: "tool_result", name: "apply_patch", output: "Success"});
      expect(parts).toContainEqual({type: "tool_result", name: "command", output: "/workspace", error: false});
      expect(parts.some(p => p.type === "tool_call" && p.name === "subagent" && JSON.stringify(p.input).includes("child-1"))).toBe(true);
      expect(messages!.every(m => m.turnId === "live-turn")).toBe(true);
      expect(JSON.stringify(messages)).not.toMatch(/PRIVATE_ENCRYPTED|PRIVATE_RAW/);
      expect(messages!.find(m => m.id === "call-edit")?.parts.map(p => p.type)).toEqual(["tool_call", "tool_result"]);
      expect((await adapter.getSessionMessages("thread-1", 2))!.map(m => m.id)).toEqual(["call-command", "collab-1"]);
    });
  });

  it.each(["\n", "\r\n"])("keeps fallback IDs stable across UTF-8 first/tail reads and windows with %j delimiters", async (delimiter) => {
    const header = record("session_meta", { id: "thread-1", cwd: "/workspace" });
    const prefix = record("event_msg", { type: "noise", text: "Начало истории" });
    const user = record("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "Привет" }] });
    const response = record("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: "Ответ" }] });
    // The narrow read starts inside a UTF-8 record, while the wide read includes its first user.
    const filler = record("event_msg", { type: "noise", text: "ш".repeat(135_000) });
    const firstOffset = Buffer.byteLength([header, prefix, ""].join(delimiter), "utf8");
    const responseOffset = Buffer.byteLength([header, prefix, user, filler, ""].join(delimiter), "utf8");
    await withRollout([prefix, user, filler, response], async (adapter) => {
      const first = await adapter.getFirstUserMessage("thread-1");
      const narrow = await adapter.getSessionMessages("thread-1", 1);
      const wide = await adapter.getSessionMessages("thread-1", 50);
      expect(first).toMatchObject({ id: `thread-1:record:${firstOffset}`, role: "user", text: "Привет" });
      expect(narrow).toHaveLength(1);
      expect(narrow?.[0]).toMatchObject({ id: `thread-1:record:${responseOffset}`, text: "Ответ" });
      expect(wide).toHaveLength(2);
      expect(first?.id).toBe(wide?.find((item) => item.role === "user")?.id);
      expect(narrow?.[0].id).toBe(wide?.find((item) => item.role === "assistant")?.id);
      expect(new Map([...(first ? [first] : []), ...(wide || [])].map((item) => [item.id, item])).size).toBe(2);
    }, delimiter);
  });

  it("preserves native item identity/phase and groups commentary plus final from one turn", async () => {
    await withRollout([
      message("native-progress", "Progress", "turn-1"),
      message("native-result", "Result", "turn-1", "final_answer"),
      message("next-progress", "Next progress", "turn-2"),
    ], async (adapter) => {
      const messages = await adapter.getSessionMessages("thread-1", 50);
      expect(messages).toMatchObject([
        { id: "native-progress", turnId: "turn-1", phase: "commentary" },
        { id: "native-result", turnId: "turn-1", phase: "final_answer" },
        { id: "next-progress", turnId: "turn-2" },
      ]);
      expect(groupSessionMessages(messages || []).map((group) => group.messages.map((item) => item.text)))
        .toEqual([["Progress", "Result"], ["Next progress"]]);
      expect((await adapter.getSessionMessages("thread-1", 2))?.[0].id).toBe("native-result");
    });
  });

  it("uses an observed native context boundary and clears it on native completion", async () => {
    await withRollout([
      record("turn_context", { turn_id: "context-turn" }),
      message("progress", "Progress"), message("result", "Result"),
      record("event_msg", { type: "task_complete", turn_id: "context-turn" }),
      message("unattributed", "Keep separate"),
    ], async (adapter) => {
      const messages = await adapter.getSessionMessages("thread-1", 50);
      expect(messages?.map((item) => item.turnId)).toEqual(["context-turn", "context-turn", undefined]);
      expect(groupSessionMessages(messages || [])).toHaveLength(2);
    });
  });
});

// Fast unit expected<1s/max5s: image-only human input must not vanish from history.
it("renders a native image-only Codex message", async () => {
 const image_url="data:image/png;base64,iVBORw0KGgo=";
 await withRollout([record("response_item",{type:"message",role:"user",content:[{type:"input_image",image_url}]})],async adapter=>{
  expect((await adapter.getSessionMessages("thread-1",10))?.[0]?.parts).toEqual([{type:"image",imageUrl:image_url,fileName:"Изображение"}]);
 });
});
