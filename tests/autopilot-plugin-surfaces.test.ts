import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");

describe("/autopilot plugin surfaces", () => {
  it("packages a Codex skill and native OpenCode and Hermes adapters", () => {
    const codexSkill = readFileSync(resolve(root, "skills/autopilot/SKILL.md"), "utf8");
    const opencode = readFileSync(resolve(root, "integrations/opencode/agent-herder-autopilot.js"), "utf8");
    const hermes = readFileSync(resolve(root, "integrations/hermes/agent-herder-autopilot/__init__.py"), "utf8");

    expect(codexSkill).toContain("/autopilot");
    expect(codexSkill).toContain("scripts/run.sh");
    expect(opencode).toContain('command !== "autopilot"');
    expect(opencode).toContain("config.command.autopilot");
    expect(opencode).toContain('event.type !== "session.idle"');
    expect(hermes).toContain('ctx.register_command("autopilot"');
    expect(hermes).toContain('ctx.register_hook("post_llm_call"');
    expect(hermes).toContain("get_messages_as_conversation");
    expect(hermes).toContain('"--resume", session_id');
    expect(hermes).toContain("gateway._enqueue_fifo");
    expect(hermes).toContain("_await_choice");
    expect(hermes).toContain('"lastUserMessage": last_user');
  });
});
