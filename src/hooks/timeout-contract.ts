/**
 * The timeout contract of the hooks, as the runtime really has it.
 *
 * The owner must see the number that the runtime applies to every hook, and
 * the file that number was read from. A number that was not read is never
 * guessed: the answer says «нет данных» and names the file that was looked
 * for. The same is true for the limit of the runtime and for the code of the
 * diagnostic: they are read from the files of the installed runtime, and the
 * path of every file is part of the answer.
 *
 * Nothing here writes anything and nothing here changes a lever: the file is
 * read once per panel request and the answer is what the machine has at that
 * moment.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** One hook of one harness and the timeout that its manifest gives it. */
export interface HookTimeoutRow {
  /** The kind of the hook, as the manifest names it. */
  kind: string;
  /** The timeout in seconds. null when the manifest gives no number. */
  timeoutSeconds: number | null;
  /** The verbatim reason when there is no number. */
  reason?: string;
}

/** The contract of one harness. */
export interface HookTimeoutContract {
  /** The harness the contract belongs to. */
  harness: string;
  /** The name of the harness, as the owner reads it. */
  humanName: string;
  /** True when the manifest was found and read. */
  found: boolean;
  /** The file the numbers were read from. */
  source: string;
  /** The verbatim reason when the manifest is missing. */
  reason?: string;
  /** The limit of the runtime in seconds; null means «нет данных». */
  limitSeconds: number | null;
  /** The range of the runtime, as the runtime states it. */
  limitRange?: string;
  /** The file the limit was read from. */
  limitSource?: string;
  /** The verbatim reason when the limit is unknown. */
  limitReason?: string;
  /** The code of the diagnostic of the runtime, as the runtime writes it. */
  diagnosticCode?: string;
  /** The file the diagnostic code was read from. */
  diagnosticSource?: string;
  /** The condition of the runtime that produces the diagnostic, verbatim. */
  diagnosticCondition?: string;
  /** The timeout of every hook of the manifest. */
  rows: HookTimeoutRow[];
}

/** The harnesses whose contract the panel shows. */
const HARNESSES: ReadonlyArray<{ harness: string; humanName: string }> = [
  { harness: "minimax-code", humanName: "MiniMax Code" },
  { harness: "codex", humanName: "Codex" },
  { harness: "claude", humanName: "Claude Code" },
  { harness: "zcode", humanName: "ZCode" },
];

/**
 * The files of the installed runtime that state the limit of the timeout.
 *
 * The limit of a runtime is a property of that runtime and not of the
 * manifest, so it is read from the runtime itself. The path is the answer:
 * the owner can open the file and see the number with his own eyes.
 */
const RUNTIME_LIMIT_SOURCES: Readonly<Record<string, readonly string[]>> = {
  "minimax-code": [
    "/opt/minimax-code/resources/app/node_modules/@mavis/plugin-hooks/src/parser.ts",
    join(homedir(), ".minimax", "resources", "app", "node_modules", "@mavis", "plugin-hooks", "src", "parser.ts"),
  ],
};

/** The files of the installed package whose manifest states the timeout. */
function manifestCandidates(harness: string): string[] {
  const home = homedir();
  if (harness === "minimax-code") {
    return [join(home, ".minimax", "plugins", "agent-herder", "hooks", "hooks.json")];
  }
  if (harness === "codex") {
    return packageManifests(join(home, ".codex", "plugins", "cache"), ["com.openai", "hooks"]);
  }
  if (harness === "claude") {
    return packageManifests(join(home, ".claude", "plugins", "cache"), ["hooks"]);
  }
  return [];
}

/**
 * Every installed version of the package of the herder, newest first.
 *
 * The version that was installed last is the one the runtime uses, so it
 * comes first. Only the package of the herder is looked at: another plugin
 * has no contract of ours.
 */
