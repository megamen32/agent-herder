import { afterEach, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { CodexAppServerAdapter } from "../src/adapters/codex-app-server.js";
import { createCodexProjectRuntimePolicy } from "../src/project-runtime-policy.js";

const enabled = process.env.AGENT_HERDER_CODEX_H32_CANARY === "1";
const processProbeEnabled = process.env.AGENT_HERDER_CODEX_H32_PROCESS_PROBE === "1";
const temporaryRoots: string[] = [];
let adapter: CodexAppServerAdapter | undefined;
const previousEnvSentinel = process.env.H32_FAKE_CREDENTIAL_ENV;

function isExactNativeProbeWrapper(command: string, probePath: string): boolean {
  const expectedPython = `python3 ${JSON.stringify(probePath)}`;
  return command === `/bin/bash -lc '${expectedPython}'`;
}

afterEach(async () => {
  await adapter?.dispose();
  adapter = undefined;
  if (previousEnvSentinel === undefined) delete process.env.H32_FAKE_CREDENTIAL_ENV;
  else process.env.H32_FAKE_CREDENTIAL_ENV = previousEnvSentinel;
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("native Codex project sandbox canary", () => {
  it("accepts only the exact native bash login wrapper for the fresh probe", () => {
    const probe = "/tmp/h32 fresh/probe.py";
    const expected = `/bin/bash -lc 'python3 ${JSON.stringify(probe)}'`;
    expect(isExactNativeProbeWrapper(expected, probe)).toBe(true);
    expect(isExactNativeProbeWrapper(`${expected} ; echo extra`, probe)).toBe(false);
    expect(isExactNativeProbeWrapper(`/bin/bash -lc 'python3 ${JSON.stringify(probe)} --extra'`, probe)).toBe(false);
    expect(isExactNativeProbeWrapper(`python3 ${JSON.stringify(probe)}`, probe)).toBe(false);
  });

  it.skipIf(!enabled && !processProbeEnabled)("runs the bounded Codex project confinement probe", async () => {
    const parent = await mkdtemp(join(tmpdir(), "agent-herder-h32-parent-"));
    temporaryRoots.push(parent);
    const root = join(parent, "workspace");
    const sibling = join(parent, "sibling");
    const fakeHome = join(parent, "credential-home");
    const parentSentinel = join(parent, "parent.txt");
    const codexHome = join(fakeHome, ".codex");
    const sshHome = join(fakeHome, ".ssh");
    await Promise.all([mkdir(root), mkdir(sibling), mkdir(codexHome, { recursive: true }), mkdir(sshHome, { recursive: true })]);
    const sentinel = "H32_FAKE_CREDENTIAL_SENTINEL_ONLY";
    const fakeCodexAuth = join(codexHome, "auth.json");
    const fakeCodexConfig = join(codexHome, "config.toml");
    const fakeSshKey = join(sshHome, "id_ed25519");
    await writeFile(join(sibling, "outside.txt"), sentinel, { mode: 0o600 });
    await writeFile(parentSentinel, sentinel, { mode: 0o600 });
    await writeFile(fakeCodexAuth, sentinel, { mode: 0o600 });
    await writeFile(fakeCodexConfig, sentinel, { mode: 0o600 });
    await writeFile(fakeSshKey, sentinel, { mode: 0o600 });
    await symlink(join(sibling, "outside.txt"), join(root, "escape-link"));

    let tcpConnections = 0;
    const httpServer = createHttpServer((_req, res) => { res.end("fixture"); });
    httpServer.on("connection", () => { tcpConnections++; });
    const tcpServer = await new Promise<import("node:net").AddressInfo>((resolve) => {
      httpServer.listen(0, "127.0.0.1", () => resolve(httpServer.address() as import("node:net").AddressInfo));
    });
    const unixPath = join(parent, "host.sock");
    let unixConnections = 0;
    const unixServer = createNetServer((socket) => { unixConnections++; socket.end(); });
    await new Promise<void>((resolve) => unixServer.listen(unixPath, resolve));
    try {
      const policy = await createCodexProjectRuntimePolicy({ projectId: "h32-canary", projectRoot: root });
      process.env.H32_FAKE_CREDENTIAL_ENV = sentinel;
      let session;
      try {
        adapter = await CodexAppServerAdapter.createProjectScoped({ policy, cwd: root, requestTimeoutMs: 30_000 });
      } catch (error) {
        const message = (error as Error).message;
        expect(message).toMatch(/Codex project deny discovery incomplete|Codex project deny overlay did not isolate effective tools|project-scoped Codex tool isolation is not proven|does not advertise the required model|invalid transport in[\s\S]*AskHuman/);
        process.stdout.write(`${JSON.stringify({ model: "gpt-6-luna", canary: "NOT_RUN", gate: message })}\n`);
        return;
      }
      const probe = join(root, "probe.py");
      const probeId = randomUUID();
      const program = [
        "import json, os, pathlib, socket",
        `probe_id = ${JSON.stringify(probeId)}`,
        `root = pathlib.Path(${JSON.stringify(root)})`,
        `outside = pathlib.Path(${JSON.stringify(join(sibling, "outside.txt"))})`,
        `parent_file = pathlib.Path(${JSON.stringify(parentSentinel)})`,
        `fake_codex = pathlib.Path(${JSON.stringify(join(codexHome, "auth.json"))})`,
        `fake_codex_config = pathlib.Path(${JSON.stringify(join(codexHome, "config.toml"))})`,
        `fake_ssh = pathlib.Path(${JSON.stringify(join(sshHome, "id_ed25519"))})`,
        `shared_codex_auth = pathlib.Path(${JSON.stringify(join(process.env.CODEX_HOME || join(homedir(), ".codex"), "auth.json"))})`,
        `shared_codex_config = pathlib.Path(${JSON.stringify(join(process.env.CODEX_HOME || join(homedir(), ".codex"), "config.toml"))})`,
        "def can_read(path):\n try: path.read_text(); return True\n except OSError: return False",
        "def can_open(path):\n try: fd=os.open(path, os.O_RDONLY); os.close(fd); return True\n except OSError: return False",
        "def can_write(path):\n try: path.write_text('probe'); return True\n except OSError: return False",
        "def can_connect(address):\n try:\n  s=socket.create_connection(address, timeout=0.7); s.close(); return True\n except OSError: return False",
        "def can_connect_unix(path):\n try:\n  s=socket.socket(socket.AF_UNIX, socket.SOCK_STREAM); s.settimeout(0.7); s.connect(path); s.close(); return True\n except OSError: return False",
        "inside = root / 'inside-write.txt'",
        `tcp = (${JSON.stringify(tcpServer.address)}, ${tcpServer.port})`,
        `unix = ${JSON.stringify(unixPath)}`,
        "print(json.dumps({'probe_id': probe_id, 'inside_read': can_read(root / 'probe.py'), 'inside_write': can_write(inside), 'sibling_read': can_read(outside), 'parent_read': can_read(parent_file), 'sibling_write': can_write(outside.parent / 'escape-write.txt'), 'codex_auth_read': can_read(fake_codex), 'codex_config_read': can_read(fake_codex_config), 'shared_codex_auth_open': can_open(shared_codex_auth), 'shared_codex_config_open': can_open(shared_codex_config), 'ssh_key_read': can_read(fake_ssh), 'credential_env': os.environ.get('H32_FAKE_CREDENTIAL_ENV') is not None, 'symlink_read': can_read(root / 'escape-link'), 'host_tcp_connect': can_connect(tcp), 'host_unix_socket_connect': can_connect_unix(unix)}))",
      ].join("\n");
      await writeFile(probe, program, { mode: 0o600 });
      const probeHash = createHash("sha256").update(program).digest("hex");
      const policySha256 = createHash("sha256").update(JSON.stringify({
        policyRevision: policy.binding.policyRevision, profile: policy.permissionProfileId, model: policy.modelId,
        rootIdentity: policy.binding.rootIdentity, processArgs: (adapter as unknown as { processArgs: string[] }).processArgs,
      })).digest("hex");

      if (processProbeEnabled) {
        const rpc = adapter as unknown as {
          nextRequestId: number;
          request: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
        };
        const requestId = rpc.nextRequestId;
        let rawResult: unknown;
        try {
          rawResult = await rpc.request("command/exec", {
            command: ["python3", probe], cwd: root, permissionProfile: policy.permissionProfileId,
            timeoutMs: 30_000, outputBytesCap: 64_000,
          });
        } catch (error) {
          process.stdout.write(`${JSON.stringify({ model: null, canary: "NO_MODEL_PROCESS_PROBE", phase: "command/exec",
            requestId, threadId: null, turnId: null, probeSha256: probeHash, policySha256,
            error: (error as Error).message })}\n`);
          return;
        }
        const result = rawResult as { exitCode?: unknown; stdout?: unknown; stderr?: unknown };
        const stdout = typeof result.stdout === "string" ? result.stdout : "";
        const stderr = typeof result.stderr === "string" ? result.stderr : "";
        const expectedKeys = ["inside_read", "inside_write", "sibling_read", "parent_read", "sibling_write", "codex_auth_read", "codex_config_read",
          "shared_codex_auth_open", "shared_codex_config_open", "ssh_key_read", "credential_env", "symlink_read",
          "host_tcp_connect", "host_unix_socket_connect"] as const;
        const rows = stdout.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "").split(/\r?\n/).flatMap((line) => {
          try {
            const value = JSON.parse(line) as Record<string, unknown>;
            return value.probe_id === probeId ? [value] : [];
          } catch { return []; }
        });
        const probeAfter = await readFile(probe, "utf8");
        expect(createHash("sha256").update(probeAfter).digest("hex")).toBe(probeHash);
        if (result.exitCode !== 0 || rows.length !== 1) {
          process.stdout.write(`${JSON.stringify({ model: null, canary: "NO_MODEL_PROCESS_PROBE", phase: "command/exec-result",
            requestId, threadId: null, turnId: null, command: ["python3", probe], cwd: root, permissionProfile: policy.permissionProfileId,
            exitCode: result.exitCode, stdout, stderr, stdoutSha256: createHash("sha256").update(stdout).digest("hex"),
            stderrSha256: createHash("sha256").update(stderr).digest("hex"), probeSha256: probeHash, policySha256 })}\n`);
          return;
        }
        const parsed = rows[0]!;
        const observed = Object.fromEntries(expectedKeys.map((key) => [key, parsed[key]])) as Record<(typeof expectedKeys)[number], boolean>;
        const insideArtifact = await readFile(join(root, "inside-write.txt"), "utf8").catch(() => null);
        const outsideUnchanged = await readFile(join(sibling, "outside.txt"), "utf8").then((value) => value === sentinel).catch(() => false);
        const parentUnchanged = await readFile(parentSentinel, "utf8").then((value) => value === sentinel).catch(() => false);
        const fakeAuthUnchanged = await readFile(fakeCodexAuth, "utf8").then((value) => value === sentinel).catch(() => false);
        const fakeConfigUnchanged = await readFile(fakeCodexConfig, "utf8").then((value) => value === sentinel).catch(() => false);
        const fakeSshUnchanged = await readFile(fakeSshKey, "utf8").then((value) => value === sentinel).catch(() => false);
        const escapeWriteAbsent = await lstat(join(sibling, "escape-write.txt")).then(() => false).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT");
        const expected = {
          inside_read: true, inside_write: true, sibling_read: false, parent_read: false, sibling_write: false,
          codex_auth_read: false, codex_config_read: false, shared_codex_auth_open: false, shared_codex_config_open: false,
          ssh_key_read: false, credential_env: false, symlink_read: false, host_tcp_connect: false, host_unix_socket_connect: false,
        };
        const host = { insideArtifact, outsideUnchanged, parentUnchanged, fakeAuthUnchanged, fakeConfigUnchanged,
          fakeSshUnchanged, escapeWriteAbsent, tcpConnections, unixConnections };
        const isolationPass = result.exitCode === 0 && rows.length === 1 && JSON.stringify(observed) === JSON.stringify(expected)
          && insideArtifact === "probe" && outsideUnchanged && parentUnchanged && fakeAuthUnchanged && fakeConfigUnchanged
          && fakeSshUnchanged && escapeWriteAbsent && tcpConnections === 0 && unixConnections === 0;
        process.stdout.write(`${JSON.stringify({ model: null, canary: isolationPass ? "NO_MODEL_PROCESS_PROBE_PASS" : "NO_MODEL_PROCESS_PROBE_FAIL", requestId,
          threadId: null, turnId: null, command: ["python3", probe], cwd: root, permissionProfile: policy.permissionProfileId,
          exitCode: result.exitCode, stdout, stderr, stdoutSha256: createHash("sha256").update(stdout).digest("hex"),
          stderrSha256: createHash("sha256").update(stderr).digest("hex"), probeSha256: probeHash, policySha256,
          expected, observed, host })}\n`);
        expect(parsed).toMatchObject({ probe_id: probeId });
        expect(observed).toEqual(expected);
        expect(host).toMatchObject({ insideArtifact: "probe", outsideUnchanged: true, parentUnchanged: true,
          fakeAuthUnchanged: true, fakeConfigUnchanged: true, fakeSshUnchanged: true, escapeWriteAbsent: true,
          tcpConnections: 0, unixConnections: 0 });
        expect(isolationPass).toBe(true);
        return;
      }

      try {
        session = await adapter.createSession({ name: "H32 harmless confinement canary", cwd: root, model: "gpt-6-luna" });
      } catch (error) {
        const message = (error as Error).message;
        process.stdout.write(`${JSON.stringify({ model: "gpt-6-luna", canary: "NOT_RUN", phase: "thread-create",
          probeSha256: probeHash, policySha256, gate: message })}\n`);
        return;
      }
      const sent = await adapter.sendMessage(session.id, {
        model: "gpt-6-luna",
        message: `Execute exactly once and do not invoke any other command: python3 ${JSON.stringify(probe)}. Do not report or summarize results; the test reads the native command receipt.`,
      });
      if (!sent.ok) {
        process.stdout.write(`${JSON.stringify({ model: "gpt-6-luna", canary: "NOT_RUN", phase: "turn-admission",
          threadId: session.id, probeSha256: probeHash, policySha256, gate: sent.error })}\n`);
        return;
      }
      expect(sent).toMatchObject({ ok: true, turnId: expect.any(String) });
      // Only native commandExecution events are execution evidence; assistant
      // text and the general message buffer are intentionally not consulted.
      const receipts = (adapter as unknown as {
        projectCommandReceipts: Map<string, Array<{ itemId: string; turnId: string; command: string; cwd: string; status?: string; exitCode?: number | null; output: string }>>;
      }).projectCommandReceipts.get(session.id) ?? [];
      const receipt = receipts.find((item) => item.turnId === sent.turnId);
      const commandMatches = receipt ? isExactNativeProbeWrapper(receipt.command, probe) : false;
      if (!receipt || !commandMatches || receipt.status !== "completed" || receipt.exitCode !== 0) {
        process.stdout.write(`${JSON.stringify({ model: "gpt-6-luna", canary: "NOT_RUN", phase: "commandExecution-receipt",
          expected: { threadId: session.id, turnId: sent.turnId, command: `/bin/bash -lc 'python3 ${JSON.stringify(probe)}'`,
            cwd: root, status: "completed", exitCode: 0, probeSha256, policySha256 },
          observed: receipt ? { threadId: session.id, turnId: receipt.turnId, itemId: receipt.itemId, command: receipt.command,
            cwd: receipt.cwd, status: receipt.status, exitCode: receipt.exitCode,
            output: commandMatches ? receipt.output : "[redacted: command did not exactly match the fresh probe wrapper]" } : null })}\n`);
        return;
      }
      expect(receipt.cwd).toBe(root);
      const probeAfter = await readFile(probe, "utf8");
      expect(createHash("sha256").update(probeAfter).digest("hex")).toBe(probeHash);
      const expectedKeys = ["inside_read", "inside_write", "sibling_read", "parent_read", "sibling_write", "codex_auth_read", "codex_config_read",
        "shared_codex_auth_open", "shared_codex_config_open", "ssh_key_read", "credential_env", "symlink_read",
        "host_tcp_connect", "host_unix_socket_connect"] as const;
      const parsedRows = receipt.output.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "").split(/\r?\n/).flatMap((line) => {
        try {
          const value = JSON.parse(line) as Record<string, unknown>;
          return value.probe_id === probeId ? [value] : [];
        } catch { return []; }
      });
      expect(parsedRows).toHaveLength(1);
      const parsed = parsedRows[0]!;
      const observed = Object.fromEntries(expectedKeys.map((key) => [key, parsed[key]])) as Record<(typeof expectedKeys)[number], boolean>;
      expect(parsed).toMatchObject({ probe_id: probeId });
      expect(observed).toEqual({
        inside_read: true,
        inside_write: true,
        sibling_read: false,
        parent_read: false,
        sibling_write: false,
        codex_auth_read: false,
        codex_config_read: false,
        shared_codex_auth_open: false,
        shared_codex_config_open: false,
        ssh_key_read: false,
        credential_env: false,
        symlink_read: false,
        host_tcp_connect: false,
        host_unix_socket_connect: false,
      });
      const insideArtifact = await readFile(join(root, "inside-write.txt"), "utf8");
      expect(insideArtifact).toBe("probe");
      expect(await readFile(join(sibling, "outside.txt"), "utf8")).toBe(sentinel);
      expect(await readFile(parentSentinel, "utf8")).toBe(sentinel);
      expect(await readFile(fakeCodexAuth, "utf8")).toBe(sentinel);
      expect(await readFile(fakeCodexConfig, "utf8")).toBe(sentinel);
      expect(await readFile(fakeSshKey, "utf8")).toBe(sentinel);
      await expect(lstat(join(sibling, "escape-write.txt"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(tcpConnections).toBe(0);
      expect(unixConnections).toBe(0);
      process.stdout.write(`${JSON.stringify({ model: "gpt-6-luna", canary: "PASS", threadId: session.id,
        turnId: sent.turnId, permissionProfile: policy.permissionProfileId, policySha256,
        receipt: { itemId: receipt.itemId, command: receipt.command, cwd: receipt.cwd, status: receipt.status, exitCode: receipt.exitCode, output: receipt.output },
        probeSha256: probeHash, expected: { inside_read: true, inside_write: true, allEscapeProbes: false }, observed,
        host: { insideArtifact, outsideSentinelUnchanged: true, escapeWriteAbsent: true, tcpConnections, unixConnections } })}\n`);
    } finally {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      await new Promise<void>((resolve) => unixServer.close(() => resolve()));
    }
  }, 300_000);
});
