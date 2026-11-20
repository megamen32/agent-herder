import { openSync, readFileSync, fstatSync } from "node:fs";
import { hostname } from "node:os";
import { WASI } from "node:wasi";

const [path, sessionId, ...page] = process.argv.slice(2);
const fd = openSync(path, "r");
const stat = fstatSync(fd, {bigint: true});
const scope = JSON.stringify([hostname(), sessionId, String(stat.dev), String(stat.ino)]);
const wasi = new WASI({version: "preview1", stdin: fd, args: ["codex-rollout-page", sessionId, scope, ...page]});
const module = await WebAssembly.compile(readFileSync(new URL("./codex-rollout-page.wasm", import.meta.url)));
process.exitCode = wasi.start(await WebAssembly.instantiate(module, wasi.getImportObject()));
