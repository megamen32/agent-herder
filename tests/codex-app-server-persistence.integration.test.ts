import { afterEach, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { CodexAppServerAdapter } from "../src/adapters/codex-app-server.js";
import { CODEX_PROJECT_MODEL_ID, createCodexProjectRuntimePolicy, restoreCodexProjectRuntimePolicy } from "../src/project-runtime-policy.js";
import { IntegratorSessionBindingStore } from "../src/integrator-session-binding.js";

const enabled = process.env.AGENT_HERDER_CODEX_PERSISTENCE_METADATA_TEST === "1";
const materializedEnabled = process.env.AGENT_HERDER_CODEX_MATERIALIZED_RESTART_TEST === "1";
const CODEX_BIN = "/home/roomhacker/.codex/packages/standalone/releases/0.162.1-x86_64-unknown-linux-musl/bin/codex";
const CODEX_SHA256 = "628e35487d888a28f0427fc37501da529dd3d81fcbad7a2c3421c1e8670d92e1";
const MODEL_ID = "gpt-6-luna";
const ALLOWED_METHODS = new Set(["initialize", "thread/start", "thread/read", "thread/resume"]);
const temporaryRoots: string[] = [];
const ownedProcesses = new Set<StdioAppServer>();

class NativeRpcError extends Error {
  constructor(message: string, readonly code?: number) { super(message); }
}

type PendingRequest = {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
};

class StdioAppServer {
  readonly methods: string[] = [];
  readonly serverRequests: string[] = [];
  readonly notifications: string[] = [];
  private readonly pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private buffer = "";
  private stderr = "";
  private exitInfo: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  private readonly exited: Promise<void>;

  private constructor(readonly child: ChildProcessWithoutNullStreams) {
    this.exited = new Promise((resolve) => {
      child.once("exit", (code, signal) => {
        this.exitInfo = { code, signal };
        for (const request of this.pending.values()) {
          clearTimeout(request.timer);
          request.reject(new Error(`Codex app-server exited (${code ?? signal ?? "unknown"})`));
        }
        this.pending.clear();
        resolve();
      });
      child.once("error", (error) => {
        for (const request of this.pending.values()) {
          clearTimeout(request.timer);
          request.reject(error);
        }
        this.pending.clear();
        resolve();
      });
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.consumeStdout(chunk));
    child.stderr.on("data", (chunk: string) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-4_000);
    });
  }

  static start(input: { env: NodeJS.ProcessEnv; cwd: string }): StdioAppServer {
    const child = spawn(CODEX_BIN, ["app-server"], {
      cwd: input.cwd,
      env: input.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    }) as ChildProcessWithoutNullStreams;
    return new StdioAppServer(child);
  }

  async initialize(): Promise<unknown> {
    const result = await this.request("initialize", {
      clientInfo: { name: "agent-herder-persistence-metadata-test", version: "1.0.0" },
      capabilities: { experimentalApi: true },
    });
    this.notify("initialized", {});
    return result;
  }

  request(method: string, params: Record<string, unknown>, timeoutMs = 20_000): Promise<unknown> {
    if (!ALLOWED_METHODS.has(method)) throw new Error(`forbidden app-server method in no-inference test: ${method}`);
    this.methods.push(method);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`, (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.reject(error);
      });
    });
  }

  notify(method: string, params: Record<string, unknown>): void {
    if (method !== "initialized") throw new Error(`forbidden app-server notification in no-inference test: ${method}`);
    this.child.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  resultSummary() {
    return {
      methods: [...this.methods],
      serverRequests: [...this.serverRequests],
      notifications: [...this.notifications],
      exit: this.exitInfo,
      stderr: this.stderr,
    };
  }

  async stop(): Promise<void> {
    if (!this.exitInfo) {
      this.child.kill("SIGTERM");
      await Promise.race([this.exited, delay(3_000)]);
    }
    if (!this.exitInfo) {
      this.child.kill("SIGKILL");
      await Promise.race([this.exited, delay(2_000)]);
    }
    ownedProcesses.delete(this);
  }

  private consumeStdout(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message: Record<string, unknown>;
      try { message = JSON.parse(line) as Record<string, unknown>; }
      catch { continue; }
      if (typeof message.id === "number") {
        const request = this.pending.get(message.id);
        if (request) {
          clearTimeout(request.timer);
          this.pending.delete(message.id);
          if (message.error && typeof message.error === "object") {
            const error = message.error as { code?: unknown; message?: unknown };
            request.reject(new NativeRpcError(
              typeof error.message === "string" ? error.message : "Codex app-server returned an RPC error",
              typeof error.code === "number" ? error.code : undefined,
            ));
          } else request.resolve(message.result);
          continue;
        }
        if (typeof message.method === "string") {
          this.serverRequests.push(message.method);
          this.child.stdin.write(`${JSON.stringify({ id: message.id, error: { code: -32601, message: "server requests are forbidden in metadata-only test" } })}\n`);
          continue;
        }
      }
      if (typeof message.method === "string") this.notifications.push(message.method);
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function record(label: string, value: unknown): void {
  process.stdout.write(`[codex-persistence-metadata] ${label} ${JSON.stringify(value)}\n`);
}

function testChildEnvironment(input: { home: string; codexHome: string; temp: string }): NodeJS.ProcessEnv {
  return {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    HOME: input.home,
    CODEX_HOME: input.codexHome,
    CODEX_DATA_DIR: input.codexHome,
    XDG_CONFIG_HOME: join(input.codexHome, "xdg-config"),
    XDG_DATA_HOME: join(input.codexHome, "xdg-data"),
    XDG_CACHE_HOME: join(input.codexHome, "xdg-cache"),
    TMPDIR: input.temp,
    LANG: "C.UTF-8",
  };
}

function threadState(response: unknown) {
  if (!response || typeof response !== "object") throw new Error("Codex app-server response is not an object");
  const value = response as Record<string, unknown>;
  if (!value.thread || typeof value.thread !== "object") throw new Error("Codex app-server response has no Thread");
  const thread = value.thread as Record<string, unknown>;
  return {
    id: thread.id,
    cwd: thread.cwd,
    ephemeral: thread.ephemeral,
    responseCwd: value.cwd,
    approvalPolicy: value.approvalPolicy,
    sandbox: value.sandbox,
    runtimeWorkspaceRoots: value.runtimeWorkspaceRoots,
    activePermissionProfile: value.activePermissionProfile,
  };
}

afterEach(async () => {
  await Promise.all([...ownedProcesses].map((server) => server.stop()));
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Codex app-server persistent metadata restart", () => {
  it.skipIf(!enabled)("retains one explicit non-ephemeral thread across two isolated server processes without a turn", async () => {
    const binarySha256 = createHash("sha256").update(await readFile(CODEX_BIN)).digest("hex");
    expect(binarySha256).toBe(CODEX_SHA256);

    const projectTmp = join(process.cwd(), ".tmp");
    await mkdir(projectTmp, { recursive: true, mode: 0o700 });
    const testRoot = await mkdtemp(join(projectTmp, "codex-persistence-metadata-"));
    temporaryRoots.push(testRoot);
    const projectRoot = join(testRoot, "project");
    const home = join(testRoot, "home");
    const codexHome = join(testRoot, "codex-home");
    const temp = join(testRoot, "tmp");
    await Promise.all([mkdir(projectRoot), mkdir(home), mkdir(codexHome), mkdir(temp)]);
    const env = testChildEnvironment({ home, codexHome, temp });

    let first: StdioAppServer | undefined;
    let second: StdioAppServer | undefined;
    let createdThreadId: string | undefined;
    let createState: ReturnType<typeof threadState> | undefined;
    try {
      first = StdioAppServer.start({ env, cwd: projectRoot });
      ownedProcesses.add(first);
      await first.initialize();
      let created: unknown;
      try {
        created = await first.request("thread/start", {
          cwd: projectRoot,
          model: MODEL_ID,
          ephemeral: false,
          approvalPolicy: "untrusted",
          sandbox: "read-only",
          runtimeWorkspaceRoots: [projectRoot],
        });
      } catch (error) {
        record("falsifier", {
          step: "thread/start",
          reason: error instanceof NativeRpcError ? { code: error.code, message: error.message } : (error as Error).message,
          binary: CODEX_BIN,
          binarySha256,
          projectRoot,
          codexHome,
          process: first.resultSummary(),
        });
        throw error;
      }
      createState = threadState(created);
      if (typeof createState.id !== "string" || !createState.id) throw new Error("thread/start returned no exact native thread ID");
      createdThreadId = createState.id;
      record("thread-start", { expected: { ephemeral: false, cwd: projectRoot, model: MODEL_ID,
        sandbox: "read-only", runtimeWorkspaceRoots: [projectRoot] }, observed: createState,
        binarySha256, projectRoot, codexHome, process: first.resultSummary() });
      expect(createState.ephemeral).toBe(false);
      expect(createState.cwd).toBe(projectRoot);
      expect(createState.responseCwd).toBe(projectRoot);
      expect(createState.runtimeWorkspaceRoots).toEqual([projectRoot]);
      expect(createState.sandbox).toMatchObject({ type: "readOnly" });
      expect(createState.approvalPolicy).toBe("untrusted");
      expect(first.methods).toEqual(["initialize", "thread/start"]);
      expect(first.serverRequests).toEqual([]);
      await first.stop();
      first = undefined;

      second = StdioAppServer.start({ env, cwd: projectRoot });
      ownedProcesses.add(second);
      await second.initialize();
      let read: unknown;
      let readError: unknown;
      try {
        read = await second.request("thread/read", { threadId: createdThreadId, includeTurns: false });
      } catch (error) {
        readError = error;
        record("thread-read-not-loaded", {
          threadId: createdThreadId,
          reason: error instanceof NativeRpcError ? { code: error.code, message: error.message } : (error as Error).message,
          continuingToExactIdResume: true,
          binarySha256,
          projectRoot,
          codexHome,
          process: second.resultSummary(),
        });
      }
      if (read !== undefined) {
        const readState = threadState(read);
        record("thread-read-after-restart", { threadId: createdThreadId, expected: createState, observed: readState,
          binarySha256, projectRoot, codexHome, process: second.resultSummary() });
        expect(readState.id).toBe(createdThreadId);
        expect(readState.ephemeral).toBe(false);
        expect(readState.cwd).toBe(projectRoot);
      } else if (!(readError instanceof NativeRpcError)
        || readError.message !== `thread not loaded: ${createdThreadId}`) {
        throw readError instanceof Error ? readError : new Error("thread/read after restart failed unexpectedly");
      }

      let resumed: unknown;
      try {
        resumed = await second.request("thread/resume", {
          threadId: createdThreadId,
          cwd: projectRoot,
          model: MODEL_ID,
          approvalPolicy: "untrusted",
          sandbox: "read-only",
          runtimeWorkspaceRoots: [projectRoot],
        });
      } catch (error) {
        record("falsifier", {
          step: "thread/resume-after-restart",
          threadId: createdThreadId,
          reason: error instanceof NativeRpcError ? { code: error.code, message: error.message } : (error as Error).message,
          binarySha256,
          projectRoot,
          codexHome,
          process: second.resultSummary(),
        });
        throw error;
      }
      const resumeState = threadState(resumed);
      record("thread-resume-after-restart", { threadId: createdThreadId, expected: createState, observed: resumeState,
        binarySha256, projectRoot, codexHome, process: second.resultSummary() });
      expect(resumeState.id).toBe(createdThreadId);
      expect(resumeState.ephemeral).toBe(false);
      expect(resumeState.cwd).toBe(projectRoot);
      expect(resumeState.responseCwd).toBe(projectRoot);
      expect(resumeState.runtimeWorkspaceRoots).toEqual([projectRoot]);
      expect(resumeState.sandbox).toMatchObject({ type: "readOnly" });
      expect(resumeState.approvalPolicy).toBe("untrusted");

      const unknownId = randomUUID();
      let unknownDenied = false;
      try {
        const unknownRead = await second.request("thread/read", { threadId: unknownId, includeTurns: false });
        const recordValue = unknownRead && typeof unknownRead === "object" ? unknownRead as Record<string, unknown> : {};
        const threadValue = recordValue.thread && typeof recordValue.thread === "object"
          ? recordValue.thread as Record<string, unknown> : null;
        unknownDenied = !threadValue || threadValue.id !== unknownId;
        record("unknown-id-read", { unknownId, result: threadValue ? {
          id: threadValue.id, cwd: threadValue.cwd, ephemeral: threadValue.ephemeral,
        } : null, denied: unknownDenied });
      } catch (error) {
        unknownDenied = error instanceof NativeRpcError || /no Thread/i.test((error as Error).message);
        record("unknown-id-read", { unknownId, denied: unknownDenied,
          reason: error instanceof NativeRpcError ? { code: error.code, message: error.message } : (error as Error).message });
      }
      expect(unknownDenied).toBe(true);
      expect(second.serverRequests).toEqual([]);
      expect(second.methods).toEqual(["initialize", "thread/read", "thread/resume", "thread/read"]);
    } finally {
      await first?.stop();
      await second?.stop();
    }
  });
});

function exactProbeCommand(observed: string, expected: string): boolean {
  if (observed === expected) return true;
  const prefix = "/bin/bash -lc ";
  if (!observed.startsWith(prefix)) return false;
  const shellQuoted = `'${expected.replace(/'/g, "'\\''")}'`;
  return observed.slice(prefix.length) === shellQuoted || observed.slice(prefix.length) === JSON.stringify(expected);
}

