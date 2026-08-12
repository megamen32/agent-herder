/** The versioned, provider-neutral accessibility capability returned by BrowserClaw. */
export const BROWSERCLAW_A11Y_SCHEMA = "agent-herder.browserclaw-a11y.v1" as const;

const DEFAULT_LIMITS = {
  maxBytes: 256 * 1024,
  maxDepth: 64,
  maxNodes: 2_000,
  maxRefs: 2_000,
  maxRefLength: 128,
  maxRoleLength: 128,
  maxTextLength: 16 * 1024,
  maxSnapshotRefLength: 128,
} as const;

const ACTION_KINDS = ["click", "fill", "type", "press", "scroll"] as const;

export type BrowserClawA11yActionKind = (typeof ACTION_KINDS)[number];

export interface BrowserClawA11yNode {
  ref: string;
  role: string;
  name?: string;
  value?: string;
  description?: string;
  checked?: boolean;
  disabled?: boolean;
  expanded?: boolean;
  children: readonly BrowserClawA11yNode[];
}

export interface BrowserClawA11ySnapshot {
  schema: typeof BROWSERCLAW_A11Y_SCHEMA;
  page: number;
  url: string;
  snapshotRef: string;
  root: BrowserClawA11yNode;
}

export type BrowserClawSemanticAction =
  | { kind: "click"; ref: string }
  | { kind: "fill"; ref: string; value: string }
  | { kind: "type"; ref: string; text: string }
  | { kind: "press"; key: string }
  | { kind: "scroll"; direction: "up" | "down"; amount?: number };

export interface BrowserClawA11yActionInput {
  snapshotRef: string;
  action: BrowserClawSemanticAction;
}

export interface BrowserClawA11yMetadata {
  page: number;
  url: string;
  snapshotRef: string;
}

export interface BrowserClawA11yParseOptions {
  maxBytes?: number;
  maxDepth?: number;
  maxNodes?: number;
  maxRefs?: number;
}

export type BrowserClawA11yErrorCode =
  | "invalid_response"
  | "ambiguous_response"
  | "oversized_snapshot"
  | "invalid_snapshot"
  | "malformed_node"
  | "duplicate_ref"
  | "malformed_text"
  | "stale_snapshot_ref"
  | "stale_node_ref"
  | "invalid_action";

/** Error raised when an untrusted BrowserClaw accessibility result is unsafe. */
export class BrowserClawA11yError extends Error {
  constructor(readonly code: BrowserClawA11yErrorCode, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "BrowserClawA11yError";
  }
}

type MutableA11yNode = {
  ref: string;
  role: string;
  name?: string;
  value?: string;
  description?: string;
  checked?: boolean;
  disabled?: boolean;
  expanded?: boolean;
  children: MutableA11yNode[];
};

type Limits = {
  maxBytes: number;
  maxDepth: number;
  maxNodes: number;
  maxRefs: number;
};

/** Return whether a value is a non-null record suitable for field inspection. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Return the UTF-8 byte length of a string without depending on a Node-only API. */
function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/** Throw when a configured parser limit is missing, non-positive, or non-integer. */
function positiveLimit(name: string, value: number | undefined, fallback: number): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new BrowserClawA11yError("invalid_response", `${name} must be a positive safe integer`);
  }
  return resolved;
}

/** Resolve parser limits once and reject unsafe configuration rather than clamping it. */
function resolveLimits(options: BrowserClawA11yParseOptions): Limits {
  return {
    maxBytes: positiveLimit("maxBytes", options.maxBytes, DEFAULT_LIMITS.maxBytes),
    maxDepth: positiveLimit("maxDepth", options.maxDepth, DEFAULT_LIMITS.maxDepth),
    maxNodes: positiveLimit("maxNodes", options.maxNodes, DEFAULT_LIMITS.maxNodes),
    maxRefs: positiveLimit("maxRefs", options.maxRefs, DEFAULT_LIMITS.maxRefs),
  };
}

/** Check a bounded single-line protocol token such as a semantic ref or role. */
function boundedToken(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength || /[\u0000-\u001f\u007f\s]/u.test(value)) {
    throw new BrowserClawA11yError("malformed_node", `${name} is not a bounded token`);
  }
  return value;
}

