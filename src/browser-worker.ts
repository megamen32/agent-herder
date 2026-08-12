import { z } from "zod";

const opaqueRef = z.string().trim().min(1).max(256).regex(/^[A-Za-z0-9._:/=-]+$/, "opaque references must stay compact and printable");
const boundedTimestamp = z.string().max(64).regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/, "timestamps must be UTC ISO-8601");

export const BrowserWorkerErrorClassSchema = z.enum([
  "worker_unavailable",
  "worker_timeout",
  "worker_rejected",
  "browser_session_not_found",
  "browser_action_failed",
  "invalid_receipt",
  "receipt_mismatch",
]);

export type BrowserWorkerErrorClass = z.infer<typeof BrowserWorkerErrorClassSchema>;

export const BrowserWorkerTemplateIdSchema = z.enum([
  "secretary.inbox.v1",
  "secretary.browser-canary.v1",
]);

export type BrowserWorkerTemplateId = z.infer<typeof BrowserWorkerTemplateIdSchema>;

export const BrowserWorkerRequestSchema = z.object({
  schema: z.literal("agent-herder.browser-worker.v1"),
  worker: z.literal("mac-mini-browserclaw"),
  target: z.literal("E-Frontier"),
  templateId: BrowserWorkerTemplateIdSchema,
  sourceRefs: z.array(opaqueRef).min(1).max(8),
  runId: opaqueRef,
  idempotencyId: opaqueRef,
  deadlineMs: z.number().int().min(1).max(10 * 60 * 1000),
}).strict();

export const BrowserWakeSchema = BrowserWorkerRequestSchema;

export type BrowserWorkerRequest = z.infer<typeof BrowserWorkerRequestSchema>;

export const BrowserWorkerReceiptSchema = z.object({
  worker: z.literal("mac-mini-browserclaw"),
  target: z.literal("E-Frontier"),
  templateId: BrowserWorkerTemplateIdSchema,
  runId: opaqueRef,
  idempotencyId: opaqueRef,
  receiptRef: opaqueRef,
  status: z.enum(["completed", "failed"]),
  acceptedAt: boundedTimestamp,
  completedAt: boundedTimestamp.optional(),
  failedAt: boundedTimestamp.optional(),
  errorClass: BrowserWorkerErrorClassSchema.optional(),
}).strict().superRefine((receipt, context) => {
  if (receipt.status === "completed" && !receipt.completedAt) {
    context.addIssue({ code: "custom", path: ["completedAt"], message: "completed receipts require completedAt" });
  }
  if (receipt.status === "completed" && (receipt.failedAt || receipt.errorClass)) {
    context.addIssue({ code: "custom", path: ["status"], message: "completed receipts cannot contain failure fields" });
  }
  if (receipt.status === "failed" && (!receipt.failedAt || !receipt.errorClass)) {
    context.addIssue({ code: "custom", path: ["failedAt"], message: "failed receipts require failedAt and errorClass" });
  }
  if (receipt.status === "failed" && receipt.completedAt) {
    context.addIssue({ code: "custom", path: ["completedAt"], message: "failed receipts cannot contain completedAt" });
  }
});

export type BrowserWorkerReceipt = z.infer<typeof BrowserWorkerReceiptSchema>;

export interface BrowserWorkerClient {
  /**
   * Implementations must durably deduplicate by request.idempotencyId before
   * repeating a BrowserClaw side effect and return the original receipt on a
   * replay, including when the prior HTTP response was lost after completion.
   */
  dispatchWake(request: BrowserWorkerRequest): Promise<BrowserWorkerReceipt>;
}

export class BrowserWorkerDispatchError extends Error {
  constructor(readonly errorClass: BrowserWorkerErrorClass, message = "Browser worker dispatch failed") {
    super(message);
    this.name = "BrowserWorkerDispatchError";
  }
}

export function createConfiguredBrowserWorkerClient(environment: NodeJS.ProcessEnv = process.env): BrowserWorkerClient | null {
  const endpoint = environment.AGENT_HERDER_BROWSER_WORKER_URL;
  if (!endpoint) return null;
  const token = environment.AGENT_HERDER_BROWSER_WORKER_TOKEN?.trim();
  const parsedEndpoint = new URL(endpoint);
  if (parsedEndpoint.protocol !== "http:" && parsedEndpoint.protocol !== "https:") {
    throw new Error("Browser worker endpoint must use http or https");
  }
  const localEndpoint = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(parsedEndpoint.hostname);
  if (!localEndpoint && !token) {
    throw new Error("A non-local browser worker endpoint requires AGENT_HERDER_BROWSER_WORKER_TOKEN");
  }
  return {
    async dispatchWake(request: BrowserWorkerRequest): Promise<BrowserWorkerReceipt> {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (token) headers.authorization = `Bearer ${token}`;
      let response: Response;
      try {
        response = await fetch(endpoint, {
          method: "POST",
          headers,
          body: JSON.stringify(request),
          signal: AbortSignal.timeout(request.deadlineMs),
        });
      } catch (error) {
        const name = error instanceof Error ? error.name : "";
        throw new BrowserWorkerDispatchError(name === "AbortError" || name === "TimeoutError" ? "worker_timeout" : "worker_unavailable");
      }
      if (!response.ok) {
        throw new BrowserWorkerDispatchError(response.status >= 500 ? "worker_unavailable" : "worker_rejected");
      }
      try {
        const text = await response.text();
        if (text.length > 64 * 1024) throw new Error("receipt too large");
        return BrowserWorkerReceiptSchema.parse(JSON.parse(text));
      } catch {
        throw new BrowserWorkerDispatchError("invalid_receipt");
      }
    },
  };
}
