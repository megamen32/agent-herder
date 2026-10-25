import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// Release utilities, not SDK/vendor copies.
// @ts-expect-error Plain Node packaging entrypoint has no TS declaration.
import { prepareCodexNativeProjection } from "../scripts/prepare-codex-native-projection.mjs";
// @ts-expect-error Plain Node packaging entrypoint has no TS declaration.
import { DEFAULT_OUT } from "../scripts/build-codex-plugin-payload.mjs";

const exec = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const builder = join(repoRoot, "scripts", "build-codex-plugin-payload.mjs");
const newline = String.fromCharCode(10);
const servers: Server[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** The runtime the plugin loads: the stubs of the entries of the plugin. */
async function fixtureDist(root: string, capture: string): Promise<string> {
  const dist = join(root, "dist");
  await mkdir(dist, { recursive: true });
  await writeFile(join(dist, "autopilot-hook.js"), "process.stdout.write(\"{}\");", "utf8");
  await writeFile(join(dist, "autopilot-runner.js"), "process.stdout.write(\"{}\");", "utf8");
  await writeFile(join(dist, "human-stop-store.js"), [
    "export function getHumanStopStore() {",
    "  return { async rememberGeneratedPrompt(harness, id, text) {",
    "    const fs = await import('node:fs/promises');",
    "    await fs.appendFile(" + JSON.stringify(capture) + ", JSON.stringify({ harness, id, text }) + String.fromCharCode(10));",
    "  } };",
    "}",
  ].join(newline), "utf8");
  return dist;
}

/** The payload of the plugin and the native package built from it. */
async function buildPayloadAndArtifact(root: string, capture: string): Promise<{ payload: string; artifact: string }> {
  const dist = await fixtureDist(root, capture);
  const modules = join(root, "node_modules");
  await mkdir(modules, { recursive: true });
  const payload = join(root, "payload");
  await exec(process.execPath, [builder, "--out", payload, "--repo", repoRoot, "--dist", dist, "--node-modules", modules]);
  const artifact = join(root, "native-0.2.6");
  await prepareCodexNativeProjection(payload, artifact, "0.2.6");
  return { payload, artifact };
}

/** Run the Stop hook of the native package against a panel that answers. */
async function runArtifactHook(artifact: string, options: { readonly digestRoute?: boolean }): Promise<{
  stdout: string;
  code: number | null;
  digests: Array<Record<string, unknown>>;
}> {
  const digests: Array<Record<string, unknown>> = [];
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const part of request) raw += part;
    const body = raw ? JSON.parse(raw) : {};
    if (request.url === "/api/human-stop/generated-prompt") {
      digests.push(body);
      response.statusCode = options.digestRoute === false ? 404 : 200;
      response.setHeader("content-type", "application/json");
      response.end(options.digestRoute === false ? JSON.stringify({ error: "not found" }) : JSON.stringify({ ok: true }));
      return;
    }
    if (request.url === "/api/hooks/prohibitions") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ok: true, known: true, prohibitionsEnabled: true, disabledHooks: [] }));
      return;
    }
    if (request.url?.startsWith("/api/coordination/context")) {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        context: "",
        inboxContext: "сообщение панели",
        inboxCount: 1,
        inboxIds: ["inbox-1"],
        humanStopHeld: false,
      }));
      return;
    }
    response.setHeader("content-type", "application/json");
    response.end("{}");
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("the test panel did not bind");

  const hookState = await mkdtemp(join(tmpdir(), "agent-herder-l62-state-"));
  roots.push(hookState);
  const child = spawn(process.execPath, [join(artifact, "scripts", "codex-stop-hook.mjs")], {
    env: {
      ...process.env,
      AGENT_HERDER_URL: `http://127.0.0.1:${address.port}`,
      AGENT_HERDER_HOOK_STATE_DIR: hookState,
      PLUGIN_ROOT: artifact,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  child.stdout.on("data", (chunk) => { stdout += String(chunk); });
  child.stdin.end(JSON.stringify({
    hook_event_name: "Stop",
    session_id: "session-1",
    cwd: "/repo",
    transcript_path: "/repo/transcript.jsonl",
    stop_hook_active: false,
    last_assistant_message: "готово",
  }));
  const code = await new Promise<number | null>((resolve) => {
    child.once("error", () => resolve(-1));
    child.once("exit", (value) => resolve(value));
  });
  return { stdout, code, digests };
}

describe("the payload of the plugin of Codex in the release", () => {
  it("takes the digest of the decision from the panel", async () => {
    // The hook of the native package is the byte copy of the hook of the
    // repository: the contract is measured on the artifact, not on the source.
    const root = await mkdtemp(join(tmpdir(), "agent-herder-l62-panel-"));
    roots.push(root);
    const capture = join(root, "local-store.jsonl");
    const { artifact } = await buildPayloadAndArtifact(root, capture);
    const run = await runArtifactHook(artifact, {});
    expect(run.digests).toEqual([{ harness: "codex", sessionId: "session-1", text: "сообщение панели" }]);
    expect(JSON.parse(run.stdout)).toEqual({ decision: "block", reason: "сообщение панели" });
    expect(run.code).toBe(0);
    // The panel answered: the local store of the plugin was not needed.
    await expect(readFile(capture, "utf8")).rejects.toThrow();
  });

  it("falls back to the local store of the plugin when the panel does not know the route", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-l62-fallback-"));
    roots.push(root);
    const capture = join(root, "local-store.jsonl");
    const { artifact } = await buildPayloadAndArtifact(root, capture);
    const run = await runArtifactHook(artifact, { digestRoute: false });
    // The panel is asked first, even when it cannot answer.
    expect(run.digests).toEqual([{ harness: "codex", sessionId: "session-1", text: "сообщение панели" }]);
    expect(JSON.parse(run.stdout)).toEqual({ decision: "block", reason: "сообщение панели" });
    expect(run.code).toBe(0);
    // And the local store of the plugin holds the digest of the continued turn.
    const recorded = (await readFile(capture, "utf8")).trim().split(newline)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(recorded).toEqual([{ harness: "codex", id: "session-1", text: "сообщение панели" }]);
  });

  it("ships the payload of the plugin in the archive of the release", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-l62-release-"));
    roots.push(root);
    const capture = join(root, "local-store.jsonl");
    const { payload } = await buildPayloadAndArtifact(root, capture);

    // The path of the payload inside the release: the builder writes it into
    // the runtime of the release, and the runtime of the release is packaged.
    const releasePath = relative(repoRoot, DEFAULT_OUT).split(sep).join("/");
    expect(releasePath).toBe("dist/plugin/codex/agent-herder");

    // A release laid out the way the builder of the release lays it out.
    const release = join(root, "release");
    const payloadInRelease = join(release, "dist", "plugin", "codex", "agent-herder");
    await mkdir(payloadInRelease, { recursive: true });
    await cp(payload, payloadInRelease, { recursive: true });
    await mkdir(join(release, "packages"), { recursive: true });
    await writeFile(join(release, "package.json"), "{}", "utf8");
    await writeFile(join(release, "package-lock.json"), "{}", "utf8");
    await writeFile(join(release, "build-manifest.json"), "{}", "utf8");

    // The archive of the release is made by the tool of the rollout: it is
    // read here, never changed.
    const archive = join(root, "release.tar");
    const fleet = join(repoRoot, "deploy", "fleet");
    const { stdout } = await exec("python3", ["-c", `
import importlib.util, json, pathlib, sys, tarfile
spec = importlib.util.spec_from_file_location("rollout_candidate", sys.argv[3])
rollout_candidate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rollout_candidate)
rollout_candidate.pack_release(pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]))
with tarfile.open(sys.argv[2]) as archive:
    print(json.dumps(archive.getnames()))
`, join(release), archive, join(fleet, "rollout-candidate.py")], { cwd: fleet });
    const members = JSON.parse(stdout.trim()) as string[];

    // The payload of the plugin is in the archive, byte for byte.
    expect(members).toContain("./dist/plugin/codex/agent-herder/payload-receipt.json");
    expect(members).toContain("./dist/plugin/codex/agent-herder/scripts/codex-stop-hook.mjs");
    expect(members).toContain("./dist/plugin/codex/agent-herder/scripts/hooks-prohibitions.mjs");
    expect(members).toContain("./dist/plugin/codex/agent-herder/com.openai/hooks/hooks.json");
    const receipt = JSON.parse(await readFile(join(payload, "payload-receipt.json"), "utf8")) as Record<string, unknown>;
    expect(receipt.digestContract).toEqual({ panelRoute: true, localFallback: true });
    expect(Number(receipt.files)).toBeGreaterThan(0);
  });

  it("builds the payload as a step of the release", async () => {
    // The builder of the release has to build the payload: without that step
    // the release carries no plugin for a node of the fleet.
    const source = await readFile(join(repoRoot, "deploy", "fleet", "build-release-candidate.py"), "utf8");
    expect(source).toContain("build-codex-plugin-payload.mjs");
  });
});