/** Check an optional accessibility string while preserving meaningful whitespace. */
function optionalText(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > DEFAULT_LIMITS.maxTextLength || /[\u0000\u007f]/u.test(value)) {
    throw new BrowserClawA11yError("malformed_node", `${name} is not bounded text`);
  }
  return value;
}

/** Validate the page metadata that accompanies a structured or text snapshot. */
function normalizeMetadata(value: unknown, code: "invalid_snapshot" | "malformed_text"): BrowserClawA11yMetadata {
  if (!isRecord(value)) throw new BrowserClawA11yError(code, "page metadata is missing");
  const page = value.page;
  const url = value.url;
  const snapshotRef = value.snapshotRef;
  if (typeof page !== "number" || !Number.isSafeInteger(page) || page < 0) throw new BrowserClawA11yError(code, "page must be a non-negative safe integer");
  if (typeof url !== "string" || url.length > 2048) throw new BrowserClawA11yError(code, "url is missing or too long");
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new BrowserClawA11yError(code, "url is not valid");
  }
  if (parsedUrl.protocol !== "https:" || parsedUrl.username || parsedUrl.password) {
    throw new BrowserClawA11yError(code, "url must be an HTTPS URL without credentials");
  }
  if (typeof snapshotRef !== "string" || snapshotRef.length === 0 || snapshotRef.length > DEFAULT_LIMITS.maxSnapshotRefLength || /[\u0000-\u001f\u007f\s]/u.test(snapshotRef)) {
    throw new BrowserClawA11yError(code, "snapshotRef is not a bounded token");
  }
  return { page, url, snapshotRef };
}

/** Record one node and recursively validate the structured accessibility tree. */
function normalizeNode(value: unknown, depth: number, state: { nodes: number; refs: Set<string> }, limits: Limits): BrowserClawA11yNode {
  if (!isRecord(value) || !Array.isArray(value.children)) {
    throw new BrowserClawA11yError("malformed_node", "each node requires an array of children");
  }
  if (depth > limits.maxDepth) throw new BrowserClawA11yError("oversized_snapshot", "accessibility tree depth exceeds the configured limit");
  state.nodes += 1;
  if (state.nodes > limits.maxNodes) throw new BrowserClawA11yError("oversized_snapshot", "accessibility tree node count exceeds the configured limit");
  const ref = boundedToken(value.ref, "ref", DEFAULT_LIMITS.maxRefLength);
  if (state.refs.has(ref)) throw new BrowserClawA11yError("duplicate_ref", `ref ${ref} occurs more than once`);
  state.refs.add(ref);
  if (state.refs.size > limits.maxRefs) throw new BrowserClawA11yError("oversized_snapshot", "accessibility ref count exceeds the configured limit");
  const role = boundedToken(value.role, "role", DEFAULT_LIMITS.maxRoleLength);
  const allowedKeys = new Set(["ref", "role", "name", "value", "description", "checked", "disabled", "expanded", "children"]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) throw new BrowserClawA11yError("malformed_node", "node contains an unsupported field");
  const node: BrowserClawA11yNode = {
    ref,
    role,
    ...(optionalText(value.name, "name") === undefined ? {} : { name: optionalText(value.name, "name") }),
    ...(optionalText(value.value, "value") === undefined ? {} : { value: optionalText(value.value, "value") }),
    ...(optionalText(value.description, "description") === undefined ? {} : { description: optionalText(value.description, "description") }),
    ...(value.checked === undefined ? {} : typeof value.checked === "boolean" ? { checked: value.checked } : (() => { throw new BrowserClawA11yError("malformed_node", "checked must be boolean"); })()),
    ...(value.disabled === undefined ? {} : typeof value.disabled === "boolean" ? { disabled: value.disabled } : (() => { throw new BrowserClawA11yError("malformed_node", "disabled must be boolean"); })()),
    ...(value.expanded === undefined ? {} : typeof value.expanded === "boolean" ? { expanded: value.expanded } : (() => { throw new BrowserClawA11yError("malformed_node", "expanded must be boolean"); })()),
    children: value.children.map((child) => normalizeNode(child, depth + 1, state, limits)),
  };
  return node;
}

