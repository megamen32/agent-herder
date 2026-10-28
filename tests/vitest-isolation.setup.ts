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
process.env.AGENT_HERDER_INDEXING_SETTINGS ??= join(root, "indexing-settings.json");
process.env.AGENT_HERDER_HUMAN_STOP_STORE ??= join(root, "human-stops.json");
process.env.AGENT_HERDER_AUTOPILOT_STATE_DIR ??= root;
process.env.AGENT_HERDER_NATIVE_STOCK_CASES_PATH ??= join(root, "native-stock-cases.json");
// The runtime state of the installation is a live file of a live runtime: a
// test must never read the turns of the host it runs on, or the answer of the
// test would depend on what the host happens to be doing. The path points at
// nothing, so the runtime proof is simply absent.
process.env.MINIMAX_CODE_RUNTIME_DB ??= join(root, "minimax-runtime-state.sqlite");
// The coordination ledger of the installation is a live file: the running
// herder rewrites it under a write lock. A unit test that shares it waits for
// that lock and times out, so the test environment keeps its own ledger.
process.env.AGENT_HERDER_COORDINATION_NOTES ??= join(root, "coordination-notes.json");
// The fleet of the installation is injected: the same machine names, but with
// addresses that refuse at once. A unit test never addresses a live neighbour.
process.env.AGENT_HERDER_FLEET_PEERS ??= JSON.stringify([
  { hostId: "roomhacker-server-100", sshHost: "127.0.0.1", sshPort: 1, nativeUser: "roomhacker", port: 1, python: "/usr/bin/python3" },
  { hostId: "server-44", sshHost: "127.0.0.1", sshPort: 1, nativeUser: "roomhacker", port: 1, python: "/usr/bin/python3" },
  { hostId: "roomhacker-server-88", sshHost: "127.0.0.1", sshPort: 1, nativeUser: "roomhacker", port: 1, python: "/usr/bin/python3" },
  { hostId: "mac-mini-2012.lan", sshHost: "127.0.0.1", sshPort: 1, nativeUser: "roomhacker", port: 1, python: "/usr/bin/python3" },
  { hostId: "MacBook-Pro-User.local", sshHost: "127.0.0.1", sshPort: 1, nativeUser: "user", port: 1, python: "/opt/homebrew/bin/python3" },
]);
