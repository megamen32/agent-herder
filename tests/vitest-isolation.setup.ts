// Per-test-file isolation of the durable coordination singletons. These stores
// read the environment at import time; a vitest setup file runs before each
// test file's imports, so every worker process gets its own private ledger.
// Without this, parallel test files race on the real ~/.local/state files
// (whole-file read-modify-rename) and lose writes across processes.
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";

const root = mkdtempSync(join(realpathSync("/tmp"), "agent-herder-vitest-"));
process.on("exit", () => { try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ } });

process.env.AGENT_HERDER_DEFERRED_MESSAGES ??= join(root, "deferred-messages.json");
process.env.AGENT_HERDER_HUMAN_STOP_STORE ??= join(root, "human-stops.json");
process.env.AGENT_HERDER_AUTOPILOT_STATE_DIR ??= root;
process.env.AGENT_HERDER_NATIVE_STOCK_CASES_PATH ??= join(root, "native-stock-cases.json");