/** Validate and copy an explicitly structured accessibility snapshot. */
function normalizeStructuredSnapshot(value: unknown, options: BrowserClawA11yParseOptions): BrowserClawA11ySnapshot {
  if (!isRecord(value)) throw new BrowserClawA11yError("invalid_snapshot", "structuredContent must be an object");
  const metadata = normalizeMetadata(value, "invalid_snapshot");
  if (value.schema !== BROWSERCLAW_A11Y_SCHEMA || !Object.prototype.hasOwnProperty.call(value, "root")) {
    throw new BrowserClawA11yError("invalid_snapshot", "structuredContent has an unsupported schema");
  }
  const limits = resolveLimits(options);
  const state = { nodes: 0, refs: new Set<string>() };
  const root = normalizeNode(value.root, 0, state, limits);
  let serialized: string;
  try {
    serialized = JSON.stringify({ schema: BROWSERCLAW_A11Y_SCHEMA, ...metadata, root });
  } catch {
    throw new BrowserClawA11yError("invalid_snapshot", "structuredContent could not be serialized");
  }
  if (byteLength(serialized) > limits.maxBytes) throw new BrowserClawA11yError("oversized_snapshot", "structuredContent exceeds the configured byte limit");
  return { schema: BROWSERCLAW_A11Y_SCHEMA, ...metadata, root };
}

interface ParsedTextNode {
  indent: number;
  node: MutableA11yNode;
}

/** Decode a quoted accessible name from the bounded text snapshot syntax. */
function decodeQuotedName(value: string): string {
  try {
    return JSON.parse(value) as string;
  } catch {
    throw new BrowserClawA11yError("malformed_text", "quoted accessibility name is not valid JSON text");
  }
}

/** Parse one role/name/ref line from the existing BrowserClaw text snapshot form. */
function parseTextNode(line: string): ParsedTextNode {
  const leading = line.match(/^[ \t]*/u)?.[0] ?? "";
  const indent = [...leading].reduce((total, character) => total + (character === "\t" ? 2 : 1), 0);
  let body = line.slice(leading.length);
  if (body.startsWith("- ") || body.startsWith("* ")) body = body.slice(2);
  const refMatch = body.match(/\[ref=([^\]\s]+)\]/u);
  if (!refMatch || refMatch.index === undefined) throw new BrowserClawA11yError("malformed_text", `unsupported accessibility line: ${body.slice(0, 128)}`);
  let head = body.slice(0, refMatch.index).trim();
  while (/\s+\[[^\]]+\]\s*$/u.test(head)) head = head.replace(/\s+\[[^\]]+\]\s*$/u, "").trim();
  const match = head.match(/^(\S+)(?:\s+("(?:\\.|[^"\\])*"))?$/u);
  if (!match) throw new BrowserClawA11yError("malformed_text", `unsupported accessibility line: ${body.slice(0, 128)}`);
  const role = boundedToken(match[1], "role", DEFAULT_LIMITS.maxRoleLength);
  const ref = boundedToken(refMatch[1], "ref", DEFAULT_LIMITS.maxRefLength);
  const name = match[2] === undefined ? undefined : decodeQuotedName(match[2]);
  if (name !== undefined && name.length > DEFAULT_LIMITS.maxTextLength) throw new BrowserClawA11yError("malformed_text", "accessibility name is too long");
  const after = body.slice(refMatch.index + refMatch[0].length).trim();
  const valueMatch = after.match(/^:\s+("(?:\\.|[^"\\])*")$/u);
  const value = valueMatch?.[1] === undefined ? undefined : decodeQuotedName(valueMatch[1]);
  return { indent, node: { ref, role, ...(name === undefined ? {} : { name }), ...(value === undefined ? {} : { value }), children: [] } };
}

