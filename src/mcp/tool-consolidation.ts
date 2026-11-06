import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { FLEET_DIRECT_TOOLS } from "../mesh/fleet-tool-allowlist.js";
import { capabilityRegistry, internalReaders } from "./catalog-policy.js";

/**
 * Public action facades over existing, independently validated SDK handlers.
 * Old tool names stay registered and callable; discovery alone is reduced.
 *
 * Registration happens before connect(). The original handlers (including
 * permissions, ownership, idempotency and Human Request gates) are invoked,
 * rather than reimplementing or bypassing any of those checks.
 */
type Selector = "action" | "scope" | "detail" | "variant" | "async" | "saveToFile";
type Choice = {
  value: string | boolean;
  tool: string;
  async?: boolean;
  keepSelector?: boolean;
};
type Family = {
  name: string;
  selector: Selector;
  choices: readonly Choice[];
};

const families: readonly Family[] = [
  { name: "create_session", selector: "variant", choices: [
    { value: "native", tool: "create_session" },
    { value: "fleet", tool: "fleet_create_session" },
  ] },
  { name: "session_info", selector: "detail", choices: [
    { value: "agent", tool: "agent_info" },
    { value: "identity", tool: "session_identity" },
  ] },
  { name: "list_sessions", selector: "scope", choices: [
    { value: "history", tool: "list_agents" },
    { value: "active", tool: "list_active_sessions" },
    { value: "snapshot", tool: "fleet_session_page" },
    { value: "mesh", tool: "mesh_snapshot" },
    { value: "peers", tool: "mesh_discover" },
    { value: "node", tool: "fleet_node_info" },
  ] },
  { name: "search", selector: "scope", choices: [
    { value: "indexed", tool: "agent_herder_search" },
    { value: "fleet", tool: "session_search" },
  ] },
  { name: "model", selector: "action", choices: [
    { value: "list", tool: "list_models" },
    { value: "set", tool: "change_model" },
  ] },
  { name: "service_tier", selector: "action", choices: [
    { value: "get", tool: "get_service_tier" },
    { value: "set", tool: "set_service_tier" },
  ] },
  { name: "session_queue", selector: "action", choices: [
    { value: "get", tool: "session_queue_processing_get" },
    { value: "resume", tool: "session_queue_processing_resume" },
  ] },
  { name: "job", selector: "action", choices: [
    { value: "list", tool: "job_list" },
    { value: "get", tool: "job_get" },
    { value: "cancel", tool: "job_cancel" },
  ] },
  { name: "coordination_note", selector: "action", choices: [
    { value: "create", tool: "coordination_note_create" },
    { value: "list", tool: "coordination_note_list" },
    { value: "get", tool: "coordination_note_get" },
    { value: "update", tool: "coordination_note_update" },
    { value: "delete", tool: "coordination_note_delete" },
  ] },
  { name: "resume_after", selector: "action", choices: [
    { value: "wait", tool: "resume_after" },
    { value: "status", tool: "resume_after_status" },
    { value: "cancel", tool: "resume_after_cancel" },
  ] },
  { name: "cadence", selector: "action", choices: [
    { value: "schedule", tool: "cadence_schedule" },
    { value: "status", tool: "cadence_status" },
    { value: "pause", tool: "cadence_control", keepSelector: true },
    { value: "complete", tool: "cadence_control", keepSelector: true },
  ] },
  { name: "human_request", selector: "action", choices: [
    { value: "create", tool: "human_request_create" },
    { value: "resolve", tool: "human_request_resolve" },
    { value: "resolve_elicitation", tool: "human_request_resolve_interactive" },
    { value: "get", tool: "human_request_get" },
    { value: "bind_incident", tool: "human_request_bind_notify_incident" },
  ] },
  { name: "workspace", selector: "action", choices: [
    { value: "probe", tool: "workspace_probe" },
    { value: "locate", tool: "workspace_locate" },
    { value: "reserve", tool: "workspace_reserve" },
    { value: "owners", tool: "workspace_owners" },
    { value: "declare", tool: "workspace_declare" },
    { value: "declare", tool: "session_workspaces_declare" },
    { value: "status", tool: "workspace_status" },
    { value: "activity", tool: "workspace_activity" },
    { value: "release", tool: "workspace_release" },
    { value: "get", tool: "session_workspaces_get" },
  ] },
  { name: "common_settings", selector: "action", choices: [
    { value: "read", tool: "common_settings_read" },
    { value: "status", tool: "common_settings_status" },
    { value: "notice", tool: "common_settings_notice" },
    { value: "opt_in", tool: "common_settings_opt_in" },
    { value: "restore", tool: "common_settings_restore" },
  ] },
  { name: "read_message", selector: "saveToFile", choices: [
    { value: false, tool: "read_message" },
    { value: true, tool: "save_message_to_file" },
  ] },
  { name: "export_transcript", selector: "async", choices: [
    { value: false, tool: "export_transcript" },
    { value: true, tool: "export_transcript_async" },
  ] },
  { name: "browser_wake", selector: "async", choices: [
    { value: false, tool: "browser_wake" },
    { value: true, tool: "browser_wake_async" },
  ] },
  { name: "cdp_chat", selector: "action", choices: [
    { value: "new", tool: "cdp_new_chat" },
    { value: "list", tool: "cdp_list_chats" },
    { value: "search", tool: "cdp_search_chat" },
    { value: "send", tool: "cdp_send_message" },
    { value: "edit", tool: "cdp_edit_message" },
    { value: "download", tool: "cdp_download_media" },
  ] },
  { name: "cdp_archive", selector: "action", choices: [
    { value: "chat", tool: "cdp_export_chat", async: false },
    { value: "chat", tool: "cdp_export_chat_async", async: true },
    { value: "visible", tool: "cdp_export_visible_chats", async: false },
    { value: "visible", tool: "cdp_export_visible_chats_async", async: true },
    { value: "reconcile_known", tool: "cdp_reconcile_known_routes", async: false },
    { value: "reconcile_known", tool: "cdp_reconcile_known_routes_async", async: true },
    { value: "reconcile_visible", tool: "cdp_reconcile_visible_chats", async: false },
    { value: "reconcile_visible", tool: "cdp_reconcile_visible_chats_async", async: true },
  ] },
  { name: "cdp_account", selector: "action", choices: [
    { value: "request", tool: "cdp_request_account_export", async: false },
    { value: "request", tool: "cdp_request_account_export_async", async: true },
    { value: "import", tool: "cdp_import_account_export", async: false },
    { value: "import", tool: "cdp_import_account_export_async", async: true },
    { value: "list", tool: "cdp_list_account_exports" },
  ] },
  { name: "chatgpt_wake", selector: "action", choices: [
    { value: "register", tool: "chatgpt_wake_binding_register" },
    { value: "verify", tool: "chatgpt_wake_binding_verify" },
    { value: "await", tool: "chatgpt_wake_await" },
  ] },
  { name: "session_lineage", selector: "action", choices: [
    { value: "parent", tool: "find_parent" },
    { value: "children", tool: "list_children" },
  ] },
];

