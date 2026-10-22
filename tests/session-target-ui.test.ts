import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { sessionTargetOutcome, workTargetHostLabel, workTargetRequestBody, type SessionTargetReceipt } from "../src/web-ui/session-work-target.js";

const component = readFileSync(new URL("../src/web-ui/session-work-target.tsx", import.meta.url), "utf8");
const main = readFileSync(new URL("../src/web-ui/main.tsx", import.meta.url), "utf8");

const receipt = (overrides: Partial<SessionTargetReceipt> = {}): SessionTargetReceipt => ({
  sessionId: "s1",
  harness: "codex",
  hostId: "roomhacker-server-100",
  cwd: "/work/dir",
  previous: { hostId: "roomhacker-server-100", cwd: "/launch/dir" },
  state: "updated",
  ...overrides,
});

describe("work target block of the chat", () => {
  it("shows the machine and the directory of the selected session", () => {
    expect(component).toContain("РАБОЧАЯ МАШИНА");
    expect(component).toContain('aria-label="Рабочая машина"');
    expect(component).toContain('aria-label="Рабочий каталог"');
    expect(component).toContain("Каталог:");
    expect(component).toContain("workTargetHostLabel(hosts, current.hostId)");
  });

  it("offers the known machines and any other host id", () => {
    expect(component).toContain("knownHosts.map");
    expect(component).toContain("Другая машина…");
    expect(component).toContain('aria-label="Идентификатор рабочей машины"');
  });

  it("applies through the shared route and refreshes the session", () => {
    expect(component).toContain('fetch("/api/session-target"');
    expect(component).toContain("onApplied?.(receipt)");
    expect(main).toContain("<SessionWorkTarget");
    expect(main).toContain("void loadSessions(); if (activeKey) void loadDetails(activeKey);");
  });

  it("keeps the old place when the server refused the change", () => {
    expect(component).toContain('if (receipt.state !== "updated") return;');
  });
});

describe("work target result", () => {
  it("reports an applied target as updated", () => {
    expect(sessionTargetOutcome(receipt({ state: "updated" }))).toEqual({
      state: "updated",
      message: "Рабочая машина и каталог обновлены",
      tone: "ok",
    });
  });

  it("reports the same target as unchanged", () => {
    expect(sessionTargetOutcome(receipt({ state: "unchanged" }))).toEqual({
      state: "unchanged",
      message: "Ничего не изменилось",
      tone: "neutral",
    });
  });

  it("names an unreachable machine and its reason", () => {
    const outcome = sessionTargetOutcome(receipt({ state: "unreachable", reason: "host_target_unavailable:server-44" }));
    expect(outcome.message).toBe("Машина недоступна: host_target_unavailable:server-44");
    expect(outcome.tone).toBe("error");
  });

  it("names a machine that cannot change its work place and its reason", () => {
    const outcome = sessionTargetOutcome(receipt({ state: "unsupported", reason: "harness_does_not_move" }));
    expect(outcome.message).toBe("Эта машина не поддерживает смену рабочего места: harness_does_not_move");
    expect(outcome.tone).toBe("error");
  });

  it("never presents a refused target as a success", () => {
    expect(sessionTargetOutcome(receipt({ state: "unreachable" })).message).not.toContain("обновлены");
    expect(sessionTargetOutcome(receipt({ state: "unsupported" })).message).not.toContain("обновлены");
  });
});

describe("work target form", () => {
  it("labels a known machine and keeps the raw id next to it", () => {
    expect(workTargetHostLabel([{ hostId: "server-44", label: "44" }], "server-44")).toBe("44");
    expect(workTargetHostLabel([{ hostId: "server-44", label: "44" }], "mac-mini")).toBe("mac-mini");
  });

  it("leaves an empty field out of the request", () => {
    expect(workTargetRequestBody({ id: "s1", harness: "codex" }, "server-44", " /work/dir ")).toEqual({
      sessionId: "s1",
      harness: "codex",
      hostId: "server-44",
      cwd: "/work/dir",
    });
    expect(workTargetRequestBody({ id: "s1", harness: "codex" }, "", "")).toEqual({ sessionId: "s1", harness: "codex" });
  });
});
