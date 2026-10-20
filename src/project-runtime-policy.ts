import { randomUUID } from "node:crypto";
import { accessSync, constants as fsConstants, realpathSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { basename, delimiter, isAbsolute, join, resolve } from "node:path";
import type { ProjectExecutionBinding } from "./project-execution-scope.js";

/** Fixed native Codex profile. Callers cannot choose a weaker profile. */
export const CODEX_PROJECT_PERMISSION_PROFILE = "agent_herder_project_v1" as const;
export const CODEX_PROJECT_POLICY_REVISION = "codex-native-project-v1" as const;
export const CODEX_PROJECT_MODEL_ID = "gpt-6-luna" as const;

export interface CodexProjectRuntimePolicy {
  readonly binding: Readonly<ProjectExecutionBinding>;
  readonly rootPath: string;
  readonly rootDevice: number;
  readonly rootInode: number;
  readonly permissionProfileId: typeof CODEX_PROJECT_PERMISSION_PROFILE;
  readonly modelId: typeof CODEX_PROJECT_MODEL_ID;
}

export interface CodexProjectToolDenyList {
  readonly mcpServerIds: readonly string[];
  readonly appIds: readonly string[];
  readonly pluginIds: readonly string[];
}

/** Build the process-local explicit deny set from complete status names and effective config keys. */
export function codexProjectDiscoveryDenyList(input: {
  mcpStatusNames: readonly unknown[];
  configuredMcpIds: readonly string[];
  configuredAppIds: readonly string[];
  configuredPluginIds: readonly string[];
}): { complete: boolean; denyList: CodexProjectToolDenyList } {
  const validIds = (ids: readonly unknown[]): ids is readonly string[] => ids.every((id) =>
    typeof id === "string" && id.trim() === id && /^[A-Za-z0-9_@/-]+$/.test(id));
  const statusNamesValid = validIds(input.mcpStatusNames);
  const configuredIdsValid = validIds([...input.configuredMcpIds, ...input.configuredAppIds, ...input.configuredPluginIds]);
  const mcpServerIds = statusNamesValid
    ? [...new Set([...input.mcpStatusNames as string[], ...input.configuredMcpIds])].sort() : [];
  const appIds = [...new Set(input.configuredAppIds)].sort();
  const pluginIds = [...new Set(input.configuredPluginIds)].sort();
  return {
    complete: statusNamesValid && configuredIdsValid,
    denyList: { mcpServerIds, appIds, pluginIds },
  };
}

export async function createCodexProjectRuntimePolicy(input: {
  projectId: string;
  projectRoot: string;
}): Promise<CodexProjectRuntimePolicy> {
  if (!input.projectId.trim() || !isAbsolute(input.projectRoot) || resolve(input.projectRoot) !== input.projectRoot) {
    throw new Error("project runtime requires a project id and normalized absolute root");
  }
  const canonicalRoot = await realpath(input.projectRoot);
  if (canonicalRoot !== input.projectRoot) throw new Error("project runtime root must not be a symlink");
  const rootStat = await stat(canonicalRoot);
  if (!rootStat.isDirectory()) throw new Error("project runtime root must be a directory");
  const binding = Object.freeze({
    projectId: input.projectId,
    rootIdentity: `${canonicalRoot}\0${rootStat.dev}:${rootStat.ino}`,
    policyRevision: CODEX_PROJECT_POLICY_REVISION,
    attemptId: randomUUID(),
    hostId: hostname(),
    runtimeInstanceId: randomUUID(),
  });
  return Object.freeze({
    binding,
    rootPath: canonicalRoot,
    rootDevice: rootStat.dev,
    rootInode: rootStat.ino,
    permissionProfileId: CODEX_PROJECT_PERMISSION_PROFILE,
    modelId: CODEX_PROJECT_MODEL_ID,
  });
}

/** Re-check the exact root before every native create/resume/turn operation. */
export async function assertCodexProjectRoot(policy: CodexProjectRuntimePolicy, requestedRoot: string): Promise<void> {
  if (requestedRoot !== policy.rootPath) throw new Error("project runtime root binding mismatch");
  const canonicalRoot = await realpath(requestedRoot);
  const rootStat = await stat(canonicalRoot);
  if (canonicalRoot !== policy.rootPath || !rootStat.isDirectory()
    || rootStat.dev !== policy.rootDevice || rootStat.ino !== policy.rootInode) {
    throw new Error("project runtime root identity changed");
  }
}

/**
 * CLI-only overrides for this owned app-server process. They do not edit the
 * shared Codex config or auth. The active named profile is selected per thread.
 */
export function codexProjectAppServerArgs(
  denyList: CodexProjectToolDenyList = { mcpServerIds: [], appIds: [], pluginIds: [] },
  codexBin = "codex",
): string[] {
  const profile = CODEX_PROJECT_PERMISSION_PROFILE;
  const userHome = homedir();
  const codexHome = resolve(process.env.CODEX_HOME || join(userHome, ".codex"));
  const codexExecutablePath = resolveCodexExecutable(codexBin);
  const validateIds = (ids: readonly string[], label: string): string[] => {
    if (ids.some((id) => !id.trim() || /[\x00-\x1f\x7f]/.test(id))) throw new Error(`invalid ${label} isolation id`);
    const unique = [...new Set(ids)].sort();
    if (unique.some((id) => !/^[A-Za-z0-9_@/-]+$/.test(id))) {
      throw new Error(`unsupported ${label} id for native dotted config path`);
    }
    return unique;
  };
  const config = [
    `default_permissions=${JSON.stringify(profile)}`,
    `permissions.${profile}.extends=":workspace"`,
    `permissions.${profile}.filesystem={${[
      [":root", "deny"],
      [":minimal", "read"],
      [":workspace_roots", "write"],
      // `:workspace` also grants its temporary roots. Close them explicitly;
      // the runtime workspace rule above is the only intended writable root.
      [":tmpdir", "deny"],
      [":slash_tmp", "deny"],
      // A parent CODEX_HOME deny is redundant with :root=deny and is emitted
      // after child read binds by Codex's Linux sandbox, masking these two
      // exact bootstrap exceptions. Keep no parent deny rule here.
      [`${codexHome}/tmp/arg0`, "read"],
      [codexExecutablePath, "read"],
      [`${userHome}/.ssh`, "deny"],
      [`${userHome}/.config`, "deny"],
    ].map(([path, permission]) => `${JSON.stringify(path)}=${JSON.stringify(permission)}`).join(",")}}`,
    `permissions.${profile}.network.enabled=false`,
    `permissions.${profile}.network.dangerously_allow_all_unix_sockets=false`,
    "apps._default.enabled=false",
    `shell_environment_policy.inherit=\"none\"`,
    `shell_environment_policy.ignore_default_excludes=false`,
    `shell_environment_policy.experimental_use_profile=false`,
    `shell_environment_policy.set.PATH=\"/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin\"`,
    ...validateIds(denyList.mcpServerIds, "MCP server").map((id) => `mcp_servers.${id}.enabled=false`),
    ...validateIds(denyList.appIds, "app").map((id) => `apps.${id}.enabled=false`),
    ...validateIds(denyList.pluginIds, "plugin").map((id) => `plugins.${id}.enabled=false`),
  ];
  return [
    "app-server",
    "--disable", "apps",
    "--disable", "enable_mcp_apps",
    "--disable", "plugins",
    ...config.flatMap((value) => ["--config", value]),
  ];
}

function resolveCodexExecutable(codexBin: string): string {
  const candidates = isAbsolute(codexBin) || codexBin.includes("/")
    ? [codexBin]
    : (process.env.PATH ?? "").split(delimiter).filter(Boolean).map((directory) => join(directory, codexBin));
  for (const candidate of candidates) {
    try {
      accessSync(candidate, fsConstants.X_OK);
      return realpathSync(candidate);
    } catch {
      // Continue over PATH candidates only; absence is rejected below.
    }
  }
  throw new Error("cannot resolve the Codex executable for the process-local sandbox profile");
}

/**
 * Readback proof for process-local feature disables. Config origins must show
 * the session flags as the effective source; missing or layered ambiguity is
 * a deny. Only booleans and aggregate counts leave the caller.
 */
export function codexProjectIntegrationFeatureDeny(readback: unknown): {
  complete: boolean;
  appDefaultDisabled: boolean;
  appConfiguredKeys: number;
  appExplicitEnabled: number;
  pluginConfiguredKeys: number;
  pluginExplicitEnabled: number;
} {
  if (!readback || typeof readback !== "object") {
    return { complete: false, appDefaultDisabled: false, appConfiguredKeys: 0, appExplicitEnabled: 0, pluginConfiguredKeys: 0, pluginExplicitEnabled: 0 };
  }
  const response = readback as {
    config?: { features?: Record<string, unknown>; apps?: Record<string, unknown>; plugins?: Record<string, unknown> };
    origins?: Record<string, { name?: { type?: unknown } } | undefined>;
  };
  const features = response.config?.features;
  const apps = response.config?.apps;
  const plugins = response.config?.plugins;
  const origins = response.origins;
  const requiredFeatures = ["apps", "enable_mcp_apps", "plugins"] as const;
  const featureFlagsDenied = !!features && !!origins && requiredFeatures.every((feature) =>
    features[feature] === false && origins[`features.${feature}`]?.name?.type === "sessionFlags");
  const appDefaultDisabled = !!apps && typeof apps === "object"
    && !!apps._default && typeof apps._default === "object"
    && (apps._default as { enabled?: unknown }).enabled === false;
  const appOverrides = apps && typeof apps === "object"
    ? Object.entries(apps).filter(([id]) => id !== "_default") : [];
  const pluginOverrides = plugins && typeof plugins === "object" ? Object.entries(plugins) : [];
  const appOverridesKnown = appOverrides.every(([, value]) => !!value && typeof value === "object"
    && typeof (value as { enabled?: unknown }).enabled === "boolean");
  const pluginOverridesKnown = pluginOverrides.every(([, value]) => !!value && typeof value === "object"
    && typeof (value as { enabled?: unknown }).enabled === "boolean");
  const appExplicitEnabled = appOverrides.filter(([, value]) => (value as { enabled?: unknown })?.enabled === true).length;
  const pluginExplicitEnabled = pluginOverrides.filter(([, value]) => (value as { enabled?: unknown })?.enabled === true).length;
  return {
    complete: featureFlagsDenied && appDefaultDisabled && !!plugins && typeof plugins === "object" && appOverridesKnown && pluginOverridesKnown,
    appDefaultDisabled,
    appConfiguredKeys: appOverrides.length,
    appExplicitEnabled,
    pluginConfiguredKeys: pluginOverrides.length,
    pluginExplicitEnabled,
  };
}

/** Require the process-local profile to be the complete, closed filesystem policy we supplied. */
export function codexProjectFilesystemProfileDeny(readback: unknown, codexBin = "codex"): {
  complete: boolean;
  configuredPaths: number;
  exactRules: number;
  unexpectedRules: string[];
  depthMetadataShape: string;
} {
  const config = readback && typeof readback === "object"
    ? (readback as { config?: { permissions?: Record<string, unknown> } }).config : undefined;
  const profile = config?.permissions?.[CODEX_PROJECT_PERMISSION_PROFILE];
  const filesystem = profile && typeof profile === "object"
    ? (profile as { filesystem?: Record<string, unknown> }).filesystem : undefined;
  const userHome = homedir();
  const codexHome = resolve(process.env.CODEX_HOME || join(userHome, ".codex"));
  const codexExecutablePath = resolveCodexExecutable(codexBin);
  const expected: Record<string, string> = {
    ":root": "deny",
    ":minimal": "read",
    ":workspace_roots": "write",
    ":tmpdir": "deny",
    ":slash_tmp": "deny",
    [`${codexHome}/tmp/arg0`]: "read",
    [codexExecutablePath]: "read",
    [`${userHome}/.ssh`]: "deny",
    [`${userHome}/.config`]: "deny",
  };
  const entries = filesystem && typeof filesystem === "object" ? Object.entries(filesystem) : [];
  const permissionEntries = entries.filter(([path]) => path !== "glob_scan_max_depth");
  const exactRules = permissionEntries.filter(([path, value]) => expected[path] === value).length;
  const depthMetadata = entries.find(([path]) => path === "glob_scan_max_depth")?.[1];
  const depthMetadataValid = depthMetadata === undefined || depthMetadata === null
    || (typeof depthMetadata === "number" && Number.isInteger(depthMetadata) && depthMetadata >= 1)
    || (!!depthMetadata && typeof depthMetadata === "object" && Object.keys(depthMetadata).length === 0);
  const depthMetadataShape = depthMetadata === undefined ? "absent"
    : depthMetadata === null ? "null"
    : typeof depthMetadata === "object" && depthMetadata !== null ? `object:${Object.keys(depthMetadata).sort().join(",")}`
      : typeof depthMetadata;
  const complete = permissionEntries.length === Object.keys(expected).length && exactRules === permissionEntries.length
    && depthMetadataValid && entries.every(([path]) => path === "glob_scan_max_depth" || expected[path] !== undefined);
  const unexpectedRules = entries.filter(([path, value]) => path !== "glob_scan_max_depth" && expected[path] !== value).map(([path, value]) => ({ path, value }))
    .map(({ path, value }) => `${path.startsWith(":") ? path : isAbsolute(path) ? `absolute:${basename(path)}` : path}:${typeof value}`);
  return { complete, configuredPaths: permissionEntries.length, exactRules, unexpectedRules, depthMetadataShape };
}

export function codexProjectThreadParams(policy: CodexProjectRuntimePolicy): Record<string, unknown> {
  return {
    permissions: policy.permissionProfileId,
    runtimeWorkspaceRoots: [policy.rootPath],
    ephemeral: true,
  };
}

export function codexProjectResumeParams(policy: CodexProjectRuntimePolicy): Record<string, unknown> {
  return {
    permissions: policy.permissionProfileId,
    runtimeWorkspaceRoots: [policy.rootPath],
  };
}

export function codexProjectTurnParams(policy: CodexProjectRuntimePolicy): Record<string, unknown> {
  return {
    permissions: policy.permissionProfileId,
    runtimeWorkspaceRoots: [policy.rootPath],
  };
}

export function codexProjectPermissionObserved(
  observed: { activePermissionProfile?: { id?: unknown } | null; runtimeWorkspaceRoots?: unknown },
  policy: CodexProjectRuntimePolicy,
): boolean {
  return observed.activePermissionProfile?.id === policy.permissionProfileId
    && Array.isArray(observed.runtimeWorkspaceRoots)
    && observed.runtimeWorkspaceRoots.length === 1
    && observed.runtimeWorkspaceRoots[0] === policy.rootPath;
}
