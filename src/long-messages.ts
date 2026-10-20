import { chmod, link, lstat, mkdir, open, readFile, rename, rm, stat, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { hostname, homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";

export const LONG_AUTOMATIC_MESSAGE_THRESHOLD = 600;
const PREVIEW_LENGTH = 80;
const DEFAULT_READ_LIMIT = 4_000;
const MAX_READ_LIMIT = 8_000;

export function longMessageResourceUri(messageId: string, offset = 0, limit = DEFAULT_READ_LIMIT): string {
  if (!/^[a-f0-9]{64}$/.test(messageId)) throw new Error("Unknown long message ID");
  return `herder://messages/${messageId}/${offset}/${limit}`;
}

function storeDirectory(): string {
  return resolve(process.env.AGENT_HERDER_LONG_MESSAGES_DIR || join(homedir(), ".local", "state", "agent-herder", "long-messages"));
}

export async function compactAutomaticMessage(message: string, threshold = LONG_AUTOMATIC_MESSAGE_THRESHOLD): Promise<string> {
  if (message.length <= threshold) return message;
  const sha256 = createHash("sha256").update(message, "utf8").digest("hex");
  const directory = storeDirectory();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmodPrivate(directory);
  const target = join(directory, `${sha256}.txt`);
  try {
    const existing = await readFile(target, "utf8");
    if (existing !== message) throw new Error("Long message content-address collision");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const temporary = join(directory, `.${sha256}.${process.pid}.${randomUUID()}.tmp`);
    try {
      const file = await open(temporary, "wx", 0o600);
      try { await file.writeFile(message, "utf8"); await file.sync(); }
      finally { await file.close(); }
      await rename(temporary, target);
      const directoryHandle = await open(directory, constants.O_RDONLY);
      try { await directoryHandle.sync(); }
      finally { await directoryHandle.close(); }
    } catch (writeError) {
      const code = (writeError as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw writeError;
      const existing = await readFile(target, "utf8");
      if (existing !== message) throw new Error("Long message content-address collision");
    } finally {
      await rm(temporary, { force: true });
    }
  }
  await chmodPrivate(target);
  const preview = message.slice(0, PREVIEW_LENGTH);
  return `${preview}…
[Incomplete preview; read the full original before acting.]
read_message({"messageId":"${sha256}"})
Fallback MCP resource: ${longMessageResourceUri(sha256, 0, DEFAULT_READ_LIMIT)}`;
}

export async function readLongMessage(input: { messageId: string; offset?: number; limit?: number }): Promise<{
  messageId: string; sha256: string; total: number; offset: number; nextOffset: number | null; text: string;
}> {
  if (!/^[a-f0-9]{64}$/.test(input.messageId)) throw new Error("Unknown long message ID");
  const offset = input.offset ?? 0;
  const limit = input.limit ?? DEFAULT_READ_LIMIT;
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("offset must be a non-negative integer");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_READ_LIMIT) throw new Error(`limit must be between 1 and ${MAX_READ_LIMIT}`);
  const stored = await readStoredLongMessage(input.messageId);
  const end = Math.min(stored.text.length, offset + limit);
  return { messageId: input.messageId, sha256: stored.sha256, total: stored.text.length, offset, nextOffset: end < stored.text.length ? end : null, text: stored.text.slice(offset, end) };
}

export async function saveLongMessageToWorkspace(input: { messageId: string; cwd: string }): Promise<{
  path: string; sha256: string; bytes: number; host: { name: string; note: string };
}> {
  const stored = await readStoredLongMessage(input.messageId);
  if (typeof input.cwd !== "string" || !input.cwd.trim() || !isAbsolute(input.cwd)) throw new Error("cwd must be an absolute path to an existing workspace");
  let workspace: string;
  try { workspace = await realpath(input.cwd); }
  catch { throw new Error("cwd must be an existing workspace directory"); }
  if (workspace !== resolve(input.cwd)) throw new Error("cwd must not resolve through symlinks");
  const workspaceInfo = await stat(workspace);
  if (!workspaceInfo.isDirectory()) throw new Error("cwd must be an existing workspace directory");

  const privateRoot = await ensureWorkspaceDirectory(workspace, ".agent-herder");
  const messageDirectory = await ensureWorkspaceDirectory(privateRoot, "messages");
  const target = join(messageDirectory, `${input.messageId}.txt`);
  const existing = await lstat(target).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  if (existing) {
    if (existing.isSymbolicLink() || !existing.isFile() || existing.nlink !== 1) throw new Error("Message output target must be a regular, unlinked file");
    const content = await readFile(target);
    if (!content.equals(stored.bytes)) throw new Error("Existing message output has different contents; refusing to overwrite");
    await chmod(target, 0o600);
  } else {
    await writeMessageNoReplace(messageDirectory, target, stored.bytes);
  }
  return {
    path: target,
    sha256: stored.sha256,
    bytes: stored.bytes.length,
    host: { name: hostname(), note: "This path is on the Agent Herder MCP host; it is not automatically available on the calling machine." },
  };
}

async function readStoredLongMessage(messageId: string): Promise<{ bytes: Buffer; text: string; sha256: string }> {
  if (!/^[a-f0-9]{64}$/.test(messageId)) throw new Error("Unknown long message ID");
  let bytes: Buffer;
  try { bytes = await readFile(join(storeDirectory(), `${messageId}.txt`)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("Unknown long message ID");
    throw error;
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== messageId) throw new Error("Stored long message failed integrity check");
  return { bytes, text: bytes.toString("utf8"), sha256 };
}

async function ensureWorkspaceDirectory(parent: string, name: string): Promise<string> {
  const directory = join(parent, name);
  let created = false;
  try { await mkdir(directory, { mode: 0o700 }); created = true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const info = await lstat(directory);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Workspace path component '${name}' must be a real directory`);
  const canonical = await realpath(directory);
  if (canonical !== directory) throw new Error(`Workspace path component '${name}' escapes the workspace`);
  if (created && (info.mode & 0o777) !== 0o700) await chmod(directory, 0o700);
  return directory;
}

async function writeMessageNoReplace(directory: string, target: string, content: Buffer): Promise<void> {
  const temporary = join(directory, `.message-${process.pid}-${randomUUID()}.tmp`);
  try {
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(content); await file.sync(); }
    finally { await file.close(); }
    await link(temporary, target);
    await rm(temporary);
    const directoryHandle = await open(directory, constants.O_RDONLY);
    try { await directoryHandle.sync(); }
    finally { await directoryHandle.close(); }
  } catch (error) {
    await rm(temporary, { force: true });
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await lstat(target);
    if (existing.isSymbolicLink() || !existing.isFile() || existing.nlink !== 1) throw new Error("Message output target must be a regular, unlinked file");
    const existingBytes = await readFile(target);
    if (!existingBytes.equals(content)) throw new Error("Existing message output has different contents; refusing to overwrite");
    await chmod(target, 0o600);
  }
}

async function chmodPrivate(path: string): Promise<void> {
  const info = await stat(path).catch(() => undefined);
  if (info?.isDirectory()) await chmod(path, 0o700);
  else if (info) await chmod(path, 0o600);
}