function persistPrivateReceipt(path: string, value: Record<string, unknown>): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "w" });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
}

describe("Codex materialized project-owned restart vertical", () => {
  it("atomically preserves private nonsecret phase and observed IDs outside the project cleanup root", async () => {
    const projectTmp = join(process.cwd(), ".tmp");
    await mkdir(projectTmp, { recursive: true, mode: 0o700 });
    const receiptRoot = await mkdtemp(join(projectTmp, "codex-materialized-receipt-unit-"));
    temporaryRoots.push(receiptRoot);
    const receiptPath = join(receiptRoot, "case.json");
    persistPrivateReceipt(receiptPath, { caseId: "case", operationId: "operation", phase: "reserved", inputId: "input" });
    persistPrivateReceipt(receiptPath, { caseId: "case", operationId: "operation", phase: "native_created",
      inputId: "input", threadId: "native-thread" });
    const saved = JSON.parse(await readFile(receiptPath, "utf8")) as Record<string, unknown>;
    expect(saved).toMatchObject({ operationId: "operation", phase: "native_created", inputId: "input", threadId: "native-thread" });
    expect((await stat(receiptPath)).mode & 0o777).toBe(0o600);
    expect((await stat(receiptRoot)).mode & 0o777).toBe(0o700);
  });

  it.skipIf(!materializedEnabled)("executes once, persists the accepted H34 ID, and resumes that exact native archive after adapter restart", async () => {
    const binarySha256 = createHash("sha256").update(await readFile(CODEX_BIN)).digest("hex");
    expect(binarySha256).toBe(CODEX_SHA256);
    const nativeHome = resolve(process.env.CODEX_HOME || join(homedir(), ".codex"));
    const projectTmp = join(process.cwd(), ".tmp");
    await mkdir(projectTmp, { recursive: true, mode: 0o700 });
    const testRoot = await mkdtemp(join(projectTmp, "codex-materialized-restart-"));
    const receiptDirectory = join(projectTmp, "codex-materialized-restart-receipts");
    const caseId = randomUUID();
    const receiptPath = join(receiptDirectory, `${caseId}.json`);
    const projectRoot = join(testRoot, "project");
    await mkdir(projectRoot, { mode: 0o700 });
    const journalPath = join(testRoot, "integrator-session-bindings.json");
    const store = new IntegratorSessionBindingStore({ persistencePath: journalPath });
    const policy = await createCodexProjectRuntimePolicy({ projectId: `h32-${randomUUID()}`, projectRoot, materialized: true });
    const progressState: Record<string, unknown> = {
      caseId, operationId: policy.binding.attemptId, phase: "policy_created", journalState: "not_reserved",
      threadId: null, turnId: null, itemId: null, updatedAt: new Date().toISOString(),
    };
    const persistProgress = (progress?: Record<string, unknown>) => {
      if (progress) {
        for (const [key, value] of Object.entries(progress)) if (value !== undefined) progressState[key] = value;
      }
      progressState.updatedAt = new Date().toISOString();
      persistPrivateReceipt(receiptPath, progressState);
    };
    persistProgress();
    let currentStage = "policy_created";
    const runtimeOwner = {
      resolve: async (binding: typeof policy.binding) => binding.projectId === policy.binding.projectId
        && binding.attemptId === policy.binding.attemptId && binding.rootIdentity === policy.binding.rootIdentity
        && binding.policyRevision === policy.binding.policyRevision && binding.hostId === policy.binding.hostId
        ? { kind: "trusted" as const, binding: { ...binding }, issuedAtMs: Date.now(), expiresAtMs: Date.now() + 20_000 }
        : null,
    };
    const lifecycleSignal = AbortSignal.timeout(180_000);
    const ownedAdapters = new Set<CodexAppServerAdapter>();
    const probeNonce = randomUUID();
    const probeSource = `import json\nfrom pathlib import Path\nnonce = ${JSON.stringify(probeNonce)}\nartifact = Path("artifact.json")\nartifact.write_text(json.dumps({"nonce": nonce}, sort_keys=True) + "\\n", encoding="utf-8")\nprint(artifact.read_text(encoding="utf-8"), end="")\n`;
    const probePath = join(projectRoot, "probe.py");
    const artifactPath = join(projectRoot, "artifact.json");
    await writeFile(probePath, probeSource, { mode: 0o600, flag: "wx" });
    const probeHash = createHash("sha256").update(probeSource).digest("hex");
    const expectedCommand = "python3 probe.py";
    const prompt = `Run this exact command once from the project root: ${expectedCommand}. Do not change it or run any other command. Return no claim that is not in the command output.`;
    const promptHash = createHash("sha256").update(prompt).digest("hex");
    const firstPolicyHash = createHash("sha256").update(JSON.stringify({
      binding: policy.binding, rootPath: policy.rootPath, rootDevice: policy.rootDevice, rootInode: policy.rootInode,
      profile: policy.permissionProfileId, model: policy.modelId, revision: policy.binding.policyRevision,
    })).digest("hex");
    let first: CodexAppServerAdapter | undefined;
    let second: CodexAppServerAdapter | undefined;
    let threadId: string | undefined;
    let terminalSuccess = false;
    try {
      currentStage = "create_project_scoped_adapter";
      first = await CodexAppServerAdapter.createProjectScoped({ policy, codexBin: CODEX_BIN, cwd: projectRoot,
        codexDir: nativeHome, integratorSessionBindingStore: store, projectRuntimeOwner: runtimeOwner,
        signal: lifecycleSignal, onOwnedAdapter: adapter => ownedAdapters.add(adapter),
        onMaterializationProgress: (event) => {
          currentStage = event.phase;
          persistProgress({ ...event, journalState: event.phase === "reserved" ? "intent" : progressState.journalState });
        } });
      const firstInventory = await (first as unknown as { readProjectToolInventory(threadId?: string): Promise<{ complete: boolean; active: boolean; summary: string }> })
        .readProjectToolInventory();
      if (!firstInventory.complete || firstInventory.active) throw new Error(`effective native integrations not closed: ${firstInventory.summary}`);
      currentStage = "native_thread_create";
      const thread = await first.createSession({ name: "H32 materialized restart canary", cwd: projectRoot, model: CODEX_PROJECT_MODEL_ID });
      threadId = thread.id;
      const accepted = await store.get(policy.binding.attemptId);
      if (accepted?.state !== "accepted" || accepted.attempts.at(-1)?.address?.nativeSessionId !== threadId) {
        throw new Error("H34 did not durably accept the exact materialized native thread ID");
      }
      persistProgress({ phase: "accepted", journalState: accepted.state, threadId,
        inputId: accepted.attempts.at(-1)?.inputId, nativeReceiptState: accepted.attempts.at(-1)?.receipt?.state });
      currentStage = "first_luna_turn";
      const commandResult = await first.sendMessage(threadId, { message: prompt, model: CODEX_PROJECT_MODEL_ID, origin: "human" });
      if (!commandResult.ok || !commandResult.turnId) throw new Error(`first bounded Luna turn failed: ${JSON.stringify(commandResult)}`);
      persistProgress({ phase: "turn_result_observed", threadId, turnId: commandResult.turnId,
        turnOk: commandResult.ok, admissionUnknown: commandResult.admissionUnknown ?? false });
      const firstInternals = first as unknown as { projectCommandReceipts: Map<string, Array<{
        itemId: string; turnId: string; command: string; cwd: string; status?: string; exitCode?: number | null; output: string;
      }>>; processArgs: string[]; appServerDataHome: string; transcriptReaderDataHome: string };
      const receipt = firstInternals.projectCommandReceipts.get(threadId)?.find((item) => item.turnId === commandResult.turnId);
      if (!receipt || receipt.turnId !== commandResult.turnId || !receipt.itemId
        || receipt.cwd !== projectRoot || !exactProbeCommand(receipt.command, expectedCommand)
        || receipt.exitCode !== 0 || receipt.status !== "completed" || !receipt.output.includes(probeNonce)) {
        throw new Error(`native commandExecution receipt did not prove the exact fresh probe: ${JSON.stringify(receipt ?? null)}`);
      }
      persistProgress({ phase: "command_receipt_verified", itemId: receipt.itemId, threadId, turnId: receipt.turnId,
        commandSha256: createHash("sha256").update(receipt.command).digest("hex"), outputSha256: createHash("sha256").update(receipt.output).digest("hex"),
        commandStatus: receipt.status, commandExitCode: receipt.exitCode, commandCwd: receipt.cwd,
        expectedNonceObserved: receipt.output.includes(probeNonce) });
      const artifact = await readFile(artifactPath, "utf8");
      const artifactValue = JSON.parse(artifact) as { nonce?: string };
      if (artifactValue.nonce !== probeNonce) throw new Error("host readback did not match the fresh project artifact nonce");
      const artifactHash = createHash("sha256").update(artifact).digest("hex");
      const firstTranscript = await first.getRawTranscript(threadId);
      if (!firstTranscript?.complete || firstTranscript.source.kind !== "native-file") {
        throw new Error("pre-restart native archive was not a complete native file read");
      }
      const firstTranscriptHash = createHash("sha256").update(firstTranscript.bytes).digest("hex");
      const firstEvidence = await first.resolveCurrentProjectScope({
        projectId: policy.binding.projectId, rootIdentity: policy.binding.rootIdentity,
        policyRevision: policy.binding.policyRevision, hostId: policy.binding.hostId, harness: "codex",
      });
      if (!firstEvidence) throw new Error("pre-restart current scope evidence unavailable");
      const firstProcessArgsHash = createHash("sha256").update(JSON.stringify(firstInternals.processArgs)).digest("hex");
      await first.dispose();
      first = undefined;

      const restoredPolicy = await restoreCodexProjectRuntimePolicy({ projectId: policy.binding.projectId, projectRoot,
        operationId: policy.binding.attemptId, store, nativeDataHome: nativeHome });
      persistProgress({ phase: "restart_policy_rebuilt", threadId, restoredRuntimeInstanceId: restoredPolicy.binding.runtimeInstanceId });
      currentStage = "restart_adapter_create";
      second = await CodexAppServerAdapter.createProjectScoped({ policy: restoredPolicy, codexBin: CODEX_BIN,
        cwd: projectRoot, codexDir: nativeHome, integratorSessionBindingStore: store, projectRuntimeOwner: runtimeOwner,
        signal: lifecycleSignal, onOwnedAdapter: adapter => ownedAdapters.add(adapter),
        onMaterializationProgress: (event) => {
          currentStage = event.phase;
          persistProgress({ ...event });
        } });
      currentStage = "same_id_restore";
      const restoreResult = await second.restoreMaterializedSession();
      if (!restoreResult.ok || restoreResult.sessionId !== threadId) {
        throw new Error(`same-ID native restore failed: ${JSON.stringify(restoreResult)}`);
      }
      const restoredHistory = await second.getRawTranscript(threadId);
      if (!restoredHistory?.complete || restoredHistory.source.kind !== "native-file") {
        throw new Error("post-restart same-ID history did not come from a complete native archive");
      }
      const historyText = new TextDecoder().decode(restoredHistory.bytes);
      if (!historyText.includes(threadId) || !historyText.includes(probeNonce)) {
        throw new Error("post-restart native archive does not contain the exact owned thread and probe receipt");
      }
      const transcriptHash = createHash("sha256").update(restoredHistory.bytes).digest("hex");
      persistProgress({ phase: "native_archive_verified", journalState: "accepted", threadId,
        restoredTranscriptSha256: transcriptHash });
      const secondInternals = second as unknown as { processArgs: string[]; appServerDataHome: string; transcriptReaderDataHome: string };
      const secondEvidence = await second.resolveCurrentProjectScope({
        projectId: restoredPolicy.binding.projectId, rootIdentity: restoredPolicy.binding.rootIdentity,
        policyRevision: restoredPolicy.binding.policyRevision, hostId: restoredPolicy.binding.hostId, harness: "codex",
      });
      if (!secondEvidence || restoredPolicy.binding.runtimeInstanceId === policy.binding.runtimeInstanceId) {
        throw new Error("post-restart fresh current runtime proof was not observed");
      }
      record("materialized-restart-pass", {
        expected: { model: CODEX_PROJECT_MODEL_ID, ephemeral: false, sameThreadId: true, operationId: policy.binding.attemptId,
          profile: policy.permissionProfileId, exactCommand: expectedCommand, artifactNonce: probeNonce },
        observed: { threadId, operationId: accepted.operationId, turnId: commandResult.turnId, commandItemId: receipt.itemId,
          commandSha256: createHash("sha256").update(receipt.command).digest("hex"), cwd: receipt.cwd,
          commandStatus: receipt.status, commandExitCode: receipt.exitCode, outputSha256: createHash("sha256").update(receipt.output).digest("hex"),
          expectedNonceObserved: receipt.output.includes(probeNonce), artifactSha256: artifactHash,
          probeSha256: probeHash, promptSha256: promptHash,
          policySha256: firstPolicyHash, firstProcessArgsSha256: firstProcessArgsHash,
          firstTranscriptSha256: firstTranscriptHash, restoredTranscriptSha256: transcriptHash,
          firstRuntimeInstanceId: policy.binding.runtimeInstanceId, restoredRuntimeInstanceId: restoredPolicy.binding.runtimeInstanceId,
          firstScope: firstEvidence, restoredScope: secondEvidence,
          appServerDataHome: secondInternals.appServerDataHome, transcriptReaderDataHome: secondInternals.transcriptReaderDataHome,
          processArgsSha256: createHash("sha256").update(JSON.stringify(secondInternals.processArgs)).digest("hex"),
          nativeBinarySha256: binarySha256, model: thread.model,
          toolInventory: { complete: firstInventory.complete, active: firstInventory.active,
            summarySha256: createHash("sha256").update(firstInventory.summary).digest("hex") },
          journalState: accepted.state, journalAttempt: accepted.attempts.at(-1),
          archiveSource: restoredHistory.source, archiveComplete: restoredHistory.complete },
      });
      await second.dispose();
      second = undefined;
      persistProgress({ phase: "terminal_success_cleanup", journalState: "accepted", threadId,
        turnId: commandResult.turnId, itemId: receipt.itemId, cleanupAuthorized: true });
      await rm(testRoot, { recursive: true, force: true });
      terminalSuccess = true;
      persistProgress({ cleanupComplete: true });
    } catch (error) {
      const current = await store.get(policy.binding.attemptId).catch(() => null);
      const last = current?.attempts.at(-1);
      persistProgress({ phase: "failure", failureStage: currentStage, failureType: error instanceof Error ? error.name : "unknown",
        journalState: current?.state ?? "unknown", inputId: last?.inputId,
        ...(last?.address?.nativeSessionId ? { threadId: last.address.nativeSessionId } : {}),
        ...(last?.receipt ? { nativeReceiptState: last.receipt.state } : {}), retainedProjectRoot: true });
      record("materialized-restart-failure", { caseId, operationId: policy.binding.attemptId,
        inputId: last?.inputId ?? null, threadId: last?.address?.nativeSessionId ?? progressState.threadId ?? null,
        turnId: progressState.turnId ?? null, itemId: progressState.itemId ?? null,
        phase: currentStage, journalState: current?.state ?? "unknown", retainedProjectRoot: testRoot, receiptPath });
      throw error;
    } finally {
      await first?.dispose();
      await second?.dispose();
      await Promise.all([...ownedAdapters].map(adapter => adapter.dispose()));
      if (!terminalSuccess) persistProgress({ retainedProjectRoot: testRoot, cleanupComplete: false });
    }
  }, 190_000);
});