type Captured = {
  schema: z.ZodType;
  description: string;
  callback: (args: unknown, context: unknown) => unknown;
  handle: ReturnType<McpServer["registerTool"]>;
};
type Entry = { choice: Choice; captured: Captured };

function asRecord(input: unknown): Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Consolidated tool arguments must be an object");
  }
  return input as Record<string, unknown>;
}

function joinedSchema(branches: z.ZodType[], guidance?: (input: unknown) => string): z.ZodType {
  if (branches.length === 0) throw new Error("Empty consolidated tool");
  if (branches.length === 1) return branches[0]!;
  return z.union([branches[0]!, branches[1]!, ...branches.slice(2)], guidance ? { error: issue => guidance(issue.input) } : undefined);
}

function validationGuidance(name: string, selector: Selector, entries: Entry[], input: unknown): string {
  const args = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
  const selected = entries.filter(entry => entry.choice.value === args[selector]);
  const allowed = [...new Set(entries.map(entry => String(entry.choice.value)))].join(", ");
  if (!selected.length) return `Invalid ${name}.${selector}. Choose one of: ${allowed}.`;
  const issues = selected.map(entry => {
    const params = { ...args }; delete params[selector];
    if (entry.choice.keepSelector) params[selector] = args[selector];
    const result = entry.captured.schema.safeParse(params);
    return result.success ? [] : result.error.issues;
  }).sort((a, b) => a.length - b.length)[0] ?? [];
  const details = issues.map(issue => `${issue.path.length ? issue.path.join(".") + ": " : ""}${issue.message}`).join("; ");
  const hint = name === "workspace" && args.action === "declare" && "paths" in args
    ? ' Remove paths from declare; reserve paths separately with workspace action="reserve" (owner, cwd, paths).'
    : " Check the selected operation's argument schema and retry.";
  return `Invalid ${name} ${selector}=${String(args[selector])}: ${details || "arguments do not match the selected operation."}${hint}`;
}

