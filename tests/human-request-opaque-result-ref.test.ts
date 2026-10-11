import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { HumanRequestRegistry } from "../src/human-request/index.js";
import { createWebServer } from "../src/web/server.js";
import type { ResumeReceipt, ResumeTransportRequest } from "../src/resume-transport.js";

// Exact historical Notice selection hash supplied by the consumer incident.
// Its variant F is opaque data, not an RFC UUID. The corrected RFC counterpart
// is a distinct reference and must never replace a stored canonical answer.
const legacy = "6944969d-ac29-5003-fba0-a545f0c2891c";
const rfc = "6944969d-ac29-5003-bba0-a545f0c2891c";
const dirs: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); })));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "herder-opaque-completion-"));
  dirs.push(dir);
  const registry = new HumanRequestRegistry(join(dir, "requests.json"));
  const record = await registry.create({ kind: "user", target: { agent: "opencode", sessionId: "fixture-only", cwd: dir }, answerSource: "notice_question" });
  const admit = vi.spyOn(registry, "admitResume");
  const native = vi.fn(async (request: ResumeTransportRequest): Promise<ResumeReceipt> => ({ status: "accepted", target: request.target, result_ref: request.result_ref, receipt_ref: "fixture://one", idempotency_key: request.idempotency_key }));
  const server = createWebServer({
    adapters: new Map(), converter: { async convert() { throw new Error("unused"); } },
    humanRequests: registry, humanResume: native, sessionObservationManagedExternally: true,
    choiceQuery: async (request) => ({ status: "ambiguous", target: request.target, result_ref: request.result_ref, reason: "native-admission-unknown", idempotency_key: request.idempotency_key }),
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}/internal/human-requests/ask-user-completion`;
  const post = (fields: Record<string, unknown>) => fetch(endpoint, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ event: "ask.user.completed", event_version: 1, status: "completed", request_id: record.requestId, result_ref: legacy, ...fields }),
  });
  return { registry, record, admit, native, post };
}

it.each([legacy, rfc])("admits Notice opaque reference %s once through real HTTP and preserves it on conflicting replay", async (resultRef) => {
  const f = await fixture();
  const responses = await Promise.all(Array.from({ length: 5 }, () => f.post({ result_ref: resultRef })));
  for (const response of responses) {
    expect(response.status).toBe(202);
    const receipt = await response.json();
    expect(receipt.request_id).toBe(f.record.requestId);
    expect(["resumed", "resuming"]).toContain(receipt.status);
    if (receipt.status === "resuming") expect(receipt.in_flight).toBe(true);
  }
  expect(f.native).toHaveBeenCalledTimes(1);
  expect(f.admit).toHaveBeenCalled();
  expect(f.native.mock.calls[0][0]).toMatchObject({ result_ref: resultRef, target: { agent: "opencode", session_id: "fixture-only" } });
  const canonical = (await f.registry.get(f.record.requestId))!;
  expect(canonical.status).toBe("resumed");
  const repeat = await f.post({ result_ref: resultRef === legacy ? rfc : legacy });
  expect(repeat.status).toBe(202);
  expect(await f.registry.get(f.record.requestId)).toEqual(canonical);
  expect(canonical.resultRef).toBe(resultRef);
  expect(f.native).toHaveBeenCalledTimes(1);
});

it("rejects malformed opaque refs and keeps request UUID/event/kind checks before admission", async () => {
  const f = await fixture();
  for (const result_ref of [null, 123, "", "a".repeat(32), legacy + "x", legacy + "\n", " " + legacy, legacy.replace("fba0", "zba0"), legacy.replace("-", "_")]) {
    expect((await f.post({ result_ref })).status).toBe(400);
  }
  // A legacy-shaped value is permitted only as a result ref, never request id.
  for (const request_id of [legacy, rfc.replace("5003", "0003")]) expect((await f.post({ request_id, result_ref: rfc })).status).toBe(400);
  for (const fields of [{ event: "wrong" }, { event_version: 2 }, { status: "pending" }]) expect((await f.post({ ...fields, result_ref: rfc })).status).toBe(400);
  expect((await f.post({ request_id: randomUUID(), result_ref: rfc })).status).toBe(409);
  const wrongKind = await f.registry.create({ kind: "secret", target: f.record.target });
  expect((await f.post({ request_id: wrongKind.requestId, result_ref: rfc })).status).toBe(409);
  expect(f.admit).not.toHaveBeenCalled();
  expect(f.native).not.toHaveBeenCalled();
  expect((await f.registry.get(f.record.requestId))?.status).toBe("pending");
});

it("leaves unknown legacy admission in flight and performs no native replay", async () => {
  const f = await fixture();
  const admission = await f.registry.admitResume(f.record.requestId, { resultRef: legacy });
  const response = await f.post({ result_ref: legacy });
  expect(response.status).toBe(202);
  expect(await response.json()).toMatchObject({ status: "resuming", in_flight: true, idempotency_key: admission.idempotencyKey });
  expect(f.native).not.toHaveBeenCalled();
  expect((await f.registry.get(f.record.requestId))?.resultRef).toBe(legacy);
});
