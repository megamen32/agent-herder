#!/usr/bin/env node
/**
 * The portable payload of the plugin of Codex for a node of the fleet.
 *
 * The release carries the runtime of the panel and nothing of the plugin: the
 * scripts of the hooks and the manifests of the plugin are not part of it. A
 * fleet node therefore had nothing to lay the plugin out with, and the plugin
 * that was installed on it stayed on the contract it was built with.
 *
 * This script packs the reviewed package root of the plugin from the
 * repository: the portable manifest, the native manifest, the marketplace, the
 * MCP route, the scripts of the hooks with every helper they import, the
 * skills, the built runtime and the production dependencies of that runtime.
 * The result is self contained: no network, no installation, no provider.
 *
 * The payload is what `prepare-codex-native-projection.mjs` takes as its
 * reviewed package root on the node:
 *
 *   node scripts/prepare-codex-native-projection.mjs \
 *     <release>/dist/plugin/codex/agent-herder <output> <new-stable-version>
 *
 * Usage:
 *   node scripts/build-codex-plugin-payload.mjs [--out <dir>] [--repo <dir>]
 *                                                [--dist <dir>] [--node-modules <dir>]
 */
import { createHash, randomUUID } from 'node:crypto';
import { cp, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { PAYLOAD, resolveDependencyClosure, resolveModuleClosure, resolveScriptClosure } from './prepare-codex-native-projection.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Where the payload of the plugin lives inside the runtime of the release. */
export const DEFAULT_OUT = join(repoRoot, 'dist', 'plugin', 'codex', 'agent-herder');

/** The manifests the projection of the native package reads. */
const MANIFESTS = [
  'package.json',
  'plugin.json',
  '.mcp.json',
  '.codex-plugin/plugin.json',
  '.agents/plugins/marketplace.json',
  'com.openai/hooks/hooks.json',
];
/** The runtime modules the hook of the plugin loads. */
const DIST_ENTRIES = ['autopilot-hook.js', 'autopilot-runner.js', 'human-stop-store.js'];
/** The contract of the digest of the Stop hook of Codex. */
const DIGEST_ROUTE = '/api/human-stop/generated-prompt';
const LOCAL_FALLBACK = 'dist/human-stop-store.js';

function parseArguments(argv) {
  const options = {
    out: DEFAULT_OUT,
    repo: repoRoot,
    dist: join(repoRoot, 'dist'),
    nodeModules: join(repoRoot, 'node_modules'),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--out') { options.out = resolve(argv[++index] ?? options.out); continue; }
    if (argument === '--repo') { options.repo = resolve(argv[++index] ?? options.repo); continue; }
    if (argument === '--dist') { options.dist = resolve(argv[++index] ?? options.dist); continue; }
    if (argument === '--node-modules') { options.nodeModules = resolve(argv[++index] ?? options.nodeModules); continue; }
    throw new Error(`unknown argument: ${argument}`);
  }
  options.dist = resolve(options.dist);
  options.nodeModules = resolve(options.nodeModules);
  return options;
}

function digest(value) { return createHash('sha256').update(value).digest('hex'); }

/** Copy a tree without a single symlink: the release manifest refuses them. */
async function copyTree(source, target, filter) {
  await cp(source, target, { recursive: true, dereference: true, filter });
}

async function exists(path) {
  try { await lstat(path); return true; } catch { return false; }
}

async function isDirectory(path) {
  try { return (await lstat(path)).isDirectory(); } catch { return false; }
}

/** Every file of the payload with its hash: the receipt of the payload. */
async function inventory(root) {
  const files = {};
  async function walk(directory) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = join(directory, entry.name);
      const stat = await lstat(absolute);
      if (stat.isSymbolicLink()) throw new Error(`symlink in the payload: ${relative(root, absolute)}`);
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile()) files[relative(root, absolute).split('\\').join('/')] = digest(await readFile(absolute));
    }
  }
  await walk(root);
  return files;
}