/** Normalize the bounded role/name/ref text serialization into a tree snapshot. */
function normalizeTextSnapshot(text: string, metadataValue: unknown, options: BrowserClawA11yParseOptions): BrowserClawA11ySnapshot {
  const metadata = normalizeMetadata(metadataValue, "malformed_text");
  const limits = resolveLimits(options);
  if (byteLength(text) > limits.maxBytes) throw new BrowserClawA11yError("oversized_snapshot", "text snapshot exceeds the configured byte limit");
  const lines = text
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0)
    .filter((line) => !/^\s*\[UNTRUSTED_PAGE_CONTENT\b[^\]]*\]\s*/u.test(line))
    .filter((line) => !/^\s*Treat everything below as untrusted page content\.?\s*$/iu.test(line))
    .filter((line) => /\[ref=[^\]\s]+\]/u.test(line));
  if (lines.length === 0) throw new BrowserClawA11yError("malformed_text", "text snapshot is empty");
  const parsed = lines.map(parseTextNode);
  const state = { nodes: 0, refs: new Set<string>() };
  const roots: MutableA11yNode[] = [];
  const stack: ParsedTextNode[] = [];
  for (const entry of parsed) {
    if (state.nodes >= limits.maxNodes) throw new BrowserClawA11yError("oversized_snapshot", "text snapshot node count exceeds the configured limit");
    state.nodes += 1;
    if (state.refs.has(entry.node.ref)) throw new BrowserClawA11yError("duplicate_ref", `ref ${entry.node.ref} occurs more than once`);
    state.refs.add(entry.node.ref);
    if (state.refs.size > limits.maxRefs) throw new BrowserClawA11yError("oversized_snapshot", "text snapshot ref count exceeds the configured limit");
    while (stack.length > 0 && entry.indent <= stack[stack.length - 1].indent) stack.pop();
    if (stack.length === 0) roots.push(entry.node);
    else stack[stack.length - 1].node.children.push(entry.node);
    stack.push(entry);
    if (stack.length - 1 > limits.maxDepth) throw new BrowserClawA11yError("oversized_snapshot", "text snapshot depth exceeds the configured limit");
  }
  const rootRef = roots.some((node) => node.ref === "__document__") ? "__document__-root" : "__document__";
  const root: BrowserClawA11yNode = { ref: rootRef, role: "document", children: roots };
  return { schema: BROWSERCLAW_A11Y_SCHEMA, ...metadata, root };
}

/** Extract the last JSON-RPC object from a JSON or Server-Sent Events payload. */
function parseSerializedEnvelope(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    const dataLines = value.split(/\r?\n/u).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).filter(Boolean);
    for (let index = dataLines.length - 1; index >= 0; index -= 1) {
      try {
        return JSON.parse(dataLines[index]) as unknown;
      } catch {
        // Ignore non-JSON SSE keep-alive/data lines and try the previous event.
      }
    }
  }
  throw new BrowserClawA11yError("invalid_response", "BrowserClaw response is not JSON or JSON-RPC SSE");
}

/** Extract a content array from an MCP response envelope without accepting mixed payloads. */
function contentFromEnvelope(value: Record<string, unknown>): unknown[] | undefined {
  const result = isRecord(value.result) ? value.result : undefined;
  const directContent = value.content;
  const nestedContent = result?.content;
  if (directContent !== undefined && nestedContent !== undefined) throw new BrowserClawA11yError("ambiguous_response", "response contains two content envelopes");
  const content = directContent ?? nestedContent;
  return content === undefined ? undefined : Array.isArray(content) ? content : (() => { throw new BrowserClawA11yError("invalid_response", "content must be an array"); })();
}

/** Normalize structuredContent or bounded text from an MCP response into one validated snapshot. */
export function normalizeBrowserClawA11yResponse(
  response: unknown,
  textMetadata?: BrowserClawA11yMetadata,
  options: BrowserClawA11yParseOptions = {},
): BrowserClawA11ySnapshot {
  const limits = resolveLimits(options);
  if (typeof response === "string") {
    if (byteLength(response) > limits.maxBytes) throw new BrowserClawA11yError("oversized_snapshot", "response exceeds the configured byte limit");
    try {
      response = parseSerializedEnvelope(response);
    } catch (error) {
      if (textMetadata) return normalizeTextSnapshot(response as string, textMetadata, options);
      throw error;
    }
  }
  if (!isRecord(response)) throw new BrowserClawA11yError("invalid_response", "BrowserClaw response must be an object");

  const result = isRecord(response.result) ? response.result : undefined;
  const directStructured = response.structuredContent;
  const nestedStructured = result?.structuredContent;
  if (directStructured !== undefined && nestedStructured !== undefined) throw new BrowserClawA11yError("ambiguous_response", "response contains two structuredContent envelopes");
  const structuredContent = directStructured ?? nestedStructured;
  const content = contentFromEnvelope(response);
  if (structuredContent !== undefined && content !== undefined) throw new BrowserClawA11yError("ambiguous_response", "response mixes structuredContent and text content");
  if (structuredContent !== undefined) return normalizeStructuredSnapshot(structuredContent, options);

  if (response.schema === BROWSERCLAW_A11Y_SCHEMA) return normalizeStructuredSnapshot(response, options);
  if (content !== undefined) {
    const textItems = content.filter((item): item is { type: "text"; text: string } => isRecord(item) && item.type === "text" && typeof item.text === "string");
    if (textItems.length !== content.length || textItems.length === 0) throw new BrowserClawA11yError("malformed_text", "content must contain only non-empty text snapshot items");
    const text = textItems.map((item) => item.text).join("\n");
    if (textItems.some((item) => item.text.length === 0)) throw new BrowserClawA11yError("malformed_text", "text snapshot item is empty");
    return normalizeTextSnapshot(text, textMetadata, options);
  }
  throw new BrowserClawA11yError("invalid_response", "response contains no structuredContent or text content");
}