function withSelector(schema: z.ZodType, fields: Record<string, z.ZodType>): z.ZodType {
  if (schema instanceof z.ZodObject) return schema.safeExtend(fields);
  // resume_after has two independent, super-refined input variants. Keep
  // BOTH validators rather than projecting a weaker combined shape.
  if (schema instanceof z.ZodUnion) {
    return joinedSchema(schema.options.map(option => withSelector(option as z.ZodType, fields)));
  }
  throw new Error("Unsupported tool schema for consolidation");
}

function registerTargetFacade(
  server: McpServer,
  captured: Map<string, Captured>,
  hidden: Set<string>,
  name: "stop" | "rename",
  originalName: "stop_agent" | "rename_session",
): void {
  const original = captured.get(originalName);
  if (!original || !(original.schema instanceof z.ZodObject)) return;
  const shape = original.schema.shape;
  const target = z.object({
    sessionId: shape.sessionId,
    harness: shape.harness,
    hostId: shape.hostId,
  }).strict();
  const inputSchema = name === "rename"
    ? z.object({
      target,
      title: shape.title,
      goal: shape.goal,
      project: shape.project,
      stage: shape.stage,
    }).strict()
    : z.object({ target }).strict();
  const callback = async (input: unknown, context: unknown) => {
    const args = asRecord(input);
    const targetArgs = asRecord(args.target);
    const { target: _target, ...rest } = args;
    // Original schema still validates all target fields and option limits.
    return original.callback(original.schema.parse({ ...targetArgs, ...rest }), context);
  };
  Reflect.apply(server.registerTool, server, [
    name,
    {
      description: name === "stop"
        ? "Stop one exact session by target {sessionId,harness?,hostId?}; uses existing native and remote ownership checks."
        : "Rename one exact session by target {sessionId,harness?,hostId?}, title?, goal?, stage?, project?; preserves native ownership and metadata rules.",
      inputSchema,
    },
    callback,
  ]);
  hidden.add(originalName);
}

