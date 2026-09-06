import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ChatGptAccountArchive,
  ChatGptAccountArchiveError,
  type ChatGptAccountExportDriver,
} from "../src/chatgpt-account-archive.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "chatgpt-account-archive-"));
  roots.push(value);
  return value;
}

async function fixtureZip(directory: string, name = "export.zip"): Promise<string> {
  const source = join(directory, "fixture");
  const nested = join(source, "assets");
  await (await import("node:fs/promises")).mkdir(nested, { recursive: true });
  await writeFile(join(source, "conversations.json"), "[]\n");
  await writeFile(join(source, "deep_research_report.md"), "# research\n");
  await writeFile(join(nested, "article.pdf"), "fake pdf\n");
  const archive = join(directory, name);
  await execFileAsync("zip", ["-q", "-r", archive, "."], { cwd: source });
  return archive;
}

function driver(): ChatGptAccountExportDriver & { calls: number } {
  return {
    calls: 0,
    async requestAccountExport() {
      this.calls += 1;
      return { requestedAt: "2026-08-12T12:00:00.000Z", delivery: "email_or_sms" as const, status: "requested" as const };
    },
  };
}

describe("ChatGptAccountArchive", () => {
  it("requires an exact confirmation before requesting the asynchronous account export", async () => {
    const accountDriver = driver();
    const archive = new ChatGptAccountArchive(accountDriver, { archiveRoot: await root() });

    await expect(archive.requestAccountExport({ confirmation: "" })).rejects.toMatchObject<Partial<ChatGptAccountArchiveError>>({ code: "confirmation_required" });
    await expect(archive.requestAccountExport({ confirmation: "REQUEST_ACCOUNT_EXPORT" })).resolves.toEqual({
      requestedAt: "2026-08-12T12:00:00.000Z",
      delivery: "email_or_sms",
      status: "requested",
      nextStep: "download_zip_then_import_account_export",
    });
    expect(accountDriver.calls).toBe(1);
  });

  it("copies the native ZIP unchanged and creates a manifest which classifies conversations, research, and files", async () => {
    const workspace = await root();
    const source = await fixtureZip(workspace);
    const archiveRoot = join(workspace, "archive");
    const archive = new ChatGptAccountArchive(undefined, {
      archiveRoot,
      now: () => new Date("2026-08-12T12:34:56.000Z"),
    });

    const imported = await archive.importAccountExport({ sourcePath: source });
    expect(imported.archivePath.startsWith(archiveRoot)).toBe(true);
    expect(imported.manifestPath.startsWith(archiveRoot)).toBe(true);
    expect(imported.entries).toMatchObject({ total: 4, conversationSources: 1, researchCandidates: 1, fileCandidates: 1, other: 1 });
    expect(await readFile(imported.archivePath)).toEqual(await readFile(source));
    const manifest = JSON.parse(await readFile(imported.manifestPath, "utf8"));
    expect(manifest).toMatchObject({ format: "agent-herder-chatgpt-account-export.v1", sourceName: "export.zip", entries: imported.entries });
    expect(manifest.entryNames).toEqual(expect.arrayContaining(["conversations.json", "deep_research_report.md", "assets/article.pdf"]));

    await expect(archive.listAccountExports()).resolves.toEqual([expect.objectContaining({ archiveId: imported.archiveId, entries: imported.entries })]);
  });

  it("kills the in-flight ZIP inspector when an import job is cancelled", async () => {
    if (process.platform !== "linux") return;
    const workspace = await root();
    const source = await fixtureZip(workspace, "cancel.zip");
    const marker = join(workspace, "zip-inspector.pid");
    const inspector = join(workspace, "slow-unzip");
    await writeFile(inspector, `#!/bin/sh\nprintf '%s' "$$" > ${JSON.stringify(marker)}\nexec /bin/sleep 30\n`);
    await chmod(inspector, 0o755);
    const archiveRoot = join(workspace, "cancelled-archive");
    const archive = new ChatGptAccountArchive(undefined, { archiveRoot, unzipBin: inspector });
    const controller = new AbortController();
    const pending = archive.importAccountExport({ sourcePath: source }, controller.signal);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try { await stat(marker); break; } catch { await new Promise((resolve) => setTimeout(resolve, 10)); }
    }
    const pid = Number.parseInt(await readFile(marker, "utf8"), 10);
    expect(pid).toBeGreaterThan(1);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try { await stat(`/proc/${pid}`); await new Promise((resolve) => setTimeout(resolve, 10)); }
      catch { break; }
    }
    await expect(stat(`/proc/${pid}`)).rejects.toBeDefined();
    await expect(readdir(join(archiveRoot, "raw"))).resolves.toEqual([]);
  });

  it("rejects non-ZIP sources and ZIPs whose listing contains unsafe paths", async () => {
    const workspace = await root();
    const archive = new ChatGptAccountArchive(undefined, { archiveRoot: join(workspace, "archive") });
    const text = join(workspace, "not-a-zip.txt");
    await writeFile(text, "not a ZIP");
    await expect(archive.importAccountExport({ sourcePath: text })).rejects.toMatchObject<Partial<ChatGptAccountArchiveError>>({ code: "invalid_source_path" });

    const source = await fixtureZip(workspace, "unsafe.zip");
    const unsafeListingArchive = new ChatGptAccountArchive(undefined, {
      archiveRoot: join(workspace, "unsafe-archive"),
      unzipBin: process.execPath,
    });
    await expect(unsafeListingArchive.importAccountExport({ sourcePath: source })).rejects.toMatchObject<Partial<ChatGptAccountArchiveError>>({ code: "invalid_export_zip" });
    const rawDirectory = join(workspace, "unsafe-archive", "raw");
    await expect(readdir(rawDirectory)).resolves.toEqual([]);
  });
});
