import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WakeBindingStore } from "../src/chatgpt-wake-binding.js";

async function store() {
  const dir = await mkdtemp(join(tmpdir(), "wake-binding-"));
  return new WakeBindingStore({ filePath: join(dir, "bindings.json"), maxUses: 2 });
}

describe("chatgpt wake binding store", () => {
  it("verifies the exact secret and returns the validated owner", async () => {
    const bindings = await store();
    await bindings.register({ bindingId: "wb-1", secret: "s".repeat(20), owner: { harness: "opencode", sessionId: "ses_owner" } });
    const owner = await bindings.verify({ bindingId: "wb-1", secret: "s".repeat(20) });
    expect(owner).toEqual({ harness: "opencode", sessionId: "ses_owner" });
  });

  it("fails closed on wrong secret, unknown id, and exhausted budget", async () => {
    const bindings = await store();
    await bindings.register({ bindingId: "wb-2", secret: "a".repeat(20), owner: { harness: "zcode", sessionId: "zc1" }, maxUses: 2 });
    await expect(bindings.verify({ bindingId: "wb-2", secret: "b".repeat(20) })).rejects.toThrow("chatgpt_wake_binding_unverified");
    await expect(bindings.verify({ bindingId: "wb-missing", secret: "a".repeat(20) })).rejects.toThrow("chatgpt_wake_binding_unverified");
    expect(await bindings.verify({ bindingId: "wb-2", secret: "a".repeat(20) })).toEqual({ harness: "zcode", sessionId: "zc1" });
    expect(await bindings.verify({ bindingId: "wb-2", secret: "a".repeat(20) })).toEqual({ harness: "zcode", sessionId: "zc1" });
    await expect(bindings.verify({ bindingId: "wb-2", secret: "a".repeat(20) })).rejects.toThrow("chatgpt_wake_binding_unverified");
  });

  it("rejects weak secrets and replaces bindings with the same id", async () => {
    const bindings = await store();
    await expect(bindings.register({ bindingId: "wb-3", secret: "short", owner: { harness: "codex", sessionId: "t1" } })).rejects.toThrow("binding_secret_invalid");
    await bindings.register({ bindingId: "wb-3", secret: "a".repeat(20), owner: { harness: "codex", sessionId: "t-old" } });
    await bindings.register({ bindingId: "wb-3", secret: "b".repeat(20), owner: { harness: "codex", sessionId: "t-new" } });
    await expect(bindings.verify({ bindingId: "wb-3", secret: "a".repeat(20) })).rejects.toThrow("chatgpt_wake_binding_unverified");
    expect(await bindings.verify({ bindingId: "wb-3", secret: "b".repeat(20) })).toEqual({ harness: "codex", sessionId: "t-new" });
  });

  it("persists the store without ever writing the secret in clear text", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wake-binding-"));
    const filePath = join(dir, "bindings.json");
    const bindings = new WakeBindingStore({ filePath });
    const secret = "clear-secret-value-12345";
    await bindings.register({ bindingId: "wb-4", secret, owner: { harness: "opencode", sessionId: "ses_x" } });
    const raw = await (await import("node:fs/promises")).readFile(filePath, "utf8");
    expect(raw).not.toContain(secret);
    expect(await bindings.verify({ bindingId: "wb-4", secret })).toEqual({ harness: "opencode", sessionId: "ses_x" });
  });

  it("delivers one job exactly once through a binding", async () => {
    const bindings = await store();
    await bindings.register({ bindingId: "wb-5", secret: "c".repeat(20), owner: { harness: "opencode", sessionId: "ses_job" }, maxUses: 5 });
    expect(await bindings.verifyOnceForJob({ bindingId: "wb-5", secret: "c".repeat(20), jobId: "job-1" }))
      .toEqual({ harness: "opencode", sessionId: "ses_job" });
    await expect(bindings.verifyOnceForJob({ bindingId: "wb-5", secret: "c".repeat(20), jobId: "job-1" }))
      .rejects.toThrow("chatgpt_wake_delivery_already_done");
    expect(await bindings.verifyOnceForJob({ bindingId: "wb-5", secret: "c".repeat(20), jobId: "job-2" }))
      .toEqual({ harness: "opencode", sessionId: "ses_job" });
  });

  it("keeps working after a failed verification", async () => {
    const bindings = await store();
    await bindings.register({ bindingId: "wb-6", secret: "d".repeat(20), owner: { harness: "zcode", sessionId: "zc9" } });
    await expect(bindings.verify({ bindingId: "wb-6", secret: "e".repeat(20) })).rejects.toThrow("chatgpt_wake_binding_unverified");
    expect(await bindings.verify({ bindingId: "wb-6", secret: "d".repeat(20) })).toEqual({ harness: "zcode", sessionId: "zc9" });
  });
});
