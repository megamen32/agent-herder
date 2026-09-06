import { parentPort } from "node:worker_threads";
import { SessionConverter, type HarnessType } from "session-convert";

interface ConvertMessage {
  sessionId: string;
  from: HarnessType;
  to: HarnessType;
  projectPath?: string;
  searchPaths?: string[];
}

if (!parentPort) throw new Error("session-convert worker requires parentPort");

parentPort.once("message", async (input: ConvertMessage) => {
  try {
    if (input.from === input.to) {
      parentPort!.postMessage({ ok: true, result: { success: false, error: "Source and target harness must differ" } });
      return;
    }
    const converter = new SessionConverter();
    const result = await converter.convert(input.from, input.to, input.sessionId, {
      projectPath: input.projectPath,
      searchPaths: input.searchPaths,
    });
    parentPort!.postMessage({ ok: true, result });
  } catch (error) {
    parentPort!.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});