export function withToolConsolidation(
  server: McpServer,
  register: () => void,
  hidden: Set<string>,
): void {
  const captured = new Map<string, Captured>();
  // Where a hidden original public command now lives, for the refusal text.
  const legacyCommand = new Map<string, string>();
  const original = server.registerTool;
  server.registerTool = new Proxy(original, {
    apply(target, receiver, args) {
      const handle = Reflect.apply(target, receiver, args) as ReturnType<McpServer["registerTool"]>;
      const [name, config, callback] = args;
      if (typeof name === "string" && config && typeof config === "object" && typeof callback === "function") {
        const raw = config as { inputSchema?: unknown; description?: string };
        const schema = raw.inputSchema ?? z.object({}).strict();
        if (schema instanceof z.ZodType) {
          captured.set(name, {
            schema,
            description: raw.description ?? "",
            callback: callback as (args: unknown, context: unknown) => unknown,
            handle,
          });
        }
      }
      return handle;
    },
  }) as typeof server.registerTool;
  try {
    register();
  } finally {
    // The SDK and other products must never see a lasting registration patch.
    server.registerTool = original;
  }

  registerTargetFacade(server, captured, hidden, "stop", "stop_agent");
  registerTargetFacade(server, captured, hidden, "rename", "rename_session");

  for (const family of families) {
    const entries: Entry[] = family.choices
      .map(choice => ({ choice, captured: captured.get(choice.tool) }))
      .filter((entry): entry is Entry => entry.captured !== undefined);
    if (entries.length === 0) continue;
    const canonical = captured.get(family.name);

    const branches: z.ZodType[] = entries.map(({ choice, captured: entry }) => {
      const fields: Record<string, z.ZodType> = { [family.selector]: family.name === "session_info" && choice.value === "agent" ? z.literal("agent").optional() : z.literal(choice.value) };
      if (choice.async !== undefined) {
        fields.async = choice.async ? z.literal(true) : z.literal(false).optional();
      } else if (family.choices.some(other => other.async !== undefined) && family.selector !== "async") {
        // A non-async action (e.g. account list) must reject async=true.
        fields.async = z.never().optional();
      }
      return withSelector(entry.schema, fields);
    });
    if (canonical) {
      // Legacy callers of an existing public name can omit the selector.
      // An invalid explicit selector must NOT fall through to a mutating
      // legacy handler because a permissive Zod object strips unknown keys.
      const forbidden: Record<string, z.ZodType> = { [family.selector]: z.never().optional() };
      if (family.choices.some(choice => choice.async !== undefined) && family.selector !== "async") {
        forbidden.async = z.never().optional();
      }
      branches.push(withSelector(canonical.schema, forbidden));
    }
    const inputSchema = joinedSchema(branches, input => validationGuidance(family.name, family.selector, entries, input));
    const callback = async (input: unknown, context: unknown) => {
      const args = asRecord(input);
      const selectorValue = args[family.selector] ?? (family.name === "session_info" ? "agent" : undefined);
      const asyncValue = args.async === true;
      const candidates = entries.filter(({ choice }) => choice.value === selectorValue
        && (choice.async === undefined || choice.async === asyncValue));
      // Two declared-workspace shapes share action=declare. Select ONLY a
      // variant whose original strict schema validates the full arguments.
      for (const entry of candidates) {
        const params = { ...args };
        delete params[family.selector];
        if (family.choices.some(choice => choice.async !== undefined) && family.selector !== "async") {
          delete params.async;
        }
        if (entry.choice.keepSelector) params[family.selector] = selectorValue;
        const validated = entry.captured.schema.safeParse(params);
        if (validated.success) return entry.captured.callback(validated.data, context);
      }
      if (selectorValue === undefined && canonical) {
        return canonical.callback(canonical.schema.parse(args), context);
      }
      throw new Error("Unsupported or invalid " + family.name + " " + family.selector);
    };
    const prefix = family.name === "session_info" ? "Read a session: default includes latest user and assistant messages; view=compact omits history. For a full transcript use export_transcript. "
      : family.name === "workspace" ? "Declare a workspace first; reserve file paths separately using action=reserve with owner, cwd and paths. Do not pass paths to action=declare. " : "";
    const description = prefix + "Use " + family.selector + " to select the operation; native ownership, permission "
      + "and confirmation checks remain enforced. "
      + entries.map(({ choice, captured: entry }) =>
        String(choice.value) + (choice.async === undefined ? "" : " async=" + choice.async)
        + ": " + entry.description.replace(/\s+/g, " ").slice(0, 180)).join("; ");
    if (canonical) {
      canonical.handle.update({ paramsSchema: inputSchema, callback: callback as never, description });
    } else {
      Reflect.apply(server.registerTool, server, [
        family.name,
        { description, inputSchema },
        callback,
      ]);
    }
    for (const entry of entries) {
      if (entry.choice.tool !== family.name) {
        hidden.add(entry.choice.tool);
        legacyCommand.set(entry.choice.tool, `${family.name} ${family.selector}=${JSON.stringify(entry.choice.value)}`);
      }
    }
  }

  // deliver already supersets the ordinary send/new-or-resume workflows.
  // The mesh_* delivery endpoints stay advertised: mesh_deliver is a fleet
  // capability proof (native peer readiness, GPTAdmin route resolution) and
  // mesh_route is the exact remote-route entry the fleet resolves against.
  // The catalog-policy capabilityRegistry pins mesh_deliver either way.
  if (captured.has("deliver")) {
    for (const oldName of ["send_message", "new_or_resume"]) {
      if (captured.has(oldName)) { hidden.add(oldName); legacyCommand.set(oldName, "deliver"); }
    }

  // The fleet direct transport and the pinned peer proofs still call several
  // originals by their exact wire names; every other hidden original is only
  // an implementation detail of its facade now and no longer answers its
  // legacy name. The consolidated command is the one public path.
  const fleetCallable = new Set<string>([...FLEET_DIRECT_TOOLS, ...capabilityRegistry, ...internalReaders]);
  for (const name of hidden) {
    if (fleetCallable.has(name)) continue;
    const entry = captured.get(name);
    if (!entry) continue;
    const command = legacyCommand.get(name);
    const refusing = async (): Promise<never> => {
      throw new Error(command
        ? `legacy_tool_removed: call the consolidated command ${command} instead of ${name}`
        : `legacy_tool_removed: ${name} is no longer callable; use its consolidated command`);
    };
    entry.handle.update({ callback: refusing as never });
  }
  }
}
