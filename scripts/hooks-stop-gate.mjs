#!/usr/bin/env node
/**
 * The gate of the Stop hook of Claude Code.
 *
 * The launcher of the autopilot decides whether the session may stop. The
 * lever of the owner decides whether that decision may be made at all. This
 * gate asks the herder first: while the prohibitions of the Stop hook are
 * off — or when the state of the lever cannot be read at all — the launcher
 * is not run, and the session stops the way the owner expects it to.
 *
 * The gate never breaks the session: a launcher that fails leaves the
 * session alone, and the gate itself only ever writes an empty decision.
 */
import { spawn } from "node:child_process";

import { journal, readProhibitions, reportActivity } from "./hooks-prohibitions.mjs";

const argv = process.argv.slice(2);
const separator = argv.indexOf("--");
const command = separator === -1 ? [] : argv.slice(separator + 1);
const kind = argv[0] && !argv[0].startsWith("--") ? argv[0] : "Stop";

let raw = "";
for await (const chunk of process.stdin) raw += chunk;

const prohibition = await readProhibitions(kind);
// The optional hooks runtime of the herder is off, or this hook is switched
// off on its own: this gate does nothing at all, and the launcher is never
// started.
if (!prohibition.active) {
  await journal(kind, { event: "hooks-off", known: prohibition.known });
  process.stdout.write("{}");
  process.exit(0);
}
await reportActivity(kind, { outcome: "fired", harness: process.env.AGENT_HERDER_HARNESS || "claude" });

if (!prohibition.enabled) {
  await journal(kind, { event: "prohibitions-off", known: prohibition.known });
  process.stdout.write("{}");
  process.exit(0);
}

if (command.length === 0) {
  process.stdout.write("{}");
  process.exit(0);
}

const child = spawn(command[0], command.slice(1), { stdio: ["pipe", "inherit", "inherit"] });
child.on("error", async () => {
  // A launcher that cannot start must not hold the session: the stop is
  // allowed and the failure is written to the journal of the hook.
  await journal(kind, { event: "launcher-unavailable", command: command.join(" ") });
  process.stdout.write("{}");
  process.exit(0);
});
child.stdin.on("error", () => undefined);
child.stdin.end(raw);
child.on("exit", (code) => {
  process.exit(typeof code === "number" ? code : 0);
});
