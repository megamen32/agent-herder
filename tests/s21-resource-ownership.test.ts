import { describe, expect, it } from "vitest";
import { getS21Ownership, parseS21Ownership } from "../src/s21-resource-ownership.js";
import { s21OwnershipView } from "../src/web-ui/s21-ownership-view.js";
import { registerResourceOwnershipTools } from "../src/mcp/resource-ownership-tools.js";
const held = { status: "held", owner: "Ремонт APK", purpose: "Проверка установки", expires_at: "2026-10-12T03:00:00Z", remaining_seconds: 120 };
describe("S21 ownership (fast unit; expected .1s/max 5s; no phone)", () => {
  it("redacts capabilities and constructs the exact encoded native session link", () => {
    const result = parseS21Ownership(JSON.stringify({ ...held, lease_id: "secret", actor: { type: "agent", harness: "codex", session_id: "exact-id", session_url: "https://evil", lease_id: "nested-secret" } }));
    expect(result.actor?.sessionUrl).toBe("https://agent.bezrabotnyi.com/#/session/codex%3Aexact-id");
    expect(JSON.stringify(result)).not.toMatch(/secret|evil|lease_id/);
    expect(s21OwnershipView(result).href).toBe(result.actor?.sessionUrl);
  });
  it("shows legacy ownership honestly without guessing a harness/session", () => {
    const result = parseS21Ownership(JSON.stringify(held));
    expect(result.actor?.type).toBe("legacy"); expect(result.actor?.sessionId).toBeNull();
    expect(s21OwnershipView(result)).toMatchObject({ href: null, detail: expect.stringContaining("Сессия не записана") });
  });
  it("distinguishes system invocation from an agent session", () => {
    const result = parseS21Ownership(JSON.stringify({ ...held, actor: { type: "system", system_unit: "sip.service", invocation_id: "a".repeat(32) } }));
    expect(result.actor?.systemUnit).toBe("sip.service");expect(result.actor?.sessionUrl).toBeNull();
  });
  it("never represents read failure, corrupt state or unknown status as free", async () => {
    for (const raw of ['{"status":"error"}', '{', JSON.stringify({ ...held, actor: {} }), JSON.stringify({ ...held, actor: { type: "agent", harness: "codex" } })]) {
      expect((await getS21Ownership(async () => raw)).status).toBe("unavailable");
    }
    const result = await getS21Ownership(async () => { throw new Error("secret error"); });
    expect(s21OwnershipView(result).label).toBe("Проверка телефона недоступна");
    expect(JSON.stringify(result)).not.toContain("secret error");
  });
  it("keeps free status capability and actor free", () => {
    const result = parseS21Ownership('{"status":"free","lease_id":"secret","actor":{"session_id":"stale"}}');
    expect(result.actor).toBeNull();expect(s21OwnershipView(result).label).toBe("Телефон свободен");
  });
  it("registers only a strict readonly MCP tool", () => {
    const calls: any[]=[];
    registerResourceOwnershipTools({ registerTool: (...args: any[]) => calls.push(args) } as any);
    expect(calls).toHaveLength(1);expect(calls[0][0]).toBe("s21_lease_status");
    expect(calls[0][1].inputSchema.safeParse({ acquire: true }).success).toBe(false);
    expect(calls[0][1].annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
  });
});
