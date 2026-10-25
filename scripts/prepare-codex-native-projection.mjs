#!/usr/bin/env node
// Release packaging only. No install, cache edit, runtime reload or native RPC.
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const MAX_BYTES = 16 * 1024 * 1024;
const MAX_FILES = 4096;
// The files and directories the native package of the plugin carries. The
// payload that travels with the release is built against this list, so a
// reviewed package root and a release payload cannot drift apart.
export const PAYLOAD = ['dist', '.mcp.json', 'com.openai/hooks/hooks.json', 'scripts/codex-stop-hook.mjs',
  'scripts/autopilot-hook-launcher.sh', 'scripts/autopilot-command-launcher.sh', 'scripts/coordination-hook.mjs', 'skills/autopilot', 'skills/chat-triage'];
const ENTRIES = ['dist/autopilot-hook.js', 'dist/autopilot-runner.js', 'dist/human-stop-store.js'];
// The scripts the hooks of the plugin run. They import their own helpers by a
// relative path, so the package of the node has to carry those helpers too: a
// hook whose import does not resolve does not start at all.
const SCRIPT_ENTRIES = ['scripts/codex-stop-hook.mjs', 'scripts/coordination-hook.mjs'];
// The contract of the digest of the Stop hook of Codex: the panel is asked
// first, the local store of the plugin is the fallback.
const DIGEST_ROUTE = '/api/human-stop/generated-prompt';
const LOCAL_FALLBACK = 'dist/human-stop-store.js';
function inside(root, path) {
  const rel = relative(root, path);
  return rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel);
}
function digest(value) { return createHash('sha256').update(value).digest('hex'); }
async function regular(path) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`not a regular release file: ${path}`);
  return readFile(path);
}

/** The import specifiers of a module: static imports, re-exports and literal dynamic imports. */
function importSpecifiers(text, path) {
  const ast = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if (ast.parseDiagnostics.length) throw new Error(`invalid compiled hook module: ${path}`);
  const imports = [];
  const visit = node => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) imports.push(node.moduleSpecifier.text);
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments.length === 1 && ts.isStringLiteralLike(node.arguments[0])) imports.push(node.arguments[0].text);
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return imports;
}

/**
 * The scripts the hooks run, with every helper they import by a relative path.
 *
 * The hook of Codex imports `./hooks-prohibitions.mjs`: the package of the
 * node without that file ships a hook that cannot even be loaded, so the
 * import closure travels with the payload instead of a hand kept list.
 */
export async function resolveScriptClosure(packageRoot, entries = SCRIPT_ENTRIES) {
  packageRoot = resolve(packageRoot);
  const found = new Set(), pending = [...entries];
  while (pending.length) {
    const path = pending.pop();
    if (found.has(path)) continue;
    found.add(path);
    const text = (await regular(join(packageRoot, path))).toString();
    for (const specifier of importSpecifiers(text, path)) {
      if (!specifier.startsWith('.')) continue;
      const child = relative(packageRoot, resolve(packageRoot, dirname(path), specifier));
      if (!inside(packageRoot, resolve(packageRoot, child)) || !child.startsWith('scripts/')) {
        throw new Error(`hook script import escapes release payload: ${path} -> ${specifier}`);
      }
      pending.push(child);
    }
  }
  return [...found].sort();
}

/** The modules the given entries load: their own relative imports, and the packages they name. */
async function importGraph(entriesRoot, entries) {
  entriesRoot = resolve(entriesRoot);
  const modules = new Set(), names = new Set(), pending = [...entries], seen = new Set();
  while (pending.length) {
    const path = pending.pop(); if (seen.has(path)) continue; seen.add(path);
    modules.add(path);
    const text = (await regular(join(entriesRoot, path))).toString();
    for (const specifier of importSpecifiers(text, path)) {
      if (specifier.startsWith('node:')) continue;
      if (specifier.startsWith('.')) {
        // A relative import is a module of the same tree: its own imports can
        // name a package too.
        const child = relative(entriesRoot, resolve(entriesRoot, dirname(path), specifier));
        if (!inside(entriesRoot, resolve(entriesRoot, child))) throw new Error('hook import escapes release payload');
        pending.push(child);
        continue;
      }
      const name = specifier.startsWith('@') ? specifier.split('/').slice(0,2).join('/') : specifier.split('/')[0];
      names.add(name);
    }
  }
  return { modules: [...modules].sort(), names: [...names].sort() };
}

