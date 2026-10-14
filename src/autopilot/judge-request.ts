import { redactSecrets } from "./index.js";

export type JudgeFailureKind = "timeout" | "cancelled" | "network" | "rate_limited" | "quota_exhausted"
  | "overloaded" | "authentication" | "access_denied" | "http_error" | "provider_error" | "invalid_json";
export type JudgeRequestDiagnostic = {
  model: string; endpoint: string; operation: string; elapsedMs: number;
  stage: "headers" | "body"; kind: JudgeFailureKind; httpStatus?: number;
  providerCode?: string; providerMessage?: string; requestId?: string; retryAfter?: string; transportCode?: string;
};
const LABELS: Record<JudgeFailureKind, string> = {
  timeout: "истекло время ожидания", cancelled: "запрос отменён", network: "сбой соединения",
  rate_limited: "ограничена частота запросов", quota_exhausted: "исчерпана квота",
  overloaded: "провайдер перегружен", authentication: "ошибка авторизации", access_denied: "доступ отклонён",
  http_error: "ошибка HTTP", provider_error: "ошибка провайдера", invalid_json: "ответ не является JSON",
};
export class JudgeRequestError extends Error {
  constructor(readonly diagnostic: JudgeRequestDiagnostic) {
    super(`LLM ${diagnostic.model}${diagnostic.httpStatus ? ` HTTP ${diagnostic.httpStatus}` : ""}: ${LABELS[diagnostic.kind]}; ${JSON.stringify(diagnostic)}`);
    this.name = "JudgeRequestError";
  }
}

/** One request, no retry or fallback. Diagnostics never include request bodies or credentials. */
export class JudgeRequestTrace {
  private readonly started = Date.now();
  private stage: JudgeRequestDiagnostic["stage"] = "headers";
  private status?: number;
  private requestId?: string;
  private retryAfter?: string;
  private signal?: AbortSignal | null;
  private secrets: string[] = [];
  constructor(private readonly route: { model: string; endpoint: string; operation: string }) {}

  private safe(value: unknown, limit = 400): string | undefined {
    if (typeof value !== "string" && typeof value !== "number") return undefined;
    let text = String(value);
    for (const secret of this.secrets) if (secret) text = text.split(secret).join("[REDACTED]");
    return redactSecrets(text).replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, limit);
  }
  private failure(kind: JudgeFailureKind, extra: Partial<JudgeRequestDiagnostic> = {}): JudgeRequestError {
    const url = new URL(this.route.endpoint);
    return new JudgeRequestError({ model: this.safe(this.route.model, 256)!, operation: this.route.operation,
      endpoint: `${url.origin}${url.pathname}`, stage: this.stage, kind, elapsedMs: Date.now() - this.started,
      ...(this.status ? { httpStatus: this.status } : {}), ...(this.requestId ? { requestId: this.requestId } : {}),
      ...(this.retryAfter ? { retryAfter: this.retryAfter } : {}), ...extra });
  }
  private transport(error: unknown): JudgeRequestError {
    if (error instanceof JudgeRequestError) return error;
    const e = error as { name?: string; cause?: { code?: string } };
    const timeout = e?.name === "TimeoutError" || (this.signal?.aborted && this.signal.reason?.name === "TimeoutError");
    const kind = timeout ? "timeout" : this.signal?.aborted || e?.name === "AbortError" ? "cancelled" : "network";
    const code = e?.cause?.code;
    return this.failure(kind, typeof code === "string" && /^[A-Z0-9_]{1,64}$/.test(code) ? { transportCode: code } : {});
  }
  private provider(body: unknown): Partial<JudgeRequestDiagnostic> {
    const b = body && typeof body === "object" ? body as Record<string, any> : {};
    const code = this.safe(b.error?.code ?? b.base_resp?.status_code ?? b.error?.type, 80);
    const message = this.safe(b.error?.message ?? b.base_resp?.status_msg);
    return { ...(code ? { providerCode: code } : {}), ...(message ? { providerMessage: message } : {}) };
  }
  private classify(code?: string): JudgeFailureKind {
    const host = new URL(this.route.endpoint).hostname;
    if (host === "api.minimax.io") {
      if (code === "2056" || code === "4292056") return "quota_exhausted";
      if (code === "1002") return "rate_limited";
    }
    if (host === "api.z.ai") {
      if (["1308", "1310", "1316", "1317", "1318", "1319", "1320", "1321"].includes(code ?? "")) return "quota_exhausted";
      if (code === "1302") return "rate_limited";
      if (code === "1305") return "overloaded";
    }
    return this.status === 429 ? "rate_limited" : this.status === 401 ? "authentication"
      : this.status === 403 ? "access_denied" : this.status && this.status >= 500 ? "overloaded"
        : this.status && this.status >= 400 ? "http_error" : "provider_error";
  }

  async fetch(fetchImpl: typeof fetch, endpoint: string, init: RequestInit): Promise<Response> {
    this.signal = init.signal;
    const headers = new Headers(init.headers);
    this.secrets = [headers.get("authorization")?.replace(/^Bearer\s+/i, ""), headers.get("x-api-key")].filter((s): s is string => !!s);
    let response: Response;
    try { response = await fetchImpl(endpoint, init); }
    catch (error) { throw this.transport(error); }
    this.stage = "body";
    this.status = response.status;
    this.requestId = this.safe(response.headers.get("x-request-id") ?? response.headers.get("request-id") ?? response.headers.get("x-correlation-id"), 160);
    this.retryAfter = this.safe(response.headers.get("retry-after"), 160);
    if (!response.ok) {
      // Bound both bytes and the read: the caller's existing abort signal covers this response body.
      let body: unknown;
      const reader = response.body?.getReader();
      if (reader) {
        const decoder = new TextDecoder(); let raw = ""; let bytes = 0;
        try {
          while (true) {
            const part = await reader.read(); if (part.done) break;
            bytes += part.value.byteLength;
            if (bytes > 8192) { void reader.cancel().catch(() => undefined); break; }
            raw += decoder.decode(part.value, { stream: true });
          }
          raw += decoder.decode();
          try { body = JSON.parse(raw); } catch { /* Preserve HTTP facts, not an unstructured body. */ }
        } catch (error) { throw this.transport(error); }
        finally { reader.releaseLock(); }
      }
      throw this.providerFailure(body);
    }
    return response;
  }

  providerFailure(body: unknown): JudgeRequestError {
    const detail = this.provider(body);
    return this.failure(this.classify(detail.providerCode), detail);
  }

  async read<T>(read: () => Promise<T>): Promise<T> {
    try { return await read(); }
    catch (error) {
      if (error instanceof SyntaxError) throw this.failure("invalid_json");
      const name = (error as { name?: string })?.name;
      if (this.signal?.aborted || name === "TimeoutError" || name === "AbortError" || error instanceof TypeError) throw this.transport(error);
      throw error; // Preserve semantic/validation errors from a successful response.
    }
  }
  async json(response: Response): Promise<Record<string, unknown>> {
    const body = await this.read(() => response.json()) as Record<string, unknown>;
    const baseCode = (body?.base_resp as any)?.status_code;
    if (body?.error || (baseCode !== undefined && String(baseCode) !== "0")) {
      throw this.providerFailure(body);
    }
    return body;
  }
}
