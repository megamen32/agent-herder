import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  composeSessionTitle,
  readSessionLabel,
  resetSessionLabelCache,
  withSessionLabelMeta,
  writeSessionLabel,
  SESSION_LABEL_LIMITS,
} from "../src/session-labels.js";
import type { AgentSession } from "../src/types/index.js";

const roots: string[] = [];
let previousPath: string | undefined;

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-herder-session-labels-"));
  roots.push(root);
  previousPath = process.env.AGENT_HERDER_SESSION_LABELS;
  process.env.AGENT_HERDER_SESSION_LABELS = join(root, "session-labels.json");
  resetSessionLabelCache();
});

afterEach(async () => {
  if (previousPath === undefined) delete process.env.AGENT_HERDER_SESSION_LABELS;
  else process.env.AGENT_HERDER_SESSION_LABELS = previousPath;
  resetSessionLabelCache();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("The session labels of Herder", () => {
  it("composes the readable title as project | goal | stage", () => {
    expect(composeSessionTitle({ project: "Notice Place", goal: "голосовой секретарь", stage: "координация" }))
      .toBe("Notice Place | голосовой секретарь | координация");
  });

  it("skips a field that is not known instead of leaving an empty gap", () => {
    expect(composeSessionTitle({ project: "LHC" })).toBe("LHC");
    expect(composeSessionTitle({ goal: "понятные планы", stage: "завершение релиза" }))
      .toBe("понятные планы | завершение релиза");
    expect(composeSessionTitle({})).toBe("");
  });

  it("keeps the other fields when one field is updated", async () => {
    await writeSessionLabel("codex", "session-1", { project: "ExManager", goal: "команды и поручения", stage: "приёмка" });
    await writeSessionLabel("codex", "session-1", { stage: "релиз" });
    await expect(readSessionLabel("codex", "session-1")).resolves.toEqual({
      project: "ExManager",
      goal: "команды и поручения",
      stage: "релиз",
    });
  });

  it("keeps the labels durable across a fresh read of the file", async () => {
    await writeSessionLabel("codex", "session-2", { project: "GPT Admin", goal: "история запусков", stage: "исправление UI" });
    resetSessionLabelCache();
    await expect(readSessionLabel("codex", "session-2")).resolves.toMatchObject({ project: "GPT Admin" });
    const raw = await readFile(process.env.AGENT_HERDER_SESSION_LABELS!, "utf8");
    expect(raw).toContain("GPT Admin");
  });

  it("refuses a value that does not fit instead of cutting it", async () => {
    const tooLong = "я".repeat(SESSION_LABEL_LIMITS.goal + 1);
    await expect(writeSessionLabel("codex", "session-3", { goal: tooLong })).rejects.toThrow(/longer than/);
    await expect(readSessionLabel("codex", "session-3")).resolves.toEqual({});
  });

  it("carries the fields inside the metadata of the session", async () => {
    await writeSessionLabel("codex", "session-4", { project: "Account Broker", goal: "AFC и TGC", stage: "миграция" });
    const session: AgentSession = {
      id: "session-4", harness: "codex", status: "idle", title: "Account Broker | AFC и TGC | миграция",
      cwd: "/tmp", hostId: "roomhacker-server-100", lastActivity: new Date(0).toISOString(), needsPermission: false,
      meta: { nativeSessionId: "session-4" },
    };
    expect(withSessionLabelMeta(session).meta).toMatchObject({
      nativeSessionId: "session-4",
      project: "Account Broker",
      goal: "AFC и TGC",
      stage: "миграция",
    });
  });
});
