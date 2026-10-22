import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AutomationDisarmStore, automationDisarmEtag } from "../src/automation-disarm/state.js";
import {
  AUTOMATION_FORBIDDEN_CODE,
  automationDisarmDecision,
  projectWorkKey,
  sessionWorkKey,
} from "../src/automation-disarm/index.js";
import { HUMAN_STOP_MESSAGE } from "../src/human-stop-actions.js";

const cleanups: string[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

/** A fresh state directory and the store of it. */
async function store(): Promise<AutomationDisarmStore> {
  const dir = await mkdtemp(join(tmpdir(), "agent-herder-disarm-scopes-"));
  cleanups.push(dir);
  return AutomationDisarmStore.at(dir);
}

/** A real directory, so a scope and a nested scope are both canonical. */
async function workspace(...parts: string[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agent-herder-disarm-area-"));
  cleanups.push(dir);
  let current = await realpath(dir);
  for (const part of parts) {
    current = join(current, part);
    await mkdir(current, { recursive: true });
  }
  return current;
}

describe("the owner lever: one record per scope", () => {
  it("stores one record per scope in the durable file", async () => {
    const durable = await store();
    const area = await workspace();
    const applied = await durable.applyRecord({
      source: "owner",
      scope: area,
      forbidden: true,
      owner: "owner-1",
      reason: "владелец остановил автоматику в проекте",
      policyRevision: '"policy-1"',
    });
    expect(applied.ok).toBe(true);

    // The file on disk is the record format, and the record carries the trail.
    const raw = JSON.parse(await readFile(durable.path, "utf8")) as {
      version: number;
      records: Array<Record<string, unknown>>;
      changedAt: string;
      changedBy: string;
    };
    expect(raw.version).toBe(2);
    expect(raw.changedBy).toBe("owner");
    expect(typeof raw.changedAt).toBe("string");
    expect(raw.records).toHaveLength(1);
    expect(raw.records[0]).toMatchObject({
      scope: area,
      forbidden: true,
      owner: "owner-1",
      reason: "владелец остановил автоматику в проекте",
      policyRevision: '"policy-1"',
    });
    expect(typeof raw.records[0]!.createdAt).toBe("string");
  });

  it("keeps the records ordered by scope", async () => {
    const durable = await store();
    const first = await workspace("a");
    const second = await workspace("b");
    await durable.applyRecord({ source: "owner", scope: second, forbidden: true });
    await durable.applyRecord({ source: "owner", scope: first, forbidden: true });
    const state = await durable.read();
    const scopes = state.records.map((record) => record.scope);
    // The implementation orders the scopes with localeCompare, so the
    // expectation uses the same collation: the default sort compares the
    // random part of a temporary path differently and would flake.
    expect(scopes).toEqual([...scopes].sort((left, right) => left.localeCompare(right)));
    expect(scopes).toHaveLength(2);
  });

  it("replaces the record of the scope and keeps the other scopes", async () => {
    const durable = await store();
    const first = await workspace("a");
    const second = await workspace("b");
    await durable.applyRecord({ source: "owner", scope: first, forbidden: true });
    await durable.applyRecord({ source: "owner", scope: second, forbidden: true });
    const applied = await durable.applyRecord({ source: "owner", scope: first, forbidden: false });
    expect(applied.ok).toBe(true);
    const state = await durable.read();
    expect(state.records).toHaveLength(2);
    expect(state.records.find((record) => record.scope === first)?.forbidden).toBe(false);
    expect(state.records.find((record) => record.scope === second)?.forbidden).toBe(true);
  });

  it("lets an explicit permission win over the earlier prohibition of the same scope", async () => {
    const durable = await store();
    const area = await workspace();
    await durable.applyRecord({ source: "owner", scope: area, forbidden: true });
    const blocked = await automationDisarmDecision(durable, [sessionWorkKey("opencode", "card", area)], "automation");
    expect(blocked.allowed).toBe(false);

    // The owner permits the same scope: the permission wins.
    await durable.applyRecord({ source: "owner", scope: area, forbidden: false });
    const allowed = await automationDisarmDecision(durable, [sessionWorkKey("opencode", "card", area)], "automation");
    expect(allowed.allowed).toBe(true);
    expect((await durable.read()).records).toHaveLength(1);
  });

  it("lets a permission of one project lift the catch-all prohibition for it", async () => {
    const durable = await store();
    const area = await workspace();
    const other = await workspace();
    await durable.applyRecord({ source: "owner", scope: "*", forbidden: true });
    await durable.applyRecord({ source: "owner", scope: area, forbidden: false });

    const permitted = await automationDisarmDecision(durable, [sessionWorkKey("opencode", "card", area)], "automation");
    expect(permitted.allowed).toBe(true);
    // Everything else is still forbidden.
    const refused = await automationDisarmDecision(durable, [sessionWorkKey("opencode", "card", other)], "automation");
    expect(refused.allowed).toBe(false);
  });

  it("refuses an automatic attempt to change a record", async () => {
    const durable = await store();
    const area = await workspace();
    await durable.applyRecord({ source: "owner", scope: area, forbidden: true });
    const attempt = await durable.applyRecord({ source: "automation", scope: area, forbidden: false });
    expect(attempt.ok).toBe(false);
    expect(attempt.code).toBe("automation_cannot_change_disarm");
    // The refusal changed nothing.
    expect((await durable.read()).records.find((record) => record.scope === area)?.forbidden).toBe(true);
  });

  it("expands the earlier flat format into records without losing anything", async () => {
    const durable = await store();
    const area = await workspace();
    await writeFile(durable.path, JSON.stringify({
      version: 1,
      disarmed: true,
      changedAt: "2026-10-01T00:00:00.000Z",
      changedBy: "owner",
      reason: "остановка",
      blockedWorkKeys: [sessionWorkKey("opencode", "card", area)],
    }), "utf8");

    const state = await durable.read();
    // The flat lever became the catch-all record.
    expect(state.records.some((record) => record.scope === "*" && record.forbidden === true)).toBe(true);
    // The named work became a record of the scope it belongs to.
    const named = state.records.find((record) => record.workKeys?.length);
    expect(named?.scope).toBe(area);
    expect(named?.workKeys).toEqual([sessionWorkKey("opencode", "card", area)]);
    // The flat mirror still reads as the lever of the earlier format.
    expect(state.disarmed).toBe(true);
    expect(state.blockedWorkKeys).toEqual([sessionWorkKey("opencode", "card", area)]);
  });

  it("reads a corrupt file as forbidden", async () => {
    const durable = await store();
    await writeFile(durable.path, "{not json", "utf8");
    const state = await durable.read();
    expect(state.disarmed).toBe(true);
    expect(state.reason).toContain("повреждён");
    const decision = await automationDisarmDecision(durable, [sessionWorkKey("opencode", "card", "/tmp")], "automation");
    expect(decision.allowed).toBe(false);
  });
});

describe("the owner lever: the scope of a request", () => {
  it("forbids every area for the catch-all scope", async () => {
    const durable = await store();
    const area = await workspace();
    await durable.applyRecord({ source: "owner", scope: "*", forbidden: true });
    const decision = await automationDisarmDecision(durable, [sessionWorkKey("opencode", "card", area)], "automation");
    expect(decision.allowed).toBe(false);
    expect(decision.scope).toBe("*");
  });

  it("covers the project itself and the directories inside it", async () => {
    const durable = await store();
    const project = await workspace();
    const nested = await workspace();
    await durable.applyRecord({ source: "owner", scope: project, forbidden: true });

    // The project itself is covered.
    const inProject = await automationDisarmDecision(durable, [sessionWorkKey("opencode", "card", project)], "automation");
    expect(inProject.allowed).toBe(false);
    expect(inProject.scope).toBe(project);

    // A directory inside the project is covered as well.
    await mkdir(join(project, "sub"), { recursive: true });
    const inside = join(project, "sub");
    const inNested = await automationDisarmDecision(durable, [sessionWorkKey("opencode", "card", inside)], "automation");
    expect(inNested.allowed).toBe(false);
    expect(inNested.scope).toBe(project);

    // Another project is not covered.
    const elsewhere = await automationDisarmDecision(durable, [sessionWorkKey("opencode", "card", nested)], "automation");
    expect(elsewhere.allowed).toBe(true);
  });

  it("keeps the named works of a scope a finer boundary inside it", async () => {
    const durable = await store();
    const project = await workspace();
    const named = sessionWorkKey("opencode", "card", project);
    await durable.applyRecord({ source: "owner", scope: project, forbidden: true, workKeys: [named] });

    // The named work is refused.
    const refused = await automationDisarmDecision(durable, [named], "automation");
    expect(refused.allowed).toBe(false);
    expect(refused.workKey).toBe(named);

    // Another work of the same project is not: the boundary is finer.
    const other = await automationDisarmDecision(durable, [sessionWorkKey("opencode", "other", project)], "automation");
    expect(other.allowed).toBe(true);
  });

  it("matches a project dispatch by its project path", async () => {
    const durable = await store();
    const project = await workspace();
    await durable.applyRecord({ source: "owner", scope: project, forbidden: true });
    const decision = await automationDisarmDecision(durable, [projectWorkKey(project)], "automation");
    expect(decision.allowed).toBe(false);
  });

  it("keeps the blocked work of the earlier format blocked", async () => {
    const durable = await store();
    // The earlier format named the work and not a path, and a project that
    // is named and not a path belongs to the catch-all area. The catch-all
    // is not a path, so it must not be canonicalized as one: a scope of
    // "<cwd>/*" covers nothing and the blocked work would keep running.
    const named = projectWorkKey("omniroute-guard");
    await durable.apply({ source: "owner", disarmed: false, workKeys: [named] });

    const refused = await automationDisarmDecision(durable, [named], "automation");
    expect(refused.allowed).toBe(false);
    expect(refused.code).toBe(AUTOMATION_FORBIDDEN_CODE);
    expect(refused.workKey).toBe(named);
    // The area of a work without a path of its own is the catch-all.
    expect(refused.routingReasonDetail).toBe("*");

    // Another work of the same contour is not blocked by that one.
    const other = await automationDisarmDecision(durable, [projectWorkKey("other-guard")], "automation");
    expect(other.allowed).toBe(true);
  });
});

describe("the owner lever: the machine-readable refusal", () => {
  it("carries one stable code, distinct from the human stop message", async () => {
    const durable = await store();
    const area = await workspace();
    await durable.applyRecord({ source: "owner", scope: area, forbidden: true });
    const decision = await automationDisarmDecision(durable, [sessionWorkKey("opencode", "card", area)], "automation");
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe(AUTOMATION_FORBIDDEN_CODE);
    expect(decision.code).toBe("automation_disabled");
    // The human stop says something else entirely: this chat was stopped by
    // a person, that lever was lifted by the owner for a whole area.
    expect(decision.reason).not.toBe(HUMAN_STOP_MESSAGE);
    expect(decision.reason).toContain("запрещён владельцем");
    // The area travels beside the code as a field of its own.
    expect(decision.routingReasonDetail).toBe(area);
    // The wording is not the carrier of the area.
    expect(decision.reason).not.toContain(area);
  });

  it("gives every refusal of the lever the same code", async () => {
    const durable = await store();
    const area = await workspace();
    await durable.applyRecord({ source: "owner", scope: "*", forbidden: true });
    const catchAll = await automationDisarmDecision(durable, [sessionWorkKey("opencode", "card", area)], "automation");
    const named = await automationDisarmDecision(durable, [sessionWorkKey("opencode", "card", area)], "automation");
    expect(catchAll.code).toBe(AUTOMATION_FORBIDDEN_CODE);
    expect(named.code).toBe(AUTOMATION_FORBIDDEN_CODE);
  });

  it("names the area of every refusal as a structured value", async () => {
    const area = await workspace();
    const project = await workspace("sub");
    const named = sessionWorkKey("opencode", "card", project);

    // The whole contour keeps the literal of the catch-all scope.
    const whole = await store();
    await whole.applyRecord({ source: "owner", scope: "*", forbidden: true });
    const everywhere = await automationDisarmDecision(whole, [sessionWorkKey("opencode", "card", area)], "automation");
    expect(everywhere.routingReasonDetail).toBe("*");

    // A project area is named by its canonical path.
    const byProject = await store();
    await byProject.applyRecord({ source: "owner", scope: project, forbidden: true });
    const projectArea = await automationDisarmDecision(byProject, [named], "automation");
    expect(projectArea.routingReasonDetail).toBe(project);

    // A record with named works names the same area beside the code.
    const byWork = await store();
    await byWork.applyRecord({ source: "owner", scope: project, forbidden: true, workKeys: [named] });
    const workArea = await automationDisarmDecision(byWork, [named], "automation");
    expect(workArea.routingReasonDetail).toBe(project);
    expect(workArea.workKey).toBe(named);
  });
});

describe("the owner lever: the revision of the state", () => {
  it("changes with the state and stays the same without a change", async () => {
    const durable = await store();
    const area = await workspace();
    const before = automationDisarmEtag(await durable.read());
    await durable.applyRecord({ source: "owner", scope: area, forbidden: true });
    const after = automationDisarmEtag(await durable.read());
    expect(after).not.toBe(before);
    expect(automationDisarmEtag(await durable.read())).toBe(after);
  });

  it("refuses a write whose expected revision does not match", async () => {
    const durable = await store();
    const area = await workspace();
    await durable.applyRecord({ source: "owner", scope: area, forbidden: true });
    const stale = automationDisarmEtag(await durable.read());
    await durable.applyRecord({ source: "owner", scope: area, forbidden: false });
    const refused = await durable.applyRecord({ source: "owner", scope: area, forbidden: true, ifMatch: stale });
    expect(refused.ok).toBe(false);
    expect(refused.code).toBe("state_conflict");
    // Nothing was written: the state still holds the permission.
    expect((await durable.read()).records.find((record) => record.scope === area)?.forbidden).toBe(false);
  });
});
