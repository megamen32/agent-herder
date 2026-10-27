import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { GoalEvidence, GoalIdentity, GoalRequirement } from "./goal-store.js";

export type GoalEvidenceTargetRef = { requirementId: string; path: string };
export type GoalEvidenceMaterial = { requirementId: string; path: string; version: string; text: string; complete: true };
export type GoalEvidenceCollection = { evidence: GoalEvidence[]; materials: GoalEvidenceMaterial[]; unavailable: string[] };
export type GoalEvidenceLimits = { maxFiles?: number; maxFileBytes?: number; maxTotalBytes?: number; freshnessMs?: number };

const DEFAULT_LIMITS: Required<GoalEvidenceLimits> = { maxFiles: 16, maxFileBytes: 256 * 1024, maxTotalBytes: 1024 * 1024, freshnessMs: 60_000 };
const HARD_LIMITS: Required<GoalEvidenceLimits> = { maxFiles: 64, maxFileBytes: 1024 * 1024, maxTotalBytes: 8 * 1024 * 1024, freshnessMs: 10 * 60_000 };

/** Read only explicitly declared files from the exact project tree, with realpath and stable-read fences. */
export async function collectGoalEvidence(input: {
  identity: GoalIdentity;
  requirements: GoalRequirement[];
  targetRefs: GoalEvidenceTargetRef[];
  limits?: GoalEvidenceLimits;
}): Promise<GoalEvidenceCollection> {
  const limits = normalizeLimits(input.limits);
  if (!Array.isArray(input.targetRefs)) throw new Error("goal evidence targetRefs must be an explicit list");
  if (input.targetRefs.length > limits.maxFiles) throw new Error(`goal evidence target count exceeds ${limits.maxFiles}`);
  const cwd = await realpath(input.identity.cwd);
  const cwdStat = await stat(cwd);
  if (!cwdStat.isDirectory()) throw new Error("goal evidence project cwd is not a directory");
  const requirementIds = new Set(input.requirements.map((item) => item.id));
  const evidence: GoalEvidence[] = [];
  const materials: GoalEvidenceMaterial[] = [];
  const unavailable: string[] = [];
  const seen = new Set<string>();
  const seenCanonicalTargets = new Set<string>();
  let totalBytes = 0;

  for (const target of input.targetRefs) {
    if (!target || typeof target.requirementId !== "string" || typeof target.path !== "string" || !target.path.trim()) {
      unavailable.push("invalid evidence target reference");
      continue;
    }
    const suppliedPath = target.path.trim();
    const dedupeKey = `${target.requirementId}\0${suppliedPath}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    if (!requirementIds.has(target.requirementId)) {
      unavailable.push(`unknown requirement for declared evidence path: ${suppliedPath}`);
      continue;
    }
    let resolvedPath: string | undefined;
    try {
      const candidate = isAbsolute(suppliedPath) ? resolve(suppliedPath) : resolve(cwd, suppliedPath);
      if (isSensitivePath(suppliedPath) || isSensitivePath(relative(cwd, candidate))) throw new Error("sensitive path refused");
      resolvedPath = await realpath(candidate);
      assertInside(cwd, resolvedPath);
      if (isSensitivePath(relative(cwd, resolvedPath))) throw new Error("sensitive path refused");
      const evidenceId = createHash("sha256").update(`${target.requirementId}\0${resolvedPath}`).digest("hex");
      if (seenCanonicalTargets.has(evidenceId)) continue;
      seenCanonicalTargets.add(evidenceId);
      const before = await stat(resolvedPath, { bigint: true });
      if (!before.isFile()) throw new Error("special files are unavailable");
      if (before.size > BigInt(limits.maxFileBytes)) throw new Error("file exceeds per-file evidence limit");
      if (totalBytes + Number(before.size) > limits.maxTotalBytes) throw new Error("files exceed aggregate evidence limit");
      const handle = await open(resolvedPath, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
      let bytes: Buffer;
      try {
        const openedBefore = await handle.stat({ bigint: true });
        if (!openedBefore.isFile()) throw new Error("special files are unavailable");
        assertStable(before, openedBefore);
        bytes = await readBounded(handle, limits.maxFileBytes);
        const openedAfter = await handle.stat({ bigint: true });
        assertStable(openedBefore, openedAfter);
      } finally {
        await handle.close();
      }
      const pathAfter = await realpath(candidate);
      assertInside(cwd, pathAfter);
      if (pathAfter !== resolvedPath) throw new Error("file target changed during evidence read");
      const after = await stat(pathAfter, { bigint: true });
      assertStable(before, after);
      if (bytes.byteLength !== Number(after.size) || totalBytes + bytes.byteLength > limits.maxTotalBytes) throw new Error("file changed or aggregate evidence limit exceeded");
      const text = bytes.toString("utf8");
      if (!Buffer.from(text, "utf8").equals(bytes)) throw new Error("file is not complete UTF-8 text");
      totalBytes += bytes.byteLength;
      const observedAt = new Date().toISOString();
      const version = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
      const id = evidenceId;
      evidence.push({ id, requirementId: target.requirementId, version, provenance: resolvedPath, observedAt,
        freshUntil: new Date(Date.now() + limits.freshnessMs).toISOString(), materialLoaded: true, text });
      materials.push({ requirementId: target.requirementId, path: resolvedPath, version, text, complete: true });
    } catch (error) {
      const reason = error instanceof Error ? error.message : "file evidence unavailable";
      unavailable.push(`${suppliedPath}: ${reason}`);
      const provenance = resolvedPath && isInside(cwd, resolvedPath) ? resolvedPath : suppliedPath;
      const id = createHash("sha256").update(`${target.requirementId}\0${provenance}`).digest("hex");
      if (evidence.some((item) => item.id === id)) continue;
      evidence.push({ id, requirementId: target.requirementId, version: "unavailable", provenance,
        observedAt: new Date().toISOString(), freshUntil: new Date(0).toISOString(), materialLoaded: false });
    }
  }
  return { evidence, materials, unavailable };
}

function normalizeLimits(limits?: GoalEvidenceLimits): Required<GoalEvidenceLimits> {
  const value = { ...DEFAULT_LIMITS, ...(limits ?? {}) };
  for (const key of ["maxFiles", "maxFileBytes", "maxTotalBytes", "freshnessMs"] as const) {
    if (!Number.isSafeInteger(value[key]) || value[key] <= 0) throw new Error(`goal evidence ${key} must be a positive safe integer`);
    if (value[key] > HARD_LIMITS[key]) throw new Error(`goal evidence ${key} exceeds the hard bound ${HARD_LIMITS[key]}`);
  }
  return value;
}
async function readBounded(handle: Awaited<ReturnType<typeof open>>, maxBytes: number): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(maxBytes + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  if (offset > maxBytes) throw new Error("file grew beyond the per-file evidence limit while reading");
  return buffer.subarray(0, offset);
}
function assertInside(cwd: string, candidate: string): void { if (!isInside(cwd, candidate)) throw new Error("resolved path escapes project cwd"); }
function isInside(cwd: string, candidate: string): boolean {
  const rel = relative(cwd, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
function isSensitivePath(path: string): boolean {
  const parts = path.split(sep).map((part) => part.toLowerCase());
  return parts.some((part) => part === ".ssh" || part === ".aws" || part === ".gnupg" || part === ".env" || part.startsWith(".env.")
    || /(^|[._-])(secret|token|credential|credentials)([._-]|$)/u.test(part)
    || /^(id_rsa|id_ed25519|private\.key)$/u.test(part)
    || part.endsWith(".pem") || part.endsWith(".key"));
}
function assertStable(before: Awaited<ReturnType<typeof stat>> & { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint }, after: typeof before): void {
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
    throw new Error("file changed during evidence read");
  }
}
