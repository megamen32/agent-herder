#!/usr/bin/env node
import {build} from "rolldown";
import {mkdir,readFile,writeFile} from "node:fs/promises";
import {dirname,resolve} from "node:path";
import {createHash} from "node:crypto";
import {execFileSync} from "node:child_process";
const output=resolve(process.argv[2]||".tmp/harness-mesh/native-peer.mjs");
await mkdir(dirname(output),{recursive:true});
await build({input:"src/mesh/native-peer.ts",external:id=>id.startsWith("node:"),platform:"node",output:{file:output,format:"esm"}});
const files=["src/mesh/build-peer.mjs","src/mesh/native-peer.ts","src/mesh/native-observer.ts","src/mesh/native-codex.ts","src/mesh/shared-delivery.ts","src/mesh/delivery-ledger.ts","src/mesh/protocol.ts","src/mesh/inventory.ts","src/human-stop-store.ts","package-lock.json"];
const sourceHashes={};for(const file of files)sourceHashes[file]=createHash("sha256").update(await readFile(file)).digest("hex");
const manifest={version:1,entry:"src/mesh/native-peer.ts",revision:execFileSync("git",["rev-parse","HEAD"],{encoding:"utf8"}).trim(),bundleSha256:createHash("sha256").update(await readFile(output)).digest("hex"),sourceHashes};
await writeFile(output+".manifest.json",JSON.stringify(manifest,null,2)+"\n");
console.log(JSON.stringify({bundle:output,bytes:(await readFile(output)).length,manifest:output+".manifest.json"}));
