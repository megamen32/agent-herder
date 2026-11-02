#!/usr/bin/env python3
"""Patcher: autopilot harness labels for ChatGPT and Z.ai in the web-ui.

Why: the backend already bridges browser chats into the durable autopilot —
BrowserTurnAutopilotObserver watches running→idle transitions for
AGENT_HERDER_BROWSER_AUTOPILOT_HARNESSES=zai,chatgpt (default) and submits
them to the same Stop consumer with the glm judge; the persisted policy
enables exactly [chatgpt, zai]. But src/web-ui/main.tsx carries its own
local AutopilotHarness type (five CLI harnesses only) and
AUTOPILOT_HARNESS_LABELS without chatgpt/zai, so:

  * the autopilot settings «Где работает» hides ChatGPT and Z.ai (the
    `available` set is Object.keys(AUTOPILOT_HARNESS_LABELS));
  * activeHarnessSupportsAutopilot is false for them (the header/session
    capability flag);
  * the capability note renders an undefined harness label.

Two anchored edits fix all three: extend the local type and add the two
labels. Record<AutopilotHarness, string> then keeps the object exhaustive:
forgetting a future harness is a compile error.

Pattern: same as patch_ui_overhaul.py — anchored edits, per-file timestamped
backup, clean abort on missing/non-unique anchor, idempotent once applied.

Run on the remote server:

    cd /home/roomhacker/agents-projects/agent-herder
    python3 scripts/patch_ap_harness_labels.py
"""
import os, shutil, sys, time

H = "/home/roomhacker/agents-projects/agent-herder"
TS = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
TAG = "aplabels"

MAIN = "src/web-ui/main.tsx"


def patch(rel, old, new, count=1):
    path = os.path.join(H, rel)
    bak = path + ".bak-" + TAG + "-" + TS
    if not os.path.exists(bak):
        shutil.copy2(path, bak)
    text = open(path, encoding="utf-8").read()
    n = text.count(old)
    if n != count:
        raise SystemExit("ABORT %r in %s: found %d, expected %d" % (old[:80], rel, n, count))
    text = text.replace(old, new)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)
    print("patched %s (%d site)" % (rel, n))


# 1. The local harness type must follow the server-side AutopilotHarness
#    (src/autopilot/session-store.ts): chatgpt and zai are autopilot-capable
#    through the browser turn bridge.
patch(MAIN,
      'type AutopilotHarness = "codex" | "opencode" | "claude" | "hermes" | "zcode";',
      'type AutopilotHarness = "codex" | "opencode" | "claude" | "hermes" | "zcode" | "chatgpt" | "zai";')

# 2. Labels for the settings grid «Где работает», the capability note and
#    every AUTOPILOT_HARNESS_LABELS lookup. Record<AutopilotHarness, string>
#    keeps this exhaustive from now on.
patch(MAIN,
      'const AUTOPILOT_HARNESS_LABELS: Record<AutopilotHarness, string> = {\n'
      '  codex: "Codex",\n'
      '  claude: "Claude Code",\n'
      '  opencode: "OpenCode",\n'
      '  hermes: "Hermes",\n'
      '  zcode: "ZCode",\n'
      '};',
      'const AUTOPILOT_HARNESS_LABELS: Record<AutopilotHarness, string> = {\n'
      '  codex: "Codex",\n'
      '  claude: "Claude Code",\n'
      '  opencode: "OpenCode",\n'
      '  hermes: "Hermes",\n'
      '  zcode: "ZCode",\n'
      '  chatgpt: "ChatGPT",\n'
      '  zai: "Z.ai",\n'
      '};')

print("\nDONE")
print("Backups suffix: .bak-" + TAG + "-" + TS)
print("Next: bun run tsc --noEmit, vitest regression, commit, build, switch drop-in")
