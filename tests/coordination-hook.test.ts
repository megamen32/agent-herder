import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const hook = fileURLToPath(new URL("../scripts/coordination-hook.mjs", import.meta.url));
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function runHook(event: Record<string, unknown>): Promise<Record<string, unknown>> {
  let received: Record<string, unknown> | undefined;
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const part of request) raw += part;
    if (request.url === "/api/coordination/activity") received = JSON.parse(raw);
    response.setHeader("content-type", "application/json");
    response.end("{}");
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("hook test server did not bind");
  const child = spawn(process.execPath, [hook], {
    env: { ...process.env, AGENT_HERDER_URL: `http://127.0.0.1:${address.port}` },
    stdio: ["pipe", "ignore", "pipe"],
  });
  child.stdin.end(JSON.stringify(event));
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`hook exited ${code}`)));
  });
  if (!received) throw new Error("hook did not post its activity event");
  return received;
}

describe("coordination hook activity reservations", () => {
  it.each([
    ["cat", "cat /repo/notes.md"],
    ["sed", "sed -n '1,40p' /repo/notes.md"],
    ["git status", "git status --short -- /repo/notes.md"],
    ["git diff", "git diff -- /repo/notes.md"],
  ])("does not reserve paths from read-only %s events", async (_name, command) => {
    const activity = await runHook({
      hook_event_name: "PostToolUse", session_id: "reader", cwd: "/repo",
      tool_name: "Bash", tool_input: { command },
    });
    expect(activity.paths).toEqual([]);
  });

  it("keeps paths quoted inside a read report from becoming writer evidence", async () => {
    const activity = await runHook({
      hook_event_name: "PostToolUse", session_id: "reader", cwd: "/repo",
      tool_name: "functions.exec",
      tool_input: { code: "await tools.exec_command({cmd:\"cat /repo/brief.md; git diff -- /repo/src/file.ts\", workdir:\"/repo\"}) // report mentions /dev/null and /home/roomhacker/excode" },
    });
    expect(activity.paths).toEqual([]);
  });

  it("reserves only the patch target, not paths quoted in the edited report", async () => {
    const activity = await runHook({
      hook_event_name: "PostToolUse", session_id: "writer", cwd: "/repo",
      tool_name: "apply_patch",
      tool_input: { patch: "*** Begin Patch\n*** Update File: execution/report.md\n+Read references: /home/roomhacker/excode, /dev/null, and vi.useRealTimers.\n*** End Patch" },
    });
    expect(activity.paths).toEqual(["/repo/execution/report.md"]);
  });

  it("reserves an explicit file target without scanning its content", async () => {
    const activity = await runHook({
      hook_event_name: "PostToolUse", session_id: "writer", cwd: "/repo",
      tool_name: "write_file",
      tool_input: { path: "src/result.md", content: "Mentioned /another/repo/file.ts and /dev/null for context." },
    });
    expect(activity.paths).toEqual(["/repo/src/result.md"]);
  });

  it.each([
    ["create", "touch /repo/new.ts", ["/repo/new.ts"]],
    ["delete", "rm /repo/old.ts", ["/repo/old.ts"]],
    ["rename", "mv /repo/old.ts /repo/new.ts", ["/repo/old.ts", "/repo/new.ts"]],
    ["git rename", "git mv /repo/old.ts /repo/new.ts", ["/repo/old.ts", "/repo/new.ts"]],
    ["redirection", "printf ok > /repo/output.txt", ["/repo/output.txt"]],
  ])("retains the exact targets for shell %s events", async (_name, command, expected) => {
    const activity = await runHook({
      hook_event_name: "PostToolUse", session_id: "writer", cwd: "/repo",
      tool_name: "Bash", tool_input: { command },
    });
    expect(activity.paths).toEqual(expected);
  });

  it("extracts a write target from the nested exec command, without scanning wrapper text", async () => {
    const activity = await runHook({
      hook_event_name: "PostToolUse", session_id: "writer", cwd: "/repo",
      tool_name: "functions.exec",
      tool_input: { code: "await tools.exec_command({cmd:\"touch /repo/new.ts\", workdir:\"/repo\"}); // unrelated /dev/null" },
    });
    expect(activity.paths).toEqual(["/repo/new.ts"]);
  });

  it("does not infer file reservations from JavaScript expressions, URLs, or quoted prose", async () => {
    const activity = await runHook({
      hook_event_name: "PostToolUse", session_id: "reader", cwd: "/repo",
      tool_name: "functions.exec",
      tool_input: { code: 'const next = request.cursor > event.sequence; const url = "https://example.test/repo/file"; const prose = "touch /repo/mentioned.ts";' },
    });
    expect(activity.paths).toEqual([]);
    const rawCode = await runHook({ hook_event_name: "PostToolUse", session_id: "reader", cwd: "/repo", tool_name: "functions.exec", tool_input: "const next = request.cursor > event.sequence; const update = { path: request.cursor };" });
    expect(rawCode.paths).toEqual([]);
  });

  it("extracts targets from raw patch and raw nested exec inputs", async () => {
    const patchActivity = await runHook({ hook_event_name: "PostToolUse", session_id: "writer", cwd: "/repo", tool_name: "apply_patch", tool_input: "*** Begin Patch\n*** Update File: src/real.ts\n+request.cursor\n*** End Patch" });
    expect(patchActivity.paths).toEqual(["/repo/src/real.ts"]);
    const execActivity = await runHook({ hook_event_name: "PostToolUse", session_id: "writer", cwd: "/repo", tool_name: "functions.exec", tool_input: 'await tools.exec_command({cmd:"touch /repo/real.ts"})' });
    expect(execActivity.paths).toEqual(["/repo/real.ts"]);
  });

  it("ignores redirect characters inside quoted data while keeping the real output file", async () => {
    const activity = await runHook({ hook_event_name: "PostToolUse", session_id: "writer", cwd: "/repo", tool_name: "Bash", tool_input: { command: 'printf "request.cursor > event.sequence" > /repo/real.txt' } });
    expect(activity.paths).toEqual(["/repo/real.txt"]);
  });

  it.each([
    ["does not treat printf arguments as write commands", "printf '%s' touch /repo/mentioned.ts > /repo/real.txt", ["/repo/real.txt"]],
    ["does not split a quoted shell separator", "printf '%s' 'ignored; touch /repo/fake.ts' > /repo/real.txt", ["/repo/real.txt"]],
    ["does not scan for git commands in echo arguments", "echo git rm /repo/mentioned.ts", []],
  ])("%s", async (_name, command, expected) => {
    const activity = await runHook({
      hook_event_name: "PostToolUse", session_id: "writer", cwd: "/repo",
      tool_name: "Bash", tool_input: { command },
    });
    expect(activity.paths).toEqual(expected);
  });
});