/**
 * The modules the plugin of Codex loads at runtime.
 *
 * The plugin does not run the runtime of the panel: it asks the panel over
 * HTTP. It loads the runtime of its own hooks only, so the payload carries
 * that closure and not the whole build of the panel.
 */
export async function resolveModuleClosure(entriesRoot, entries) {
  return (await importGraph(entriesRoot, entries)).modules;
}

/**
 * The production dependencies of the given entries, with their own dependencies.
 *
 * The modules are read from `entriesRoot`, the packages from `nodeModules`: the
 * reviewed package and the checkout of the build host are not always the same
 * directory.
 */
export async function resolveDependencyClosure(nodeModules, entriesRoot, entries) {
  nodeModules = resolve(nodeModules);
  const { names } = await importGraph(entriesRoot, entries);
  const installed = new Set(), queue = [...names].sort();
  while (queue.length) {
    const name = queue.pop(); if (installed.has(name)) continue;
    if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(name)) throw new Error('invalid production dependency');
    const dependency = JSON.parse(await regular(join(nodeModules, name, 'package.json')));
    if (dependency.name !== name || typeof dependency.version !== 'string') throw new Error('dependency identity mismatch');
    installed.add(name);
    for (const child of Object.keys(dependency.dependencies ?? {})) queue.push(child);
  }
  return [...installed].sort();
}

/** Build a self-contained Codex projection from an explicitly reviewed built
 * package. The source portable manifest and every other harness remain intact. */
