import { describe, expect, it } from "vitest";
import { NoticeplaceHealthObserver } from "../src/automation/noticeplace-health-observer.js";
import type { SessionDetails } from "../src/types/index.js";

// The incident binding carries the selected plan: the center accepts progress
// only for that plan.
const binding = { incidentId: "inc_test", project: "omniroute-guard", planId: "repair" as const };

function details(status: string, text: string): SessionDetails {
  return {
    session: {
      id: "ses_test", harness: "opencode", status, title: "health", cwd: "/tmp",
      lastActivity: "2026-01-01T00:00:00.000Z", needsPermission: false, messageCount: 1, lastMessage: text,
    },
    lineage: { kind: "root" },
    children: [],
    messages: [{ id: "msg_1", role: "assistant", text, parts: [] }],
    history: { source: "live-cache", complete: true },
  } as unknown as SessionDetails;
}

describe("NoticeplaceHealthObserver", () => {
  it("publishes the live executor step and reports the end of the session", async () => {
    // An idle executor is waiting, not finished: only an explicit terminal
    // status ends the observation.
    const states = [details("running", "Читаю состояние сторожа"), details("running", "Читаю состояние сторожа"), details("idle", "Жду"), details("stopped", "Проверка завершена")];
    let index = 0;
    const published: string[] = [];
    const observer = new NoticeplaceHealthObserver({
      readDetails: async () => states[Math.min(index++, states.length - 1)],
      readActiveTurn: async () => "turn_active",
      publish: async (update) => { published.push(update.step); },
      intervalMs: 5,
      maxLifetimeMs: 5_000,
    });
    await observer.start({ harness: "opencode", sessionId: "ses_test", cwd: "/tmp", binding });
    await new Promise((resolve) => setTimeout(resolve, 150));
    observer.stop();
    expect(published[0]).toContain("Исполнитель работает");
    expect(published.some((step) => step.includes("закончил работу"))).toBe(true);
  });

  it("keeps one observation per session and never resolves the incident", async () => {
    const published: string[] = [];
    const observer = new NoticeplaceHealthObserver({
      readDetails: async () => details("running", "Шаг"),
      publish: async (update) => { published.push(update.step); },
      intervalMs: 5,
      maxLifetimeMs: 5_000,
    });
    const target = { harness: "opencode", sessionId: "ses_once", cwd: "/tmp", binding };
    await observer.start(target);
    await observer.start(target);
    await new Promise((resolve) => setTimeout(resolve, 60));
    observer.stop();
    expect(published.length).toBe(1);
  });
});
