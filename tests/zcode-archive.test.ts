import { expect, it, vi } from "vitest";
import { ZcodeAdapter } from "../src/adapters/zcode.js";
import type { ZcodeClientLike } from "../src/adapters/zcode-protocol.js";

function fixture() {
  const meta = { taskId: "fixture-session", workspacePath: "/fixture", workspaceIdentity: "/fixture" };
  const read = vi.fn(async () => ({ session: { sessionId: meta.taskId, workspace: meta } }));
  const archive = vi.fn(async () => meta);
  const archived = vi.fn(async () => [meta]);
  const call = vi.fn(async (channel: string, method: string) => {
    if (channel === "zcode-agent" && method === "readSession") return read();
    if (channel === "zcode-task" && method === "archiveTask") return archive();
    if (channel === "zcode-task" && method === "listArchivedTasks") return archived();
    throw new Error("unexpected native operation: " + channel + "/" + method);
  });
  const client = { start: async () => {}, close: async () => {}, call, listen: () => () => {} } as ZcodeClientLike;
  return { adapter: new ZcodeAdapter({ client, cwd: "/fixture" }), call, read, archive, archived };
}

it("archives exactly one native task through the official task service and reads archived membership", async () => {
  const f = fixture();
  expect(await f.adapter.archiveSession!("fixture-session")).toEqual({ ok: true, sessionId: "fixture-session" });
  expect(f.call.mock.calls).toEqual([
    ["zcode-agent", "readSession", [{ workspacePath: "/fixture", workspaceIdentity: "/fixture", workspaceKey: "/fixture", runtimePolicy: "existing-only", sessionId: "fixture-session", messageLimit: 1 }]],
    ["zcode-task", "archiveTask", [{ workspacePath: "/fixture", workspaceIdentity: "/fixture", workspaceKey: "/fixture", taskId: "fixture-session" }]],
    ["zcode-task", "listArchivedTasks", [{ workspacePath: "/fixture", workspaceIdentity: "/fixture", workspaceKey: "/fixture" }]],
  ]);
});

it("refuses an invalid or mismatched native target before archive", async () => {
  const f = fixture();
  expect((await f.adapter.archiveSession!("\n")).ok).toBe(false);
  expect(f.call).not.toHaveBeenCalled();
  f.read.mockResolvedValue({ session: { sessionId: "other", workspace: { taskId: "other", workspacePath: "/fixture", workspaceIdentity: "/fixture" } } });
  expect((await f.adapter.archiveSession!("fixture-session")).ok).toBe(false);
  expect(f.archive).not.toHaveBeenCalled();
  f.read.mockResolvedValue({ session: { sessionId: "fixture-session", workspace: { taskId: "fixture-session", workspacePath: "/other", workspaceIdentity: "/other" } } });
  expect((await f.adapter.archiveSession!("fixture-session")).ok).toBe(false);
  expect(f.archive).not.toHaveBeenCalled();
});

it("does not confirm absent archived membership or repeat an uncertain native mutation", async () => {
  const f = fixture();
  f.archived.mockResolvedValue([]);
  await expect(f.adapter.archiveSession!("fixture-session")).rejects.toThrow(/archive.*confirmed/i);
  expect(f.archive).toHaveBeenCalledTimes(1);
  const uncertain = fixture();
  uncertain.archive.mockRejectedValue(new Error("native reply lost"));
  await expect(uncertain.adapter.archiveSession!("fixture-session")).rejects.toThrow("native reply lost");
  expect(uncertain.archive).toHaveBeenCalledTimes(1);
  expect(uncertain.archived).not.toHaveBeenCalled();
});

it("rejects an archive acknowledgement or archived list for a different target", async () => {
  const f = fixture();
  f.archive.mockResolvedValue({ taskId: "other", workspacePath: "/fixture", workspaceIdentity: "/fixture" });
  await expect(f.adapter.archiveSession!("fixture-session")).rejects.toThrow(/acknowledgement identity mismatch/);
  expect(f.archive).toHaveBeenCalledTimes(1);
  expect(f.archived).not.toHaveBeenCalled();
  const wrongWorkspace = fixture();
  wrongWorkspace.archived.mockResolvedValue([{ taskId: "fixture-session", workspacePath: "/other", workspaceIdentity: "/other" }]);
  await expect(wrongWorkspace.adapter.archiveSession!("fixture-session")).rejects.toThrow(/archive.*confirmed/i);
  expect(wrongWorkspace.archive).toHaveBeenCalledTimes(1);
});
