import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");

describe("/autopilot plugin surfaces", () => {
  it("packages Codex, Claude Code, OpenCode, Hermes, and ZCode adapters", () => {
    const codexSkill = readFileSync(resolve(root, "skills/autopilot/SKILL.md"), "utf8");
    const claudeManifest = readFileSync(resolve(root, ".claude-plugin/plugin.json"), "utf8");
    const claudeHooks = readFileSync(resolve(root, "hooks/hooks.json"), "utf8");
    const commandLauncher = readFileSync(resolve(root, "skills/autopilot/scripts/run.sh"), "utf8");
    const opencode = readFileSync(resolve(root, "integrations/opencode/agent-herder-autopilot.js"), "utf8");
    const hermes = readFileSync(resolve(root, "integrations/hermes/agent-herder-autopilot/__init__.py"), "utf8");
    const zcodeHooks = readFileSync(resolve(root, "integrations/zcode/agent-herder-autopilot/hooks/hooks.json"), "utf8");
    const zcodeStop = readFileSync(resolve(root, "integrations/zcode/agent-herder-autopilot/hooks/stop.mjs"), "utf8");
    const zcodeInstaller = readFileSync(resolve(root, "scripts/install-zcode-autopilot.sh"), "utf8");
    const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as { files: string[] };
    const webUi = readFileSync(resolve(root, "src/web-ui/main.tsx"), "utf8");

    expect(codexSkill).toContain("/autopilot");
    expect(codexSkill).toContain("scripts/run.sh");
    expect(claudeManifest).toContain('"name": "agent-herder"');
    expect(claudeHooks).toContain('"Stop"');
    expect(claudeHooks).toContain("${CLAUDE_PLUGIN_ROOT}/scripts/claude-autopilot-hook-launcher.sh");
    expect(commandLauncher).toContain("CLAUDE_CODE_SESSION_ID");
    expect(commandLauncher).toContain("harness=claude");
    expect(packageJson.files).toEqual(expect.arrayContaining([
      ".claude-plugin/plugin.json",
      "hooks/hooks.json",
      "scripts/claude-autopilot-hook-launcher.sh",
      "integrations/zcode/agent-herder-autopilot/hooks/stop.mjs",
    ]));
    expect(webUi).toContain('["codex", "opencode", "claude", "hermes", "zcode"]');
    expect(opencode).toContain('command !== "autopilot"');
    expect(opencode).toContain("config.command.autopilot");
    expect(opencode).toContain('event.type !== "session.idle"');
    expect(opencode).toContain("controlTurns.delete(sessionID)");
    expect(hermes).toContain('ctx.register_command("autopilot"');
    expect(hermes).toContain('ctx.register_hook("post_llm_call"');
    expect(hermes).toContain("get_messages_as_conversation");
    expect(hermes).toContain('"--resume", session_id');
    expect(hermes).toContain("gateway._enqueue_fifo");
    expect(hermes).toContain("_await_choice");
    expect(hermes).toContain('"lastUserMessage": last_user');
    expect(zcodeHooks).toContain('"Stop"');
    expect(zcodeStop).toContain('AGENT_HERDER_AUTOPILOT_ALL_SESSIONS');
    expect(zcodeStop).toContain('continue: true');
    expect(zcodeStop).not.toContain('spawn("zcode"');
    expect(zcodeInstaller).toContain("UserPromptSubmit");
    expect(zcodeInstaller).toContain("604800000");
  });
});
