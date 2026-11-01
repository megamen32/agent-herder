#!/usr/bin/env node
import { open, readFile, realpath, stat, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { executeProjectRelease } from "./mcp/project-release-tools.js";
import { ProjectReleaseLeaseStore, type ReleaseOwner } from "./project-release-lease.js";

/** Offline owner route. The operator must independently verify the live authority path.
 * No default ledger, discovery, new authority, or implicit bootstrap is allowed.
 * Even status uses the existing store transaction and can rewrite the ledger.
 */
export async function runReleaseAdmin(options: {
  ledger: string; authorityHost: string; request: unknown; proofOut?: string;
}) {
  if (options.authorityHost !== hostname()) throw new Error("release_admin_authority_mismatch");
  if (!isAbsolute(options.ledger)) throw new Error("release_admin_absolute_ledger_required");
  const ledger = await realpath(options.ledger);
  // The live store locks and replaces its configured spelling, not realpath.
  // Silently following an alias can create a second lock/authority namespace.
  if (options.ledger !== ledger) throw new Error("release_admin_canonical_ledger_required");
  if (!(await stat(ledger)).isFile()) throw new Error("release_admin_ledger_not_file");
  const store = new ProjectReleaseLeaseStore(ledger, Date.now, true);
  const request = options.request as Record<string, unknown>;
  const acquiring = request?.action === "acquire";
  if (acquiring && (!options.proofOut || !isAbsolute(options.proofOut)))
    throw new Error("release_admin_absolute_proof_output_required");
  if (!acquiring && options.proofOut) throw new Error("release_admin_unexpected_proof_output");
  // Reserve exclusively before taking a lease. Never overwrite another capability.
  const output = acquiring ? await open(options.proofOut!, "wx", 0o600) : undefined;
  let result: Record<string, unknown> | undefined;
  try {
    result = await executeProjectRelease(options.request, store);
    if (output) {
      if (result.acquired !== true || typeof result.token !== "string")
        throw new Error("release_admin_lease_not_acquired");
      await output.writeFile(JSON.stringify({
        project: result.project, owner: request.owner, token: result.token, fence: (result.lease as { fence: number }).fence,
      }) + "\n");
      await output.sync();
    }
    const { token: _token, ...safe } = result;
    return { ...safe, ...(output ? { proofPath: options.proofOut } : {}) };
  } catch (error) {
    if (result?.token) {
      // Failure to save the capability must not leave an inaccessible lease.
      // Roll back the exact acquired project even if cwd vanished or changed.
      // If rollback fails, retain the protected output for operator recovery.
      await store.release(result.project as string, {
        owner: request.owner as ReleaseOwner, token: result.token as string,
        fence: (result.lease as { fence: number }).fence,
      });
    }
    if (output) await unlink(options.proofOut!);
    throw error;
  } finally {
    await output?.close();
  }
}

async function main() {
  const args = process.argv.slice(2);
  const allowed = new Set(["--ledger", "--authority-host", "--request", "--proof-out"]);
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    if (!allowed.has(args[i]) || !args[i + 1] || values.has(args[i]))
      throw new Error("release_admin_invalid_arguments");
    values.set(args[i], args[i + 1]);
  }
  for (const key of ["--ledger", "--authority-host", "--request"])
    if (!values.has(key)) throw new Error("release_admin_required_argument_missing");
  const result = await runReleaseAdmin({
    ledger: values.get("--ledger")!, authorityHost: values.get("--authority-host")!,
    request: JSON.parse(await readFile(values.get("--request")!, "utf8")),
    proofOut: values.get("--proof-out"),
  });
  process.stdout.write(JSON.stringify(result) + "\n");
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch(() => {
    // Never echo untrusted requests or capability-containing validation errors.
    process.stderr.write("release_admin_failed\n"); process.exitCode = 1;
  });
