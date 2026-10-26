import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { askHumanEnvPath, describeAskHumanProducer, loadAskHumanProducer, loadAskHumanProducerForTarget, parseEnvFile } from "../src/human-request/ask-human-producer.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function home(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agent-herder-ask-human-producer-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const askHumanEnv = [
  "# protected producer used by every harness and the phone",
  'NOTIFY_CENTER_TOKEN="ask-human-token"',
  "NOTIFY_CENTER_EVENT_URL=http://127.0.0.1:8091/v1/events",
  "NOTIFY_CENTER_PROJECT=hermes",
  "NOTIFY_CENTER_RECIPIENT=me",
  "ASK_HUMAN_URL=http://127.0.0.1:8091/v1/human-requests",
  "ASK_HUMAN_ALLOWED_ACTORS=telegram:540308572",
  "",
].join("\n");

describe("ask human producer configuration", () => {
  it("reads the protected AskHuman producer, not Herder's own notification scope", async () => {
    const dir = await home();
    await writeFile(join(dir, ".config", "ask-human", "env").replace(/\/env$/, "/env"), "", { flag: "w" }).catch(() => undefined);
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(dir, ".config", "ask-human"), { recursive: true });
    await writeFile(join(dir, ".config", "ask-human", "env"), askHumanEnv, "utf8");
    const env = {
      // Herder's own automatic notification intake, a different project/token.
      NOTIFY_CENTER_TOKEN: "herder-token",
      NOTIFY_CENTER_EVENT_URL: "http://127.0.0.1:8091/v1/events",
      NOTIFY_CENTER_PROJECT: "agent-herder",
    } as NodeJS.ProcessEnv;

    const producer = await loadAskHumanProducer(env, dir);

    expect(producer).toMatchObject({
      endpoint: "http://127.0.0.1:8091/v1/human-requests",
      token: "ask-human-token",
      project: "hermes",
      recipient: "me",
      allowedActors: ["telegram:540308572"],
      source: "ask_human_config",
    });
    // Ordinary notifications keep their own project: nothing is re-routed.
    expect(env.NOTIFY_CENTER_PROJECT).toBe("agent-herder");
    expect(askHumanEnvPath({}, dir)).toBe(join(dir, ".config", "ask-human", "env"));
    expect(askHumanEnvPath({ ASK_HUMAN_ENV_FILE: "/etc/ask-human.env" } as NodeJS.ProcessEnv, dir))
      .toBe("/etc/ask-human.env");
  });

  it("never leaks the token through its diagnostics", async () => {
    const dir = await home();
    const producer = await loadAskHumanProducer({
      ASK_HUMAN_URL: "http://127.0.0.1:8091/v1/human-requests",
      ASK_HUMAN_ALLOWED_ACTORS: "telegram:540308572",
      NOTIFY_CENTER_TOKEN: "ask-human-token",
      NOTIFY_CENTER_PROJECT: "hermes",
    } as NodeJS.ProcessEnv, dir);

    expect(producer?.source).toBe("ask_human_env");
    const described = describeAskHumanProducer(producer!);
    expect(described).toContain("project=hermes");
    expect(described).toContain("http://127.0.0.1:8091/v1/human-requests");
    expect(described).toContain("actors=1");
    expect(described).not.toContain("ask-human-token");
    expect(described).not.toContain("telegram:540308572");
  });

  it("falls back to Herder's own config only when there is no AskHuman config", async () => {
    const dir = await home();
    const fallback = await loadAskHumanProducer({
      NOTIFY_CENTER_TOKEN: "herder-token",
      NOTIFY_CENTER_EVENT_URL: "http://127.0.0.1:8091/v1/events",
      NOTIFY_CENTER_PROJECT: "agent-herder",
    } as NodeJS.ProcessEnv, dir);
    // The fallback is the automatic-events producer, never a question scope.

    expect(fallback).toMatchObject({
      endpoint: "http://127.0.0.1:8091/v1/human-requests",
      project: "agent-herder",
      source: "herder_config",
    });
    expect(fallback?.allowedActors).toBeUndefined();
    expect(await loadAskHumanProducer({} as NodeJS.ProcessEnv, dir)).toBeUndefined();
  });

  it("parses a protected env file without executing anything", () => {
    expect(parseEnvFile(askHumanEnv)).toMatchObject({
      NOTIFY_CENTER_TOKEN: "ask-human-token",
      NOTIFY_CENTER_PROJECT: "hermes",
      ASK_HUMAN_URL: "http://127.0.0.1:8091/v1/human-requests",
    });
    expect(parseEnvFile("export FOO='bar baz'\n\n# comment\nnot a pair\nBAR=1\n")).toEqual({ FOO: "bar baz", BAR: "1" });
  });

  it("selects the QA producer only for the exact host, harness, and session", async () => {
    const dir = await home();
    const qaFile = join(dir, "qa.env");
    const prodFile = join(dir, "prod.env");
    const bindingsFile = join(dir, "bindings.json");
    await writeFile(qaFile, "ASK_HUMAN_URL=http://127.0.0.1:8091/v1/human-requests\nNOTIFY_CENTER_TOKEN=qa-fixture-token\nNOTIFY_CENTER_PROJECT=noticeplace-qa\nNOTIFY_CENTER_RECIPIENT=me\nASK_HUMAN_ALLOWED_ACTORS=telegram:540308572\n", { mode: 0o600 });
    await writeFile(prodFile, "ASK_HUMAN_URL=http://127.0.0.1:8091/v1/human-requests\nNOTIFY_CENTER_TOKEN=prod-fixture-token\nNOTIFY_CENTER_PROJECT=agent-herder\nASK_HUMAN_ALLOWED_ACTORS=telegram:540308572\n", { mode: 0o600 });
    const target = { hostId: "host-a", harness: "opencode", sessionId: "session-a" };
    await writeFile(bindingsFile, JSON.stringify({ version: 1, bindings: [{ target, askHumanEnvFile: qaFile }] }), { mode: 0o600 });
    const env = { ASK_HUMAN_ENV_FILE: prodFile, AGENT_HERDER_NOTICE_PRODUCER_BINDINGS_FILE: bindingsFile } as NodeJS.ProcessEnv;

    const selected = await loadAskHumanProducerForTarget(target, env, dir);
    const neighbor = await loadAskHumanProducerForTarget({ ...target, hostId: "host-b" }, env, dir);

    expect(selected).toMatchObject({ project: "noticeplace-qa", recipient: "me", allowedActors: ["telegram:540308572"], source: "ask_human_config" });
    expect(selected?.token).toBe("qa-fixture-token");
    expect(neighbor).toMatchObject({ project: "agent-herder", source: "ask_human_config" });
    expect(neighbor?.token).toBe("prod-fixture-token");
  });

  it("fails closed for a conflicted exact target and insecure matching producer file", async () => {
    const dir = await home();
    const qaFile = join(dir, "qa.env");
    const bindingsFile = join(dir, "bindings.json");
    const target = { hostId: "host-a", harness: "opencode", sessionId: "session-a" };
    const env = { NOTIFY_CENTER_TOKEN: "prod-fixture-token", NOTIFY_CENTER_PROJECT: "agent-herder", NOTIFY_CENTER_EVENT_URL: "http://127.0.0.1:8091/v1/events", AGENT_HERDER_NOTICE_PRODUCER_BINDINGS_FILE: bindingsFile } as NodeJS.ProcessEnv;
    const binding = { target, askHumanEnvFile: qaFile };
    await writeFile(qaFile, "ASK_HUMAN_URL=http://127.0.0.1:8091/v1/human-requests\nNOTIFY_CENTER_TOKEN=qa-fixture-token\nNOTIFY_CENTER_PROJECT=noticeplace-qa\nASK_HUMAN_ALLOWED_ACTORS=telegram:540308572\n", { mode: 0o600 });
    await writeFile(bindingsFile, JSON.stringify({ version: 1, bindings: [binding, binding] }), { mode: 0o600 });

    await expect(loadAskHumanProducerForTarget(target, env, dir)).rejects.toThrow(/conflicted native target/);

    await writeFile(bindingsFile, JSON.stringify({ version: 1, bindings: [binding] }), { mode: 0o600 });
    await chmod(qaFile, 0o644);
    await expect(loadAskHumanProducerForTarget(target, env, dir)).rejects.toThrow(/0600 file/);
    await expect(loadAskHumanProducerForTarget({ ...target, hostId: "host-b" }, { ...env, AGENT_HERDER_NOTICE_PRODUCER_BINDINGS_FILE: join(dir, "missing.json") } as NodeJS.ProcessEnv, dir)).rejects.toThrow();
  });
});
