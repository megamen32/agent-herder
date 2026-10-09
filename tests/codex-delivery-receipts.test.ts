import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CodexDeliveryReceipts } from "../src/adapters/codex-delivery-receipts.js";

describe("Codex delivery anti-replay retention", () => {
  it.each([false, true])("does not evict old accepted/uncertain receipt (uncertain=%s)", async unknown => {
        const root = await mkdtemp(join(tmpdir(), "codex-permanent-receipt-"));
    try {
      const key = createHash("sha256").update("owned\0stable-input").digest("hex");
      const result = unknown ? { ok: false, admissionUnknown: true, nonRetryable: true }
        : { ok: true, admitted: true, turnId: "accepted-turn", inputId: "stable-input" };
      await writeFile(join(root, "herder-delivery-receipts.json"), JSON.stringify({
        [key]: { at: Date.now() - 3 * 86400_000, result },
      }), { mode: 0o600 });
      const dispatch = vi.fn();
      expect(await new CodexDeliveryReceipts(root).once("owned", "stable-input", dispatch)).toEqual(result);
      expect(dispatch).not.toHaveBeenCalled();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("rejects new admission at finite capacity without deleting or dispatching", async () => {
        const root = await mkdtemp(join(tmpdir(), "codex-full-receipts-"));
    try {
      const records = Object.fromEntries(Array.from({ length: 2048 }, (_, index) => [
        String(index), { at: Date.now() - 3 * 86400_000, result: { ok: false, admissionUnknown: true, nonRetryable: true } },
      ]));
      const path = join(root, "herder-delivery-receipts.json");
      await writeFile(path, JSON.stringify(records), { mode: 0o600 });
      const before = await readFile(path, "utf8"), dispatch = vi.fn();
      expect(await new CodexDeliveryReceipts(root).once("owned", "new-input", dispatch))
        .toMatchObject({ ok: false, nonRetryable: true });
      expect(dispatch).not.toHaveBeenCalled();
      expect(await readFile(path, "utf8")).toBe(before);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