export async function prepareCodexNativeProjection(packageRoot, outputRoot, nativeVersion) {
  packageRoot = resolve(packageRoot); outputRoot = resolve(outputRoot);
  if (inside(packageRoot, outputRoot) || inside(outputRoot, packageRoot)) throw new Error('projection must be separate from the input package');
  try { await lstat(outputRoot); throw new Error('projection output already exists'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const pkg = JSON.parse(await regular(join(packageRoot, 'package.json')));
  const portableBytes = await regular(join(packageRoot, 'plugin.json'));
  const portable = JSON.parse(portableBytes);
  const legacy = JSON.parse(await regular(join(packageRoot, '.codex-plugin/plugin.json')));
  if (pkg.name !== 'agent-herder' || portable.name !== pkg.name || legacy.name !== pkg.name
    || portable.$schema !== 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json'
    || typeof pkg.version !== 'string' || legacy.hooks !== './com.openai/hooks/hooks.json') throw new Error('unexpected Herder plugin package');
  const stableVersion = /^([0-9]+)\.([0-9]+)\.([0-9]+)$/;
  const original = stableVersion.exec(pkg.version), projected = stableVersion.exec(nativeVersion ?? '');
  if (!original || !projected) throw new Error('explicit stable native release version required');
  const oldParts = original.slice(1).map(Number), newParts = projected.slice(1).map(Number);
  const different = newParts.findIndex((part,index) => part !== oldParts[index]);
  if (different < 0 || newParts[different] <= oldParts[different]) throw new Error('native version must exceed the preserved portable release');
  const marketplace = JSON.parse(await regular(join(packageRoot, '.agents/plugins/marketplace.json')));
  if (marketplace.name !== 'agent-herder-local' || marketplace.plugins?.length !== 1
    || marketplace.plugins[0].name !== pkg.name || marketplace.plugins[0].source?.source !== 'local'
    || marketplace.plugins[0].source?.path !== '.') throw new Error('unexpected native marketplace route');
  const mcp = JSON.parse(await regular(join(packageRoot, '.mcp.json')));
  const server = mcp.mcpServers?.['agent-herder'];
  if (server?.type !== 'http' || server.url !== 'http://127.0.0.1:18787/mcp'
    || ['command','args','env','cwd'].some(key => key in server)) throw new Error('MCP must retain the existing singleton HTTP route');

  const files = new Map(); let bytes = 0;
  async function include(path, output = path) {
    if (!inside(packageRoot, resolve(packageRoot, path)) || path.includes('..')) throw new Error('release path escapes package');
    const absolute = join(packageRoot, path), stat = await lstat(absolute);
    if (stat.isSymbolicLink()) throw new Error(`symlink in release input: ${path}`);
    if (stat.isDirectory()) {
      for (const name of (await readdir(absolute)).sort()) await include(join(path, name), join(output, name));
    } else if (stat.isFile()) {
      if (files.has(output)) return;
      const content = await regular(absolute); bytes += content.length;
      if (bytes > MAX_BYTES || files.size >= MAX_FILES) throw new Error('native projection exceeds release budget');
      files.set(output, {content, mode:stat.mode & 0o777, hash:digest(content)});
    } else throw new Error(`unsupported release input: ${path}`);
  }
  for (const path of PAYLOAD) await include(path);
  // The helpers the hook scripts import by a relative path travel with them.
  for (const path of await resolveScriptClosure(packageRoot)) await include(path);

  // Resolve only the hook entrypoints' literal import graph, then include
  // installed production dependency closures byte-for-byte. No npm/provider
  // network work and no dependency installation occurs here.
  const pending = [...ENTRIES], seen = new Set();
  while (pending.length) {
    const path = pending.pop(); if (seen.has(path)) continue; seen.add(path);
    const text = (await regular(join(packageRoot, path))).toString();
    for (const specifier of importSpecifiers(text, path)) {
      if (specifier.startsWith('node:')) continue;
      if (specifier.startsWith('.')) {
        const child = relative(packageRoot, resolve(packageRoot, dirname(path), specifier));
        if (!inside(packageRoot, resolve(packageRoot, child)) || !files.has(child)) throw new Error('hook import escapes release payload');
        pending.push(child);
      }
    }
  }
  const dependencies = await resolveDependencyClosure(join(packageRoot, 'node_modules'), packageRoot, ENTRIES);
  const installed = new Set();
  async function includeDependency(name) {
    if (installed.has(name)) return;
    if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(name)) throw new Error('invalid production dependency');
    const path = `node_modules/${name}`;
    const dependency = JSON.parse(await regular(join(packageRoot, path, 'package.json')));
    if (dependency.name !== name || typeof dependency.version !== 'string') throw new Error('dependency identity mismatch');
    installed.add(name); await include(path);
    for (const child of Object.keys(dependency.dependencies ?? {})) await includeDependency(child);
  }
  for (const name of [...dependencies].sort()) await includeDependency(name);
  const payloadHashes = Object.fromEntries([...files].sort(([a],[b])=>a.localeCompare(b)).map(([path,value])=>[path,value.hash]));
  const releaseHash = digest(JSON.stringify({payloadHashes, legacy, pkg, marketplace, portable:digest(portableBytes)}));
  // Native selection takes the greatest semver in the cache. A prerelease of
  // the old stable version would silently leave the old zero-hook package active.
  const version = nativeVersion;
  // The contract of the digest is measured on the bytes of the artifact, not on
  // the source of the checkout: the installed hook is what talks to the panel.
  const hook = files.get('scripts/codex-stop-hook.mjs')?.content?.toString() ?? '';
  const contract = {panelRoute: hook.includes(DIGEST_ROUTE), localFallback: hook.includes(LOCAL_FALLBACK)};
  const receipt = {schemaVersion:1, name:pkg.name, version, sourcePortableManifestSha256:digest(portableBytes),
    releaseHash, sourceFiles:payloadHashes, bundledDependencies:[...installed].sort(), nativeActions:0, digestContract:contract};
  const generated = {
    '.codex-plugin/plugin.json': {...legacy, version},
    'package.json': {...pkg, version, bundledDependencies:receipt.bundledDependencies, files:[...PAYLOAD,'.codex-plugin/plugin.json','.agents/plugins/marketplace.json','projection-receipt.json']},
    '.agents/plugins/marketplace.json': marketplace,
    'projection-receipt.json': receipt,
  };
  const staging = `${outputRoot}.staging-${randomUUID()}`;
  try {
    await mkdir(staging, {recursive:true, mode:0o700});
    for (const [path,{content,mode}] of files) {
      await mkdir(dirname(join(staging,path)),{recursive:true}); await writeFile(join(staging,path),content,{flag:'wx',mode});
    }
    for (const [path,value] of Object.entries(generated)) {
      await mkdir(dirname(join(staging,path)),{recursive:true}); await writeFile(join(staging,path),`${JSON.stringify(value,null,2)}\n`,{flag:'wx',mode:0o644});
    }
    await rename(staging, outputRoot);
    return {version, releaseHash, outputRoot, marketplacePath:join(outputRoot,'.agents/plugins/marketplace.json'),files:files.size,bytes, digestContract:contract};
  } catch (error) { await rm(staging,{recursive:true,force:true}); throw error; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 5) throw new Error('Usage: prepare-codex-native-projection.mjs REVIEWED_PACKAGE_ROOT NEW_OUTPUT_ROOT NEW_STABLE_NATIVE_VERSION');
  const result = await prepareCodexNativeProjection(process.argv[2],process.argv[3],process.argv[4]);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
