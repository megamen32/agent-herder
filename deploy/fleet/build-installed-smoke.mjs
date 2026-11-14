#!/usr/bin/env node
// Build the existing native gate's installed collector. This invokes no runtime.
import {rolldown} from 'rolldown';
import {mkdir, readFile, writeFile, chmod} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {isAbsolute, resolve} from 'node:path';
import {execFileSync} from 'node:child_process';

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--out' || !isAbsolute(args[1]))
  throw Error('An explicit absolute --out directory is required');
const root = fileURLToPath(new URL('../../', import.meta.url));
const output = args[1];
await mkdir(output, {mode: 0o700});
const files = {};
for (const [name, input] of [['collector.cjs', 'tests/native/installed-browser-entry.ts'],
                             ['bindings.cjs', 'tests/native/installed-browser-bindings.ts'],
                             ['ci-browser-fixture.mjs', 'deploy/fleet/ci-browser-fixture.mjs']]) {
  const bundle = await rolldown({input: resolve(root, input), platform: 'node',
    onLog(level, log, handler) {
      if (log.code === 'UNRESOLVED_IMPORT') throw Error(log.message);
      handler(level, log);
    }});
  const path = resolve(output, name);
  try {await bundle.write({file: path, format: name.endsWith('.mjs') ? 'esm' : 'cjs', inlineDynamicImports: true, sourcemap: false});}
  finally {await bundle.close();}
  await chmod(path, 0o644);
  execFileSync(process.execPath, ['--check', path], {stdio: 'pipe'});
  files[name] = createHash('sha256').update(await readFile(path)).digest('hex');
}
const launcher = 'ci-browser-launcher.py';
await writeFile(resolve(output, launcher), await readFile(resolve(root, 'deploy/fleet', launcher)), {mode: 0o755});
files[launcher] = createHash('sha256').update(await readFile(resolve(output, launcher))).digest('hex');
const receipt = {version: 1, files, runtime_invoked: false};
await writeFile(resolve(output, 'build.json'), JSON.stringify(receipt, null, 2) + '\n', {mode: 0o600});
process.stdout.write(JSON.stringify(receipt) + '\n');
