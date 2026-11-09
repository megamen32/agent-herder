import {readFile, lstat, mkdir, open} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {isAbsolute, join} from 'node:path';
import {executeInstalledBrowserSmoke, validateSmokeFixture, validateSmokeRequest, SmokeFailure, SMOKE_HARNESSES, SMOKE_CHECKS, type SmokeBindings, type SmokeFixture, type SmokeRequest} from './installed-browser-smoke.js';

let bootstrap: {request: SmokeRequest; runRoot: string; started: boolean} | undefined;

async function privateJson(path: string) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()) throw new SmokeFailure('private_input_required');
  const raw = await readFile(path);
  if (raw.length > 1024 * 1024) throw new SmokeFailure('input_too_large');
  return JSON.parse(raw.toString());
}
async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 6 || args[0] !== '--fixture' || args[2] !== '--request' || args[4] !== '--run-root') throw new SmokeFailure('fixed_arguments_required');
  const fixture = await privateJson(args[1]);
  const request = await privateJson(args[3]) as SmokeRequest;
  validateSmokeFixture(fixture as SmokeFixture); validateSmokeRequest(request);
  bootstrap = {request, runRoot: args[5], started: false};
  const modulePath = fixture.bindings_module;
  if (typeof modulePath !== 'string' || !isAbsolute(modulePath) || !/^[0-9a-f]{64}$/.test(fixture.bindings_sha256)) throw new SmokeFailure('pinned_bindings_required');
  const info = await lstat(modulePath);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o022) !== 0) throw new SmokeFailure('bindings_not_protected');
  const raw = await readFile(modulePath);
  if (createHash('sha256').update(raw).digest('hex') !== fixture.bindings_sha256) throw new SmokeFailure('bindings_digest_mismatch');
  const module = await import(pathToFileURL(modulePath).href);
  if (typeof module.createInstalledSmokeBindings !== 'function') throw new SmokeFailure('bindings_factory_missing');
  fixture.fixture_path = args[1];
  const bindings = await module.createInstalledSmokeBindings(fixture) as SmokeBindings;
  const close = bindings.close.bind(bindings);
  let closing: Promise<unknown> | undefined;
  bindings.close = () => closing ??= close();
  let report: any;
  try {bootstrap.started = true; report = await executeInstalledBrowserSmoke(fixture, request, bindings, args[5]);}
  finally {try {await bindings.close();} catch { /* The protected report retains the original cleanup receipt. */ }}
  const summary = {mode: 'installed-browser', status: report.status, run_id: request.run_id,
    functional_status: report.functional_status, global_inventory_status: report.global_inventory_status,
    source_sha: request.expected_source_sha, identity: report.identity, browser_cleanup: report.browser_cleanup,
    lanes: Object.fromEntries(Object.entries(report.lanes).map(([name, value]: [string, any]) =>
      [name, {checks: value.checks, error_code: value.error_code, cleanup_error_code: value.cleanup_error_code}]))};
  process.stdout.write(JSON.stringify(summary) + '\n');
  process.exitCode = report.status === 'PASS' ? 0 : 1;
}
main().catch(async error => {
  const code = typeof error?.code === 'string' && /^[a-z][a-z_]{1,95}$/.test(error.code)
    ? error.code : 'installed_browser_preflight_or_collector_failed';
  const missing = Array.isArray(error?.receipt?.missing_harnesses)
    ? error.receipt.missing_harnesses.filter((name: unknown) => SMOKE_HARNESSES.includes(name as any)) : undefined;
  const report = {mode: 'installed-browser', stage: 'installed', status: 'FAIL', functional_status: 'FAIL',
    global_inventory_status: 'UNVERIFIED', phase: bootstrap?.started ? 'execution' : 'preflight', error_code: code,
    model_effects: bootstrap?.started ? 'UNKNOWN' : 'NOT_SUBMITTED', identity: 'UNKNOWN', browser_cleanup: 'NOT_CREATED',
    ...(missing ? {missing_harnesses: missing} : {}),
    ...(bootstrap ? {run_id: bootstrap.request.run_id, source_sha: bootstrap.request.expected_source_sha} : {}),
    lanes: Object.fromEntries(SMOKE_HARNESSES.map(h => [h, {checks: Object.fromEntries(SMOKE_CHECKS.map(c => [c, 'UNKNOWN']))}]))};
  if (bootstrap && !bootstrap.started) {
    try {
      // Never overwrite an earlier run, including an earlier UNKNOWN attempt.
      await mkdir(bootstrap.runRoot, {mode: 0o700});
      const stream = await open(join(bootstrap.runRoot, 'report.json'), 'wx', 0o600);
      try {await stream.writeFile(JSON.stringify(report, null, 2) + '\n'); await stream.sync();} finally {await stream.close();}
      const directory = await open(bootstrap.runRoot, 'r');
      try {await directory.sync();} finally {await directory.close();}
    } catch { /* The fixed helper still reports FAIL when no durable report can be written. */ }
  }
  process.stdout.write(JSON.stringify({mode: report.mode, status: report.status, phase: report.phase,
    error_code: code, model_effects: report.model_effects, ...(missing ? {missing_harnesses: missing} : {})}) + '\n');
  process.exitCode = 2;
});