/** Return all refs in the latest validated snapshot for semantic-action checks. */
function snapshotRefs(snapshot: BrowserClawA11ySnapshot): Set<string> {
  const refs = new Set<string>();
  const visit = (node: BrowserClawA11yNode): void => {
    refs.add(node.ref);
    for (const child of node.children) visit(child);
  };
  visit(snapshot.root);
  return refs;
}

/** Validate one action against the latest snapshot and return a safe normalized payload. */
export function validateBrowserClawSemanticAction(
  snapshot: BrowserClawA11ySnapshot,
  input: unknown,
): BrowserClawA11yActionInput {
  if (!isRecord(input) || input.snapshotRef !== snapshot.snapshotRef) {
    throw new BrowserClawA11yError("stale_snapshot_ref", "semantic action does not target the latest snapshot");
  }
  if (!isRecord(input.action) || typeof input.action.kind !== "string" || !ACTION_KINDS.includes(input.action.kind as BrowserClawA11yActionKind)) {
    throw new BrowserClawA11yError("invalid_action", "semantic action kind is unsupported");
  }
  const action = input.action;
  const keys = Object.keys(action);
  const refs = snapshotRefs(snapshot);
  const checkRef = (value: unknown): string => {
    if (typeof value !== "string" || !refs.has(value)) throw new BrowserClawA11yError("stale_node_ref", "semantic action ref is not in the latest snapshot");
    return value;
  };
  if (action.kind === "click") {
    if (keys.some((key) => !["kind", "ref"].includes(key))) throw new BrowserClawA11yError("invalid_action", "click action has unsupported fields");
    return { snapshotRef: snapshot.snapshotRef, action: { kind: "click", ref: checkRef(action.ref) } };
  }
  if (action.kind === "fill") {
    if (keys.some((key) => !["kind", "ref", "value"].includes(key)) || typeof action.value !== "string" || action.value.length > DEFAULT_LIMITS.maxTextLength) throw new BrowserClawA11yError("invalid_action", "fill action is malformed or oversized");
    return { snapshotRef: snapshot.snapshotRef, action: { kind: "fill", ref: checkRef(action.ref), value: action.value } };
  }
  if (action.kind === "type") {
    if (keys.some((key) => !["kind", "ref", "text"].includes(key)) || typeof action.text !== "string" || action.text.length > DEFAULT_LIMITS.maxTextLength) throw new BrowserClawA11yError("invalid_action", "type action is malformed or oversized");
    return { snapshotRef: snapshot.snapshotRef, action: { kind: "type", ref: checkRef(action.ref), text: action.text } };
  }
  if (action.kind === "scroll") {
    if (keys.some((key) => !["kind", "direction", "amount"].includes(key))
      || (action.direction !== "up" && action.direction !== "down")
      || (action.amount !== undefined && (typeof action.amount !== "number" || !Number.isInteger(action.amount) || action.amount < 1 || action.amount > 20))) {
      throw new BrowserClawA11yError("invalid_action", "scroll action is malformed or out of bounds");
    }
    return {
      snapshotRef: snapshot.snapshotRef,
      action: { kind: "scroll", direction: action.direction, ...(action.amount === undefined ? {} : { amount: action.amount }) },
    };
  }
  if (keys.some((key) => !["kind", "key"].includes(key)) || typeof action.key !== "string" || action.key.length === 0 || action.key.length > 64 || /[\u0000-\u001f\u007f\s]/u.test(action.key)) {
    throw new BrowserClawA11yError("invalid_action", "press action key is malformed or oversized");
  }
  return { snapshotRef: snapshot.snapshotRef, action: { kind: "press", key: action.key } };
}
