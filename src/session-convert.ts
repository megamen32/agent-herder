import { SessionConverter, type Conversation, type ConversionResult, type HarnessType } from "session-convert";
import { Worker } from "node:worker_threads";
import { abortError, throwIfAborted } from "./abort-utils.js";

export interface ConvertSessionInput {
  sessionId: string;
  from: HarnessType;
  to: HarnessType;
  projectPath?: string;
  searchPaths?: string[];
}

export interface ReadSessionInput {
  sessionId: string;
  from: HarnessType;
  searchPaths?: string[];
}

/** Thin domain wrapper that keeps conversion behind the agent-herder service boundary. */
export class AgentHerderSessionConverter {
  private readonly converter: SessionConverter;

  constructor(converter = new SessionConverter()) {
    this.converter = converter;
  }

  async convert(input: ConvertSessionInput, signal?: AbortSignal): Promise<ConversionResult> {
    throwIfAborted(signal);
    if (input.from === input.to) {
      return { success: false, error: "Source and target harness must differ" };
    }
    if (!signal) {
      return this.converter.convert(input.from, input.to, input.sessionId, {
        projectPath: input.projectPath,
        searchPaths: input.searchPaths,
      });
    }
    return this.convertInWorker(input, signal);
  }

  private async convertInWorker(input: ConvertSessionInput, signal: AbortSignal): Promise<ConversionResult> {
    throwIfAborted(signal);
    const worker = new Worker(new URL("./session-convert-worker.js", import.meta.url));
    return new Promise<ConversionResult>((resolve, reject) => {
      let settled = false;
      const cleanup = () => signal.removeEventListener("abort", onAbort);
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        cleanup();
        void worker.terminate();
        fn();
      };
      const onAbort = () => finish(() => reject(signal.reason instanceof Error ? signal.reason : abortError()));
      signal.addEventListener("abort", onAbort, { once: true });
      worker.once("message", (message: { ok?: boolean; result?: ConversionResult; error?: string }) => {
        if (message.ok && message.result) finish(() => resolve(message.result!));
        else finish(() => reject(new Error(message.error || "Session conversion worker failed")));
      });
      worker.once("error", (error) => finish(() => reject(error)));
      worker.once("exit", (code) => {
        if (!settled && code !== 0) finish(() => reject(new Error(`Session conversion worker exited with code ${code}`)));
      });
      worker.postMessage(input);
    });
  }

  async read(input: ReadSessionInput): Promise<Conversation | null> {
    return this.converter.readSession(input.from, input.sessionId, { searchPaths: input.searchPaths });
  }
}
