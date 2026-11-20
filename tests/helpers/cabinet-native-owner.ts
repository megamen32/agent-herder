import { spawn } from "node:child_process";
import { once } from "node:events";
import { copyFileSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { unwrapCanonicalResult } from "../../src/canonical-herder.js";

/** A fresh protected owner profile. Each call reopens the same Rust database and gate. */
export function cabinetNativeOwner(binary: string, harness: string, node: string) {
  const root = mkdtempSync(join(realpathSync(homedir()), ".herder-cabinet-test-"));
  const cleanup = () => rmSync(root, { recursive: true, force: true });
  try {
    const database = join(root, "state.db"), gate = join(root, "gate"), profile = join(root, "profile.json");
    for (const path of [database, gate]) writeFileSync(path, "", { mode: 0o600, flag: "wx" });
    const db = new DatabaseSync(database);
    try {
      let version = 1;
      db.function("herder_writer_version", { deterministic: true }, () => version);
      for (const name of ["schema", "migration_v1_v2", "migration_v2_v3", "migration_v3_v4"]) {
        db.exec("BEGIN EXCLUSIVE;\n" + readFileSync(new URL("../../crates/herder/src/store/" + name + ".sql", import.meta.url), "utf8") + "\nCOMMIT;");
        version = Number(db.prepare("PRAGMA user_version").get()!.user_version);
      }
      const g = statSync(gate, { bigint: true }), d = statSync(database, { bigint: true });
      db.prepare("INSERT INTO humanstop_authority(singleton,generation,gate_device,gate_inode,database_device,database_inode,created_at) VALUES(1,'fixture',?,?,?,?,'test')")
        .run(g.dev, g.ino, d.dev, d.ino);
    } finally { db.close(); }
    const script = join(root, "browser.mjs");
    copyFileSync(new URL("../fixtures/cabinet-browser-ahap.mjs", import.meta.url), script);
    writeFileSync(profile, JSON.stringify({ database, gate, generation: "fixture", owner: {
      kind: harness, principal: "fixture-owner", node, instance: harness, executable: realpathSync(process.execPath),
      ahap_script: script, code_home: root, cwd: root,
    } }), { mode: 0o600 });
    return { cleanup, trace: () => readFileSync(join(root, "native.jsonl"), "utf8").trimEnd().split("\n").map(row => JSON.parse(row)),
      async call(name: string, args: Record<string, unknown>) {
        const child = spawn(binary, ["--trusted-owner-profile", profile], { stdio: ["pipe", "pipe", "pipe"],
          env: { PATH: "/usr/bin:/bin", LANG: "C" }, timeout: 8000 });
        const exited = once(child, "close");
        let diagnostic = "";
        child.stderr.on("data", chunk => { diagnostic += chunk; });
        const output = createInterface({ input: child.stdout });
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args,
          _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {},
            "io.modelcontextprotocol/clientInfo": { name: "cabinet-fixture", version: "1" } } } }) + "\n");
        try {
          for await (const line of output) {
            const reply = JSON.parse(line);
            if (reply.id === 1) return unwrapCanonicalResult(reply.result);
          }
          throw new Error("Rust fixture exited before its response: " + diagnostic);
        } finally { output.close(); child.stdin.end(); await exited; }
      },
    };
  } catch (error) { cleanup(); throw error; }
}