function packageManifests(cache: string, manifestPath: readonly string[]): string[] {
  const found: string[] = [];
  const walk = (directory: string, depth: number): void => {
    if (depth > 4) return;
    let entries: string[];
    try {
      entries = readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch {
      return;
    }
    for (const entry of entries) {
      const next = join(directory, entry);
      const manifest = join(next, ...manifestPath, "hooks.json");
      if (next.includes("agent-herder") && existsSync(manifest)) found.push(manifest);
      walk(next, depth + 1);
    }
  };
  walk(cache, 0);
  return found.sort((left, right) => safeMtime(right) - safeMtime(left));
}

/** The moment a file was written, or 0 when it cannot be read. */
function safeMtime(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

/** Every number of the field `timeout` inside a part of a manifest. */
function collectTimeouts(value: unknown, into: number[] = []): number[] {
  if (Array.isArray(value)) {
    for (const item of value) collectTimeouts(item, into);
    return into;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (key === "timeout" && typeof item === "number" && Number.isFinite(item)) into.push(item);
      else collectTimeouts(item, into);
    }
  }
  return into;
}

/**
 * The timeout of every hook of a manifest.
 *
 * A hook with several handlers takes the longest timeout of them: that is
 * the time the runtime waits.
 */
function readManifestRows(path: string): HookTimeoutRow[] {
  let document: unknown;
  try {
    document = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return [{ kind: "манифест", timeoutSeconds: null, reason: `файл не прочитан: ${(error as Error).message}` }];
  }
  const hooks = (document as { hooks?: unknown }).hooks;
  if (!hooks || typeof hooks !== "object") {
    return [{ kind: "манифест", timeoutSeconds: null, reason: "в манифесте нет раздела hooks" }];
  }
  const rows: HookTimeoutRow[] = [];
  for (const [kind, value] of Object.entries(hooks as Record<string, unknown>)) {
    const timeouts = collectTimeouts(value);
    rows.push({
      kind,
      timeoutSeconds: timeouts.length ? Math.max(...timeouts) : null,
      ...(timeouts.length ? {} : { reason: "в манифесте нет поля timeout" }),
    });
  }
  return rows.sort((left, right) => left.kind.localeCompare(right.kind));
}

/**
 * The limit of the runtime and the code of its diagnostic.
 *
 * Both are read from the file of the runtime itself. The condition is copied
 * verbatim, so the owner reads the same words as the code of the runtime.
 */
function readRuntimeLimit(path: string): {
  limitSeconds: number | null;
  limitRange?: string;
  limitReason?: string;
  diagnosticCode?: string;
  diagnosticCondition?: string;
} {
  let source: string;
  try {
    source = readFileSync(path, "utf8");
  } catch (error) {
    return { limitSeconds: null, limitReason: `файл не прочитан: ${(error as Error).message}` };
  }
  const upper = /value\s*>\s*(\d+)/.exec(source);
  const lower = /value\s*<\s*(\d+)/.exec(source);
  const max = /MAX_TIMEOUT_MS\s*=\s*([\d_]+)/.exec(source);
  const seconds = upper
    ? Number(upper[1])
    : max
      ? Math.floor(Number(max[1].replace(/_/g, "")) / 1000)
      : null;
  const diagnostic = /'(HOOK_[A-Z_]+)'/.exec(source);
  const condition = /if\s*\(([^)]*Number\.isInteger\(value\)[^)]*)\)/.exec(source)?.[1]?.trim();
  return {
    limitSeconds: seconds,
    ...(lower && upper ? { limitRange: `${lower[1]}..${upper[1]}` } : {}),
    ...(seconds === null ? { limitReason: "в файле рантайма нет границы таймаута" } : {}),
    ...(diagnostic ? { diagnosticCode: diagnostic[1] } : {}),
    ...(condition ? { diagnosticCondition: condition } : {}),
  };
}

/**
 * The contract of every harness, as the machine has it right now.
 *
 * The order of the harnesses is the order of the owner: the runtime that
 * runs on this node comes first.
 */
export function hookTimeoutContracts(): HookTimeoutContract[] {
  return HARNESSES.map((descriptor) => {
    const candidates = manifestCandidates(descriptor.harness);
    const source = candidates[0];
    if (!source) {
      const looked = candidates.length ? candidates.join(", ") : descriptor.harness;
      return {
        harness: descriptor.harness,
        humanName: descriptor.humanName,
        found: false,
        source: looked,
        reason: `манифест хуков не найден (искали: ${looked}) — нет данных`,
        limitSeconds: null,
        limitReason: "нет данных",
        rows: [],
      };
    }
    const limitSources = RUNTIME_LIMIT_SOURCES[descriptor.harness] ?? [];
    const limitSource = limitSources.find((candidate) => existsSync(candidate));
    const limit = limitSource ? readRuntimeLimit(limitSource) : { limitSeconds: null, limitReason: "нет данных" };
    return {
      harness: descriptor.harness,
      humanName: descriptor.humanName,
      found: true,
      source,
      limitSeconds: limit.limitSeconds,
      ...(limit.limitRange ? { limitRange: limit.limitRange } : {}),
      ...(limitSource ? { limitSource } : {}),
      ...(limit.limitReason ? { limitReason: limit.limitReason } : {}),
      ...(limit.diagnosticCode ? { diagnosticCode: limit.diagnosticCode, diagnosticSource: limitSource } : {}),
      ...(limit.diagnosticCondition ? { diagnosticCondition: limit.diagnosticCondition } : {}),
      rows: readManifestRows(source),
    };
  });
}
