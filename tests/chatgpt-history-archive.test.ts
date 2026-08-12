import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ChatGptHistoryArchive,
  type ChatGptHistoryArchiveDriver,
  type ChatGptHistorySegment,
} from "../src/chatgpt-history-archive.js";

function segment(label: string): ChatGptHistorySegment {
  return {
    capturedAt: "2026-08-12T12:00:00.000Z",
    page: { url: "https://chatgpt.com/c/archive-canary" },
    content: { label, messages: [`private ${label} text`] },
  };
}

class FakeHistoryDriver implements ChatGptHistoryArchiveDriver {
  private scrolls = 0;
  openCalls = 0;

  async listChats() {
    return [
      { id: "article", title: "Article archive canary", unread: false, working: false, updatedAt: "2026-08-12T12:00:00.000Z" },
      { id: "e-frontier", title: "E-Frontier", unread: false, working: false, updatedAt: "2026-08-12T12:00:00.000Z" },
    ];
  }

  async openChat(input: { chatId: string }): Promise<ChatGptHistorySegment> {
    expect(input.chatId).toBe("article");
    this.openCalls += 1;
    this.scrolls = 0;
    return segment("bottom");
  }

  async scrollBack() {
    this.scrolls += 1;
    if (this.scrolls === 1) return { segment: segment("middle"), atStart: false };
    return { segment: segment("top"), atStart: true };
  }
}

describe("ChatGptHistoryArchive", () => {
  it("writes private raw history segments, checkpoints, and resumes without returning chat text", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-history-archive-"));
    try {
      const driver = new FakeHistoryDriver();
      const archive = new ChatGptHistoryArchive(driver, { archiveRoot: root });
      const listed = await archive.listChats({ view: "recent" });
      const chatRef = listed.chats.find((entry) => entry.title === "Article archive canary")?.chatRef;
      expect(chatRef).toBeDefined();

      const first = await archive.exportChat({ chatRef: chatRef!, maxSegments: 2 });
      expect(first).toMatchObject({ status: "checkpoint", capturedSegments: 2, newSegments: 2 });
      expect(JSON.stringify(first)).not.toContain("private bottom text");
      expect((await stat(first.manifestPath)).mode & 0o777).toBe(0o600);

      const second = await archive.exportChat({ chatRef: chatRef!, maxSegments: 3 });
      expect(second).toMatchObject({ status: "complete", capturedSegments: 3, newSegments: 1 });
      expect(driver.openCalls).toBe(1);

      const manifest = JSON.parse(await readFile(second.manifestPath, "utf8")) as { complete: boolean; segments: Array<{ file: string }> };
      expect(manifest.complete).toBe(true);
      expect(manifest.segments).toHaveLength(3);
      const segmentFiles = await readdir(join(second.archivePath, "segments"));
      expect(segmentFiles).toHaveLength(3);
      await expect(readFile(join(second.archivePath, "segments", manifest.segments[2]!.file), "utf8")).resolves.toContain("private top text");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps E-Frontier visible but never exports it as the canary", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-history-protected-"));
    try {
      const archive = new ChatGptHistoryArchive(new FakeHistoryDriver(), { archiveRoot: root });
      const listed = await archive.listChats({ view: "recent" });
      const protectedRef = listed.chats.find((entry) => entry.title === "E-Frontier")?.chatRef;
      await expect(archive.exportChat({ chatRef: protectedRef!, maxSegments: 1 })).rejects.toMatchObject({ code: "protected_chat" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not exceed the requested segment budget", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-history-budget-"));
    try {
      const archive = new ChatGptHistoryArchive(new FakeHistoryDriver(), { archiveRoot: root });
      const listed = await archive.listChats({ view: "recent" });
      const chatRef = listed.chats.find((entry) => entry.title === "Article archive canary")?.chatRef;

      await expect(archive.exportChat({ chatRef: chatRef!, maxSegments: 1 })).resolves.toMatchObject({
        status: "checkpoint",
        capturedSegments: 1,
        newSegments: 1,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