/** The files the manifest of the hooks names, as paths inside the plugin. */
function referencedScripts(hooksManifest) {
  const references = new Set();
  for (const entries of Object.values(hooksManifest.hooks ?? {})) {
    for (const entry of entries ?? []) {
      for (const hook of entry?.hooks ?? []) {
        const command = String(hook?.command ?? "");
        for (const match of command.matchAll(/\$\{(?:PLUGIN_ROOT|CLAUDE_PLUGIN_ROOT)\}\/([^"'\s]+)/g)) {
          references.add(match[1]);
        }
      }
    }
  }
  return [...references];
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const repo = options.repo;

  // The runtime of the panel has to be built: the payload carries it.
  for (const entry of DIST_ENTRIES) {
    if (!await exists(join(options.dist, entry))) throw new Error(`the runtime is not built: ${join(options.dist, entry)}`);
  }

  const staging = `${options.out}.staging-${randomUUID()}`;
  await rm(options.out, { recursive: true, force: true });
  await mkdir(staging, { recursive: true, mode: 0o700 });
  try {
    // The manifests of the plugin: the portable one, the native one, the
    // marketplace and the route of the MCP server.
    for (const manifest of MANIFESTS) {
      const source = join(repo, manifest);
      if (!await exists(source)) throw new Error(`the plugin package is incomplete: ${manifest}`);
      await mkdir(dirname(join(staging, manifest)), { recursive: true });
      await cp(source, join(staging, manifest));
    }

    // Every path the native package of the plugin names, from the reviewed
    // package root of the repository.
    for (const path of PAYLOAD) {
      if (path === 'dist') continue;
      const source = join(repo, path);
      if (!await exists(source)) throw new Error(`the plugin package is incomplete: ${path}`);
      await mkdir(dirname(join(staging, path)), { recursive: true });
      if (await isDirectory(source)) await copyTree(source, join(staging, path));
      else await cp(source, join(staging, path));
    }

    // The scripts of the hooks, with every helper they import by a relative
    // path: a hook whose import does not resolve does not start at all.
    const scripts = await resolveScriptClosure(repo);
    for (const script of scripts) {
      await mkdir(dirname(join(staging, script)), { recursive: true });
      await cp(join(repo, script), join(staging, script));
    }

    // The runtime the plugin loads: the modules the entries of the plugin
    // import, and not the whole build of the panel. The plugin asks the panel
    // over HTTP, so the rest of the runtime would only make the payload heavy.
    const modules = await resolveModuleClosure(options.dist, DIST_ENTRIES);
    for (const module of modules) {
      const source = join(options.dist, module);
      await mkdir(dirname(join(staging, 'dist', module)), { recursive: true });
      await cp(source, join(staging, 'dist', module));
    }

    // The production dependencies of that runtime, byte for byte.
    const dependencies = await resolveDependencyClosure(options.nodeModules, options.dist, DIST_ENTRIES);
    for (const dependency of dependencies) {
      const source = join(options.nodeModules, dependency);
      await mkdir(join(staging, 'node_modules'), { recursive: true });
      await copyTree(source, join(staging, 'node_modules', dependency));
    }

    // The contract of the digest is checked on the bytes of the payload.
    const hook = await readFile(join(staging, 'scripts', 'codex-stop-hook.mjs'), 'utf8');
    const contract = { panelRoute: hook.includes(DIGEST_ROUTE), localFallback: hook.includes(LOCAL_FALLBACK) };
    if (!contract.panelRoute || !contract.localFallback) {
      throw new Error(`the Stop hook does not carry the contract of the digest: ${JSON.stringify(contract)}`);
    }

    // Every file the manifest of the hooks names has to be there.
    const hooksManifest = JSON.parse(await readFile(join(staging, 'com.openai', 'hooks', 'hooks.json'), 'utf8'));
    const missing = [];
    for (const reference of referencedScripts(hooksManifest)) {
      if (!await exists(join(staging, reference))) missing.push(reference);
    }
    if (missing.length > 0) throw new Error(`the payload is incomplete: ${missing.join(', ')}`);

    const files = await inventory(staging);
    const pkg = JSON.parse(await readFile(join(staging, 'package.json'), 'utf8'));
    const receipt = {
      schemaVersion: 1,
      name: pkg.name,
      version: pkg.version,
      files: Object.keys(files).length,
      bytes: Object.values(files).reduce((total, hash) => total, 0),
      dependencies,
      digestContract: contract,
      sourceFiles: files,
    };
    const payloadBytes = (await Promise.all(Object.entries(files).map(async ([path]) => (await lstat(join(staging, path))).size)))
      .reduce((total, size) => total + size, 0);
    receipt.bytes = payloadBytes;
    await writeFile(join(staging, 'payload-receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');

    await rename(staging, options.out);
    process.stdout.write(`${JSON.stringify({
      output: options.out,
      files: receipt.files,
      bytes: receipt.bytes,
      dependencies,
      digestContract: contract,
    })}\n`);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
