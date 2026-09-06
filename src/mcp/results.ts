import type { HerderJobRegistry } from "../herder-jobs.js";

export function structuredResult<T extends Record<string, unknown>>(value: T, pretty = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, pretty ? 2 : undefined) }],
    structuredContent: value,
  };
}

/** Preserve the legacy JSON text while also supplying typed-capable structured content. */
export function structuredValueResult(value: unknown, pretty = false) {
  const structuredContent = value !== null && typeof value === "object" ? value : { result: value };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, pretty ? 2 : undefined) }],
    structuredContent,
  };
}

export function startJobResult<T>(
  jobs: HerderJobRegistry,
  kind: string,
  run: (signal: AbortSignal, progress: (value: number, status?: string) => void) => Promise<T>,
  ownerSessionId?: string,
) {
  const job = jobs.start({
    kind,
    ownerSessionId,
    run: async ({ signal, progress }) => {
      progress(0.02, "Starting");
      if (signal.aborted) throw new Error("cancelled");
      const result = await run(signal, progress);
      if (signal.aborted) throw new Error("cancelled");
      progress(1, "Finished");
      return result;
    },
  });
  return structuredResult({ job });
}
