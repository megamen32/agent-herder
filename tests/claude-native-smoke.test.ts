import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ClaudeSDKAdapter } from "../src/adapters/claude-sdk.js";
import { handleCreateSession } from "../src/mcp-tools/handlers.js";

it.skipIf(process.env.HERDER_CLAUDE_SMOKE !== "1")("creates, reads, stops and resumes a native named Claude session", async () => {
  const adapter = new ClaudeSDKAdapter();
  const adapters = new Map([["claude", adapter]]);
  const cwd = await mkdtemp(join(tmpdir(), "herder-claude-smoke-"));
  const request = { harness: "claude", cwd, name: "Herder SDK smoke", permissionMode: "plan", effort: "medium", thinkingBudget: 4096 };
  const created = JSON.parse(await handleCreateSession(adapters, request));
  expect(created).toMatchObject({ ok: true, created: true, ready: true });
  const id = created.sessionId;
  try {
    expect(JSON.parse(await handleCreateSession(adapters, request))).toMatchObject({ ok: true, created: false, sessionId: id });
    expect(await adapter.listSessions({ cwd })).toContainEqual(expect.objectContaining({ id, title: request.name }));
    expect((await adapter.getSession(id))?.meta?.effectiveSettings).toMatchObject({ permissionMode: "plan", effort: "medium", thinkingBudget: 4096 });
    expect(await adapter.getRawTranscript(id)).toMatchObject({ complete: true });
    expect(await adapter.stopSession(id)).toMatchObject({ ok: true });
    expect(await adapter.resumeSession(id)).toMatchObject({ ok: true });
    if (process.env.HERDER_CLAUDE_MODEL_SMOKE !== "1") return;
    const result = await adapter.sendMessage(id, { message: "Reply exactly HERDER_OK. Do not use any tools." });
    expect(result).toMatchObject({ ok: true });
    expect(await adapter.getSessionMessages(id)).toContainEqual(expect.objectContaining({ role: "assistant", text: "HERDER_OK" }));
  } finally { await adapter.stopSession(id); }
}, 90_000);
