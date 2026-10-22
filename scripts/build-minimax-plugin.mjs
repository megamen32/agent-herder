#!/usr/bin/env node
/**
 * The build of the plugin of MiniMax Code.
 *
 * The installed plugin of the product lost its scripts/ when it was packed:
 * the hooks of the manifest pointed at `${PLUGIN_ROOT}/scripts/codex-stop-hook.mjs`
 * and at `${PLUGIN_ROOT}/scripts/coordination-hook.mjs`, and neither file was
 * in the package. A hook that cannot find its script does not work — and a
 * hook that does not work still gets in the way of the session.
 *
 * This script packs the plugin from the repository, always with the same
 * layout, and checks the package before it leaves: every file the manifest
 * names must exist inside the package, and the scripts of the hooks must be
 * there. A package that does not pass the check is not written as finished:
 * the script fails with the name of the missing file.
 *
 * Usage:
 *   node scripts/build-minimax-plugin.mjs [--out <dir>] [--version <x>] [--icons <dir>]
 */
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The scripts the hooks of the plugin run. */
const HOOK_SCRIPTS = [
  "scripts/codex-stop-hook.mjs",
  "scripts/coordination-hook.mjs",
  "scripts/hooks-prohibitions.mjs",
  "scripts/hooks-stop-gate.mjs",
];

/** The directories the package carries as they are. */
const PACKAGE_DIRECTORIES = ["skills"];

/** The colour of the placeholder icon of the package. */
const PLACEHOLDER_ICON = [32, 58, 92];
/** The colour of the placeholder icon of the dark theme. */
const PLACEHOLDER_DARK_ICON = [16, 26, 40];

function parseArguments(argv) {
  const options = {
    out: join(repoRoot, "dist", "plugin", "minimax", "agent-herder"),
    version: undefined,
    icons: join(repoRoot, "assets", "plugin"),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--out") { options.out = resolve(argv[++index] ?? options.out); continue; }
    if (argument === "--version") { options.version = argv[++index]; continue; }
    if (argument === "--icons") { options.icons = resolve(argv[++index] ?? options.icons); continue; }
    throw new Error(`unknown argument: ${argument}`);
  }
  return options;
}

/**
 * The version of the package.
 *
 * The version of the repository is the default; a build that must replace an
 * installed plugin names its own version, because an installed plugin is
 * never replaced by an older one.
 */
async function packageVersion(explicit) {
  if (explicit) return explicit;
  const manifest = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));
  return String(manifest.version ?? "0.0.0");
}

/** The minimal PNG writer of the placeholder icon. */
function solidPng(size, [red, green, blue]) {
  const stride = size * 3 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y += 1) {
    const rowStart = y * stride;
    raw[rowStart] = 0;
    for (let x = 0; x < size; x += 1) {
      const offset = rowStart + 1 + x * 3;
      raw[offset] = red;
      raw[offset + 1] = green;
      raw[offset + 2] = blue;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * The icon of the package.
 *
 * The real icon of the product is used when it is there; otherwise the build
 * writes a placeholder, so the package is never without an icon and the
 * build never depends on a file that is not in the repository.
 */
async function writeIcon(target, source, colour) {
  try {
    await cp(source, target);
    return "copied";
  } catch {
    await writeFile(target, solidPng(512, colour));
    return "placeholder";
  }
}

/** The files the manifest of the hooks names, as paths inside the package. */
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

/** The skills of the package, as the manifest names them. */
async function skillFiles() {
  const skills = [];
  const root = join(repoRoot, "skills");
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifest = join(root, entry.name, "SKILL.md");
    try {
      await stat(manifest);
      skills.push(`skills/${entry.name}/SKILL.md`);
    } catch {
      // A directory without a skill is not a skill of the package.
    }
  }
  return skills;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const version = await packageVersion(options.version);

  // The build is reproducible: the package is written from nothing.
  await rm(options.out, { recursive: true, force: true });
  await mkdir(join(options.out, "hooks"), { recursive: true });
  await mkdir(join(options.out, "scripts"), { recursive: true });
  await mkdir(join(options.out, ".minimax-plugin"), { recursive: true });

  // The manifest of the hooks of the plugin of Codex and MiniMax Code.
  await cp(join(repoRoot, "com.openai", "hooks", "hooks.json"), join(options.out, "hooks", "hooks.json"));

  // The scripts of the hooks: the part the installed plugin lost.
  for (const script of HOOK_SCRIPTS) {
    await cp(join(repoRoot, script), join(options.out, script));
  }

  // The skills of the product.
  for (const directory of PACKAGE_DIRECTORIES) {
    await cp(join(repoRoot, directory), join(options.out, directory), { recursive: true });
  }

  // The icons of the plugin.
  const icon = await writeIcon(join(options.out, "icon.png"), join(options.icons, "icon.png"), PLACEHOLDER_ICON);
  const darkIcon = await writeIcon(join(options.out, "icon-dark.png"), join(options.icons, "icon-dark.png"), PLACEHOLDER_DARK_ICON);

  const skills = await skillFiles();
  const manifest = {
    schemaVersion: 1,
    name: "agent-herder",
    displayName: "agent-herder",
    version,
    description: "agent-herder — координатор сессий, хуки и автопилот.",
    author: "Agent Herder contributors",
    icon: "icon.png",
    darkIcon: "icon-dark.png",
    category: "Code",
    exampleQueries: ["Используй agent-herder для работы с его навыками."],
    apps: [],
    mcpServers: [],
    skills,
    commands: [],
    hooks: ["hooks/hooks.json"],
  };
  await writeFile(join(options.out, ".minimax-plugin", "plugin.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  // The check of the package: the manifest must name files that are there.
  const hooksManifest = JSON.parse(await readFile(join(options.out, "hooks", "hooks.json"), "utf8"));
  const missing = [];
  for (const reference of referencedScripts(hooksManifest)) {
    try {
      await stat(join(options.out, reference));
    } catch {
      missing.push(reference);
    }
  }
  for (const script of HOOK_SCRIPTS.slice(0, 2)) {
    try {
      await stat(join(options.out, script));
    } catch {
      missing.push(script);
    }
  }
  for (const skill of skills) {
    try {
      await stat(join(options.out, skill));
    } catch {
      missing.push(skill);
    }
  }
  if (missing.length > 0) {
    console.error(`Пакет неполон: в пакете нет ${missing.join(", ")}`);
    process.exit(1);
  }

  console.log(`Пакет плагина MiniMax Code собран: ${options.out}`);
  console.log(`  версия: ${version}`);
  console.log(`  манифест: .minimax-plugin/plugin.json`);
  console.log(`  хуки: hooks/hooks.json (${referencedScripts(hooksManifest).length} файлов, все на месте)`);
  console.log(`  скрипты: ${HOOK_SCRIPTS.join(", ")}`);
  console.log(`  навыки: ${skills.join(", ")}`);
  console.log(`  иконки: icon.png (${icon}), icon-dark.png (${darkIcon})`);
}

await main();
