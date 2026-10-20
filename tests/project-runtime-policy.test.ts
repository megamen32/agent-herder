import { afterEach, describe, expect, it } from "vitest";
import { accessSync, constants as fsConstants, realpathSync } from "node:fs";
import { mkdtemp, mkdir, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import {
  CODEX_PROJECT_PERMISSION_PROFILE,
  CODEX_PROJECT_MODEL_ID,
  assertCodexProjectRoot,
  codexProjectAppServerArgs,
  codexProjectIntegrationFeatureDeny,
  codexProjectDiscoveryDenyList,
  codexProjectFilesystemProfileDeny,
  codexProjectPermissionObserved,
  codexProjectResumeParams,
  codexProjectThreadParams,
  codexProjectTurnParams,
  createCodexProjectRuntimePolicy,
} from "../src/project-runtime-policy.js";

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
      policyRevision: "codex-native-project-v1",
      hostId: expect.any(String),
      runtimeInstanceId: expect.any(String),
      attemptId: expect.any(String),
    });
    expect(policy.permissionProfileId).toBe(CODEX_PROJECT_PERMISSION_PROFILE);
    expect(policy.modelId).toBe(CODEX_PROJECT_MODEL_ID);
    await expect(assertCodexProjectRoot(policy, root)).resolves.toBeUndefined();
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
