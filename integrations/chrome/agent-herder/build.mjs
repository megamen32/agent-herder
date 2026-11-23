import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export async function build(output) {
  const adapter = new URL("../../../crates/herder/src/adapters/", import.meta.url);
  const source = [
    "chatgpt/account.js", "chatgpt/native.js", "chatgpt/read.js", "chatgpt/composer.js",
    "chatgpt/cancel.js", "chatgpt/download.js", "zai/list.js", "zai/page.js", "zai/files.js", "zai/stop.js",
  ];
  const shared = await Promise.all(source.map(name => readFile(new URL(name, adapter), "utf8")));
  const dispatch = await readFile(new URL("site-dispatch.js", import.meta.url), "utf8");
  const files = ["manifest.json", "background.js", "connection.js", "options.html", "options.js"];
  await mkdir(output, { mode: 0o700 });
  await Promise.all(files.map(name => copyFile(new URL(name, import.meta.url), join(output, name))));
  // Chrome serializes the injected function alone. Keep the shared provider
  // functions inside it so it is self-contained in the page's main world.
  const body = shared.map(source => source.trim()).join("\n\n");
  await writeFile(join(output, "site.js"),
    `export async function executeSite(provider, op, encoded) {
  const params = JSON.parse(encoded);

${body}

  async function dispatch() {
${dispatch.trimEnd().split("\n").map(line => "  " + line).join("\n")}
  }
  return JSON.stringify(await dispatch());
}
`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) {
    throw new Error("usage: node build.mjs /path/to/new-extension-directory");
  }
  await build(resolve(process.argv[2]));
}
