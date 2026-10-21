import { describe, expect, it } from "vitest";
import { NoticeplaceHealthObserver } from "../src/automation/noticeplace-health-observer.js";
import type { SessionDetails } from "../src/types/index.js";

const binding = { incidentId: "inc_test", project: "omniroute-guard" };

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
    const states = [details("running", "Читаю состояние сторожа"), details("running", "Читаю состояние сторожа"), details("idle", "Проверка завершена")];
    let index = 0;
    const published: string[] = [];
    const observer = new NoticeplaceHealthObserver({
      readDetails: async () => states[Math.min(index++, states.length - 1)],
      publish: async (update) => { published.push(update.step); },
      intervalMs: 5,
      maxLifetimeMs: 5_000,
    });
    observer.start({ harness: "opencode", sessionId: "ses_test", cwd: "/tmp", binding });
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
    observer.start(target);
    observer.start(target);
    await new Promise((resolve) => setTimeout(resolve, 60));
    observer.stop();
    expect(published.length).toBe(1);
  });
});
