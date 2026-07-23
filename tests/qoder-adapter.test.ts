import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QoderAdapter } from "../src/adapters/qoder.js";
import { AcpAdapter } from "../src/adapters/acp.js";

const fixture = join(process.cwd(), "tests/fixtures/fake-qodercli.mjs");
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("Qoder adapter", () => {
  it("reads Qoder sessions and applies a selected model to the next prompt", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-qoder-"));
    const counterFile = join(root, "methods.log");
    const qoderDir = join(root, ".qoder");
    const projectDir = join(qoderDir, "projects", "workspace");
    await mkdir(projectDir, { recursive: true });
    await writeFile(join(projectDir, "qs_test.jsonl"), [
      JSON.stringify({ type: "user", timestamp: "2026-07-19T00:00:00.000Z", cwd: root, message: { role: "user", content: "Inspect the project" } }),
      JSON.stringify({ type: "assistant", timestamp: "2026-07-19T00:01:00.000Z", cwd: root, message: { role: "assistant", model: "Lite", content: [{ type: "text", text: "I inspected it." }] } }),
    ].join("\n") + "\n");
    const adapter = new QoderAdapter({
      qoderBin: process.execPath,
      qoderArgs: [fixture],
      qoderDir,
      env: { FAKE_QODER_COUNTER: counterFile },
    });
    cleanups.push(async () => {
      await rm(root, { recursive: true, force: true });
    });

    await adapter.init();
    expect(await adapter.listModels()).toEqual(["Ultimate", "Lite"]);
    const sessions = await adapter.listSessions();
    expect(sessions[0]).toMatchObject({ harness: "qoder", id: "qs_test", cwd: root, model: "Lite" });

    expect(await adapter.changeModel!(sessions[0].id, "Ultimate")).toEqual({ ok: true });
    expect(await adapter.sendMessage(sessions[0].id, { message: "Continue", queue: false })).toEqual({ ok: true });
    expect(await readFile(counterFile, "utf8")).toContain("--model Ultimate");
  });

  it("can use Qoder's native ACP transport for existing sessions and model changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-qoder-acp-"));
    const adapter = new AcpAdapter({
      profile: "qoder",
      harness: "qoder",
      command: process.execPath,
      args: [join(process.cwd(), "tests/fixtures/fake-acp-agent.mjs")],
      cwd: root,
      modelIds: ["Lite", "Ultimate"],
    });
    cleanups.push(async () => {
      await adapter.dispose();
      await rm(root, { recursive: true, force: true });
    });

    await adapter.init();
    const sessions = await adapter.listSessions();
    expect(sessions[0]).toMatchObject({ harness: "qoder", id: "acp:qoder:fake-session-1" });
    expect(await adapter.changeModel!(sessions[0].id, "Lite")).toEqual({ ok: true });
  });
});
