import { afterEach, describe, expect, it } from "vitest";
import { accessSync, constants as fsConstants, realpathSync } from "node:fs";
import { mkdtemp, mkdir, realpath, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { homedir } from "node:os";
import { hostname } from "node:os";
import { delimiter, join } from "node:path";
import {
  CODEX_PROJECT_PERMISSION_PROFILE,
  CODEX_PROJECT_MODEL_ID,
  assertCodexProjectRoot,
  codexProjectAppServerArgs,
  codexProjectIntegrationFeatureDeny,
  codexProjectNativeWebSearch,
  codexProjectDiscoveryDenyList,
  codexProjectFilesystemProfileDeny,
  codexProjectPermissionObserved,
  codexProjectResumeParams,
  codexProjectThreadParams,
  codexProjectTurnParams,
  createCodexProjectRuntimePolicy,
  restoreCodexProjectRuntimePolicy,
} from "../src/project-runtime-policy.js";
import { IntegratorSessionBindingStore } from "../src/integrator-session-binding.js";

const temporaryRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agent-herder-project-policy-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("native Codex project runtime policy", () => {
  it("binds normalized project roots to one attempt, host and runtime instance", async () => {
    const root = await temporaryRoot();
    const policy = await createCodexProjectRuntimePolicy({ projectId: "project-a", projectRoot: root });

    expect(policy.binding).toMatchObject({
      projectId: "project-a",
      rootIdentity: expect.stringContaining(await realpath(root)),
      policyRevision: "codex-native-project-v2",
      hostId: expect.any(String),
      runtimeInstanceId: expect.any(String),
      attemptId: expect.any(String),
    });
    expect(policy.permissionProfileId).toBe(CODEX_PROJECT_PERMISSION_PROFILE);
    expect(policy.modelId).toBe(CODEX_PROJECT_MODEL_ID);
    await expect(assertCodexProjectRoot(policy, root)).resolves.toBeUndefined();
  });

  it("restores a stable H34 operation only from its accepted matching scope and gives it a fresh runtime instance", async () => {
    const root = await temporaryRoot();
    const home = await temporaryRoot();
    const store = new IntegratorSessionBindingStore({ persistencePath: join(root, "journal.json") });
    const first = await createCodexProjectRuntimePolicy({ projectId: "restart-project", projectRoot: root, materialized: true });
    const rootStat = await stat(root);
    const homeStat = await stat(home);
    const scope = {
      projectId: first.binding.projectId,
      rootIdentity: first.binding.rootIdentity,
      policyRevision: first.binding.policyRevision,
      hostId: hostname(),
      harness: "codex" as const,
      harnessVersion: "codex-test-version",
      canonicalRoot: { path: root, device: rootStat.dev, inode: rootStat.ino },
      nativeDataHome: { path: home, device: homeStat.dev, inode: homeStat.ino },
    };
    const reservation = await store.reserve({ operationId: first.binding.attemptId, hostId: hostname(), harness: "codex", scope });
    await store.record({ operationId: first.binding.attemptId, attempt: reservation.attempt.attempt,
      receipt: { state: "created", inputId: reservation.attempt.inputId,
        address: { hostId: hostname(), harness: "codex", nativeSessionId: "native-restart-id" },
        launchCwd: root, retryable: false } });

    const restored = await restoreCodexProjectRuntimePolicy({ projectId: "restart-project", projectRoot: root,
      operationId: first.binding.attemptId, store, nativeDataHome: home });
    expect(restored.binding.attemptId).toBe(first.binding.attemptId);
    expect(restored.binding.runtimeInstanceId).not.toBe(first.binding.runtimeInstanceId);
    expect(restored.materialized).toBe(true);
    expect(restored.acceptedSession).toMatchObject({ operationId: first.binding.attemptId,
      address: { nativeSessionId: "native-restart-id", harness: "codex" } });

    await expect(restoreCodexProjectRuntimePolicy({ projectId: "other-project", projectRoot: root,
      operationId: first.binding.attemptId, store, nativeDataHome: home })).rejects.toThrow("no matching accepted scoped H34 record");
    await expect(restoreCodexProjectRuntimePolicy({ projectId: "restart-project", projectRoot: root,
      operationId: "caller-chosen-id", store, nativeDataHome: home })).rejects.toThrow("no matching accepted scoped H34 record");
  });

  it("persists live-search policy in H34 scope and rejects restore after the mode changes", async () => {
    const root = await temporaryRoot();
    const home = await temporaryRoot();
    const store = new IntegratorSessionBindingStore({ persistencePath: join(root, "search-journal.json") });
    const policy = await createCodexProjectRuntimePolicy({ projectId: "integrator-search", projectRoot: root,
      materialized: true, nativeWebSearchMode: "live" });
    const rootStat = await stat(root);
    const homeStat = await stat(home);
    const reservation = await store.reserve({ operationId: policy.binding.attemptId, hostId: hostname(), harness: "codex",
      scope: { projectId: policy.binding.projectId, rootIdentity: policy.binding.rootIdentity,
        policyRevision: policy.binding.policyRevision, hostId: hostname(), harness: "codex", harnessVersion: "codex-test-version",
        canonicalRoot: { path: root, device: rootStat.dev, inode: rootStat.ino },
        nativeDataHome: { path: home, device: homeStat.dev, inode: homeStat.ino } } });
    await store.record({ operationId: policy.binding.attemptId, attempt: reservation.attempt.attempt,
      receipt: { state: "created", inputId: reservation.attempt.inputId,
        address: { hostId: hostname(), harness: "codex", nativeSessionId: "live-search-thread" }, launchCwd: root, retryable: false } });
    const restored = await restoreCodexProjectRuntimePolicy({ projectId: "integrator-search", projectRoot: root,
      operationId: policy.binding.attemptId, store, nativeDataHome: home, nativeWebSearchMode: "live" });
    expect(restored.binding.policyRevision).toBe("codex-native-project-v2-web-search-live");
    expect(restored.nativeWebSearchMode).toBe("live");
    await expect(restoreCodexProjectRuntimePolicy({ projectId: "integrator-search", projectRoot: root,
      operationId: policy.binding.attemptId, store, nativeDataHome: home }))
      .rejects.toThrow("no matching accepted scoped H34 record");
  });

  it("rejects accepted H34 records with foreign root, revision, host, harness, home or legacy unscoped scope", async () => {
    for (const mismatch of ["root", "revision", "host", "harness", "home", "legacy"] as const) {
      const root = await temporaryRoot();
      const home = await temporaryRoot();
      const otherHome = await temporaryRoot();
      const store = new IntegratorSessionBindingStore({ persistencePath: join(root, `journal-${mismatch}.json`) });
      const policy = await createCodexProjectRuntimePolicy({ projectId: "mismatch-project", projectRoot: root, materialized: true });
      const rootStat = await stat(root);
      const homeStat = await stat(home);
      const hostId = mismatch === "host" ? "foreign-host" : hostname();
      const harness = mismatch === "harness" ? "opencode" as const : "codex" as const;
      const scope = {
        projectId: policy.binding.projectId,
        rootIdentity: mismatch === "root" ? JSON.stringify([root, rootStat.dev, rootStat.ino + 1]) : policy.binding.rootIdentity,
        policyRevision: mismatch === "revision" ? "codex-native-project-v1" : policy.binding.policyRevision,
        hostId,
        harness,
        harnessVersion: "codex-test-version",
        canonicalRoot: { path: root, device: rootStat.dev, inode: mismatch === "root" ? rootStat.ino + 1 : rootStat.ino },
        nativeDataHome: mismatch === "home"
          ? { path: otherHome, device: (await stat(otherHome)).dev, inode: (await stat(otherHome)).ino }
          : { path: home, device: homeStat.dev, inode: homeStat.ino },
      };
      const reservation = await store.reserve({ operationId: policy.binding.attemptId, hostId, harness,
        ...(mismatch === "legacy" ? {} : { scope }) });
      await store.record({ operationId: policy.binding.attemptId, attempt: reservation.attempt.attempt,
        receipt: { state: "created", inputId: reservation.attempt.inputId,
          address: { hostId, harness, nativeSessionId: `native-${mismatch}` }, launchCwd: root, retryable: false } });
      await expect(restoreCodexProjectRuntimePolicy({ projectId: "mismatch-project", projectRoot: root,
        operationId: policy.binding.attemptId, store, nativeDataHome: home })).rejects.toThrow("no matching accepted scoped H34 record");
    }
  });

  it("rejects relative, symlinked and substituted roots", async () => {
    const parent = await temporaryRoot();
    const root = join(parent, "project");
    const target = join(parent, "target");
    await mkdir(root);
    await mkdir(target);
    const alias = join(parent, "alias");
    await symlink(target, alias);

    await expect(createCodexProjectRuntimePolicy({ projectId: "p", projectRoot: "relative" })).rejects.toThrow("normalized absolute root");
    await expect(createCodexProjectRuntimePolicy({ projectId: "p", projectRoot: alias })).rejects.toThrow("must not be a symlink");
    const policy = await createCodexProjectRuntimePolicy({ projectId: "p", projectRoot: root });
    await expect(assertCodexProjectRoot(policy, target)).rejects.toThrow("root binding mismatch");
  });

  it("uses a process-owned, default-isolated Codex config without touching global integrations", () => {
    const args = codexProjectAppServerArgs();
    const joined = args.join(" ");
    const codexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
    expect(args[0]).toBe("app-server");
    expect(joined).toContain(`default_permissions="${CODEX_PROJECT_PERMISSION_PROFILE}"`);
    expect(joined).toContain(`permissions.${CODEX_PROJECT_PERMISSION_PROFILE}.extends=\":workspace\"`);
    expect(joined).toContain(`permissions.${CODEX_PROJECT_PERMISSION_PROFILE}.filesystem={\":root\"=\"deny\"`);
    expect(joined).not.toContain(`${JSON.stringify(codexHome)}=\"deny\"`);
    expect(joined).toContain(`\":root\"=\"deny\"`);
    expect(joined).toContain(`${JSON.stringify(join(codexHome, "tmp/arg0"))}=\"read\"`);
    expect(joined).toMatch(/\"[^\"]*\/\.codex\/packages\/standalone\/releases\/[^\"]*\/bin\/codex\"=\"read\"/);
    expect(joined).toContain(`\"${homedir()}/.ssh\"=\"deny\"`);
    expect(joined).not.toContain(`permissions.${CODEX_PROJECT_PERMISSION_PROFILE}.filesystem.\"`);
    expect(joined).toContain("permissions.agent_herder_project_v1.network.enabled=false");
    expect(joined).toContain("shell_environment_policy.inherit=\"none\"");
    expect(joined).toContain("shell_environment_policy.experimental_use_profile=false");
    expect(joined).toContain("apps._default.enabled=false");
    expect(args).toContain("--disable");
    expect(args).toContain("apps");
    expect(args).toContain("plugins");
    expect(args).toContain("enable_mcp_apps");
    expect(joined).not.toContain("mcp_servers={}");
    expect(joined).not.toContain("apps={}");
    expect(joined).not.toContain("plugins={}");
    expect(joined).not.toContain("danger-full-access");
    expect(joined).not.toContain("web_search=");
  });

  it("adds live hosted search only when the trusted project policy explicitly opts in", () => {
    const args = codexProjectAppServerArgs({ mcpServerIds: [], appIds: [], pluginIds: [] }, "codex", "live");
    const joined = args.join(" ");
    expect(joined).toContain('--config web_search="live"');
    expect(joined).toContain("permissions.agent_herder_project_v1.network.enabled=false");
    expect(joined).toContain("--disable apps");
    expect(joined).toContain("--disable enable_mcp_apps");
    expect(joined).toContain("--disable plugins");
    expect(joined).not.toContain("network.enabled=true");
  });

  it("requires readback of live mode with this process's config origin and skips unrequested mode", () => {
    const correct = { config: { web_search: "live" }, origins: { web_search: { name: { type: "sessionFlags" } } } };
    expect(codexProjectNativeWebSearch(correct, "live")).toEqual({ complete: true, mode: "live", origin: "sessionFlags" });
    expect(codexProjectNativeWebSearch({ config: { web_search: "live" }, origins: { web_search: { name: { type: "user" } } } }, "live").complete).toBe(false);
    expect(codexProjectNativeWebSearch({ config: { web_search: "cached" } }, "live").complete).toBe(false);
    expect(codexProjectNativeWebSearch({}, undefined)).toEqual({ complete: true, mode: "not_requested", origin: "not_requested" });
  });

  it("emits explicit per-id app, MCP and plugin denies without exposing the ids elsewhere", () => {
    const args = codexProjectAppServerArgs({
      mcpServerIds: ["mcp-alpha", "mcp-beta", "mcp-alpha"],
      appIds: ["connector/one"],
      pluginIds: ["plugin-a@marketplace-a"],
    });
    const joined = args.join(" ");
    expect(joined).toContain("mcp_servers.mcp-alpha.enabled=false");
    expect(joined).toContain("mcp_servers.mcp-beta.enabled=false");
    expect(joined).toContain("apps.connector/one.enabled=false");
    expect(joined).toContain("plugins.plugin-a@marketplace-a.enabled=false");
    expect(joined.match(/mcp_servers\.mcp-alpha\.enabled=false/g)).toHaveLength(1);
    expect(joined).toContain("apps._default.enabled=false");
  });

  it("uses the native dotted-key form for safe MCP ids", () => {
    const args = codexProjectAppServerArgs({ mcpServerIds: ["AskHuman"], appIds: [], pluginIds: [] });
    const joined = args.join(" ");
    expect(joined).toContain("mcp_servers.AskHuman.enabled=false");
    expect(joined).not.toContain('mcp_servers."AskHuman"');
  });

  it("rejects malformed IDs before constructing a process argument list", () => {
    expect(() => codexProjectAppServerArgs({ mcpServerIds: ["bad\nid"], appIds: [], pluginIds: [] }))
      .toThrow("invalid MCP server isolation id");
    expect(() => codexProjectAppServerArgs({ mcpServerIds: ["Ask.Human"], appIds: [], pluginIds: [] }))
      .toThrow("unsupported MCP server id for native dotted config path");
  });

  it("requires effective feature denies with session-flag provenance and inventories all overrides", () => {
    const readback = {
      config: {
        features: { apps: false, plugins: false, enable_mcp_apps: false },
        apps: { _default: { enabled: false }, alpha: { enabled: true }, beta: { enabled: false } },
        plugins: { "plugin-a@market": { enabled: true }, "plugin-b@market": { enabled: false } },
      },
      origins: Object.fromEntries(["apps", "plugins", "enable_mcp_apps"].map((id) => [
        `features.${id}`, { name: { type: "sessionFlags" } },
      ])),
    };
    expect(codexProjectIntegrationFeatureDeny(readback)).toEqual({
      complete: true,
      appDefaultDisabled: true,
      appConfiguredKeys: 2,
      appExplicitEnabled: 1,
      pluginConfiguredKeys: 2,
      pluginExplicitEnabled: 1,
    });
    const unknownOrigin = structuredClone(readback);
    unknownOrigin.origins["features.plugins"].name.type = "user";
    expect(codexProjectIntegrationFeatureDeny(unknownOrigin).complete).toBe(false);
    const unknownOverride = structuredClone(readback);
    unknownOverride.config.plugins["plugin-a@market"].enabled = undefined;
    expect(codexProjectIntegrationFeatureDeny(unknownOverride).complete).toBe(false);
  });

  it("builds discovery denies from nullable status rows plus configured-only IDs", () => {
    const fixtureRows = [
      { name: "AskHuman", runtimeStatus: null, tools: null },
      { name: "shared/search", runtimeStatus: null, tools: null },
    ];
    const discovery = codexProjectDiscoveryDenyList({
      mcpStatusNames: fixtureRows.map((row) => row.name),
      configuredMcpIds: ["AskHuman", "configured-only"],
      configuredAppIds: ["app/one"],
      configuredPluginIds: ["plugin@marketplace"],
    });
    expect(discovery).toEqual({
      complete: true,
      denyList: {
        mcpServerIds: ["AskHuman", "configured-only", "shared/search"],
        appIds: ["app/one"],
        pluginIds: ["plugin@marketplace"],
      },
    });
    expect(codexProjectDiscoveryDenyList({
      mcpStatusNames: ["unsupported.name"], configuredMcpIds: [], configuredAppIds: [], configuredPluginIds: [],
    }).complete).toBe(false);
    expect(codexProjectDiscoveryDenyList({
      mcpStatusNames: [null], configuredMcpIds: [], configuredAppIds: [], configuredPluginIds: [],
    }).complete).toBe(false);
  });

  it("requires the exact closed filesystem profile in effective config readback", () => {
    const codexBin = (process.env.PATH ?? "").split(delimiter)
      .map((directory) => join(directory, "codex"))
      .find((candidate) => { try { accessSync(candidate, fsConstants.X_OK); return true; } catch { return false; } }) ?? "codex";
    const profile = {
      ":root": "deny", ":minimal": "read", ":workspace_roots": "write", ":tmpdir": "deny", ":slash_tmp": "deny",
      [join(process.env.CODEX_HOME || join(homedir(), ".codex"), "tmp/arg0")]: "read",
      [realpathSync(codexBin)]: "read",
      [join(homedir(), ".ssh")]: "deny", [join(homedir(), ".config")]: "deny",
    };
    expect(codexProjectFilesystemProfileDeny({ config: { permissions: { [CODEX_PROJECT_PERMISSION_PROFILE]: { filesystem: profile } } } }, codexBin))
      .toEqual({ complete: true, configuredPaths: 9, exactRules: 9, unexpectedRules: [], depthMetadataShape: "absent" });
    expect(codexProjectFilesystemProfileDeny({ config: { permissions: { [CODEX_PROJECT_PERMISSION_PROFILE]: { filesystem: { ...profile, glob_scan_max_depth: null } } } } }, codexBin).complete)
      .toBe(true);
    expect(codexProjectFilesystemProfileDeny({ config: { permissions: { [CODEX_PROJECT_PERMISSION_PROFILE]: { filesystem: { ...profile, glob_scan_max_depth: {} } } } } }, codexBin).complete)
      .toBe(true);
    expect(codexProjectFilesystemProfileDeny({ config: { permissions: { [CODEX_PROJECT_PERMISSION_PROFILE]: { filesystem: { ...profile, glob_scan_max_depth: { unknown: true } } } } } }, codexBin).complete)
      .toBe(false);
    expect(codexProjectFilesystemProfileDeny({ config: { permissions: { [CODEX_PROJECT_PERMISSION_PROFILE]: { filesystem: { ...profile, "/tmp/unexpected": "read" } } } } }, codexBin).complete)
      .toBe(false);
  });

  it("adds only the fixed profile and exact root to native thread and turn requests", async () => {
    const root = await temporaryRoot();
    const policy = await createCodexProjectRuntimePolicy({ projectId: "project-a", projectRoot: root });
    expect(codexProjectThreadParams(policy)).toEqual({
      permissions: CODEX_PROJECT_PERMISSION_PROFILE,
      runtimeWorkspaceRoots: [root],
      ephemeral: true,
    });
    expect(codexProjectTurnParams(policy)).toEqual({
      permissions: CODEX_PROJECT_PERMISSION_PROFILE,
      runtimeWorkspaceRoots: [root],
    });
    expect(codexProjectResumeParams(policy)).toEqual({
      permissions: CODEX_PROJECT_PERMISSION_PROFILE,
      runtimeWorkspaceRoots: [root],
    });
    expect(codexProjectPermissionObserved({
      activePermissionProfile: { id: CODEX_PROJECT_PERMISSION_PROFILE },
      runtimeWorkspaceRoots: [root],
    }, policy)).toBe(true);
    expect(codexProjectPermissionObserved({
      activePermissionProfile: { id: ":workspace" },
      runtimeWorkspaceRoots: [root],
    }, policy)).toBe(false);
    expect(codexProjectPermissionObserved({
      activePermissionProfile: { id: CODEX_PROJECT_PERMISSION_PROFILE },
      runtimeWorkspaceRoots: [join(root, "..")],
    }, policy)).toBe(false);
  });
});
