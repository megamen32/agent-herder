import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MinimaxCodeAdapter } from "../src/adapters/minimax-code.js";

const created: string[] = [];

async function store(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "minimax-code-adapter-"));
  created.push(root);
  return root;
}

function encodeSessionId(id: string): string {
  return Buffer.from(id, "utf8").toString("base64url");
}

async function writeSession(
  root: string,
  id: string,
  options: {
    day?: string;
    updatedAtMs?: number;
    createdAtMs?: number;
    model?: string;
    provider?: string;
    messages?: unknown[];
    manifest?: Record<string, unknown> | null;
  } = {},
): Promise<string> {
  const day = options.day ?? "2026/10/19";
  const dir = join(root, day, `20-31-52-444-session_${encodeSessionId(id)}`);
  await mkdir(dir, { recursive: true });
  if (options.manifest !== null) {
    await writeFile(
      join(dir, "manifest.json"),
      JSON.stringify(
        options.manifest ?? {
          schemaVersion: 1,
          sessionId: id,
          createdAtMs: options.createdAtMs ?? 1_700_000_000_000,
          updatedAtMs: options.updatedAtMs ?? 1_700_000_100_000,
          source: "local-runtime",
          layout: "v2-final-dated-session",
        },
      ),
    );
  }
  if (options.model) {
    await writeFile(
      join(dir, "llm-call.json"),
      JSON.stringify({ model: options.model, provider: options.provider ?? "minimax" }),
    );
  }
  const messages = options.messages ?? [
    { message_id: "m1", turn_id: "t1", message: { role: "user", content: "первый вопрос" } },
  ];
  await writeFile(
    join(dir, "messages.jsonl"),
    `${messages.map((message) => JSON.stringify(message)).join("\n")}\n`,
  );
  return dir;
}

afterEach(async () => {
  while (created.length > 0) {
    const dir = created.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

describe("MinimaxCodeAdapter", () => {
  it("lists stored sessions newest first with title, model and last message", async () => {
    const root = await store();
    await writeSession(root, "mvs_0000000000000000000000000000aaaa", {
      updatedAtMs: 1_700_000_100_000,
      model: "MiniMax-M3.1-Flash",
      messages: [
        {
          message_id: "m1",
          turn_id: "t1",
          message: {
            role: "user",
            content: [
              { type: "text", text: "<system-reminder>\nnoise\n</system-reminder>\nчистый вопрос" },
            ],
          },
        },
        { message_id: "m2", turn_id: "t1", message: { role: "assistant", content: "ответ" } },
      ],
    });
    await writeSession(root, "mvs_0000000000000000000000000000bbbb", {
      updatedAtMs: 1_700_000_900_000,
      messages: [{ message_id: "m1", turn_id: "t1", message: { role: "user", content: "свежая" } }],
    });

    const adapter = new MinimaxCodeAdapter({ sessionStore: root });
    const sessions = await adapter.listSessions();

    expect(sessions).toHaveLength(2);
    expect(sessions[0]?.id).toBe("mvs_0000000000000000000000000000bbbb");
    expect(sessions[0]?.harness).toBe("minimax-code");
    expect(sessions[0]?.title).toBe("свежая");
    expect(sessions[0]?.model).toBeUndefined();
    expect(sessions[1]?.title).toBe("чистый вопрос");
    expect(sessions[1]?.model).toBe("minimax/MiniMax-M3.1-Flash");
    expect(sessions[1]?.lastMessage).toBe("ответ");
    expect(sessions[1]?.status).toBe("idle");
    expect(sessions[1]?.needsPermission).toBe(false);
    expect(sessions[1]?.meta?.readOnly).toBe(true);
  });

  it("resolves a session by id and falls back to the encoded directory name", async () => {
    const root = await store();
    await writeSession(root, "mvs_0000000000000000000000000000cccc", { manifest: null });

    const adapter = new MinimaxCodeAdapter({ sessionStore: root });
    const session = await adapter.getSession("mvs_0000000000000000000000000000cccc");

    expect(session?.id).toBe("mvs_0000000000000000000000000000cccc");
    expect(session?.title).toBe("первый вопрос");
  });

  it("skips unreadable session directories instead of failing the pass", async () => {
    const root = await store();
    await writeSession(root, "mvs_0000000000000000000000000000dddd");
    await mkdir(join(root, "2026/10/19/20-31-52-444-session_broken"), { recursive: true });

    const adapter = new MinimaxCodeAdapter({ sessionStore: root });
    const sessions = await adapter.listSessions();

    expect(sessions.map((session) => session.id)).toEqual(["mvs_0000000000000000000000000000dddd"]);
  });

  it("reads a transcript from the message log", async () => {
    const root = await store();
    await writeSession(root, "mvs_0000000000000000000000000000eeee", {
      messages: [
        { message_id: "m1", turn_id: "t1", message: { role: "user", content: "вопрос" } },
        { message_id: "m2", turn_id: "t1", message: { role: "assistant", content: [{ type: "text", text: "ответ" }] } },
      ],
    });

    const adapter = new MinimaxCodeAdapter({ sessionStore: root });
    const transcript = await adapter.getTranscript("mvs_0000000000000000000000000000eeee");

    expect(transcript).toContain("## user\nвопрос");
    expect(transcript).toContain("## assistant\nответ");
  });

  it("exposes session messages for the supervisor", async () => {
    const root = await store();
    await writeSession(root, "mvs_0000000000000000000000000000aabb", {
      messages: [
        { message_id: "m1", turn_id: "t1", message: { role: "user", content: "вопрос" } },
        {
          message_id: "m2",
          turn_id: "t1",
          message: { role: "assistant", content: [{ type: "text", text: "ответ" }], model: "MiniMax-M3.1-Flash" },
        },
      ],
    });

    const adapter = new MinimaxCodeAdapter({ sessionStore: root });
    const messages = await adapter.getSessionMessages("mvs_0000000000000000000000000000aabb");

    expect(messages).toHaveLength(2);
    expect(messages?.[0]?.role).toBe("user");
    expect(messages?.[0]?.text).toBe("вопрос");
    expect(messages?.[1]?.role).toBe("assistant");
    expect(messages?.[1]?.model).toBe("MiniMax-M3.1-Flash");
    expect(messages?.[1]?.turnId).toBe("t1");
    expect(messages?.[1]?.parts[0]?.text).toBe("ответ");
  });

  it("refuses delivery because desktop sessions are runtime owned", async () => {
    const root = await store();
    await writeSession(root, "mvs_0000000000000000000000000000ffff");
    const adapter = new MinimaxCodeAdapter({ sessionStore: root });

    const result = await adapter.sendMessage("mvs_0000000000000000000000000000ffff", { message: "привет" });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("local runtime");
    expect(adapter.controlCapabilities.steer).toBe(false);
    expect(adapter.controlCapabilities.cancelTurn).toBe(false);
  });

  it("reports a missing store on init", async () => {
    const adapter = new MinimaxCodeAdapter({ sessionStore: join(tmpdir(), "minimax-code-missing-store") });
    await expect(adapter.init()).rejects.toThrow(/session store not found/);
  });

  it("initialises on an empty store directory", async () => {
    const root = await store();
    await mkdir(join(root, "2026/10/19"), { recursive: true });
    const adapter = new MinimaxCodeAdapter({ sessionStore: root });

    await expect(adapter.init()).resolves.toBeUndefined();
    expect(await adapter.listSessions()).toEqual([]);
  });

  it("serves a repeated enumeration from the content cache", async () => {
    const root = await store();
    const dir = await writeSession(root, "mvs_0000000000000000000000000000cafe", {
      messages: [{ message_id: "m1", turn_id: "t1", message: { role: "user", content: "вопрос" } }],
    });

    const adapter = new MinimaxCodeAdapter({ sessionStore: root });
    expect((await adapter.listSessions())[0]?.title).toBe("вопрос");

    // The transcript becomes unreadable while its stamp stays the same, so a
    // pass that still resolves the title proves the content cache answered.
    await chmod(join(dir, "messages.jsonl"), 0o000);
    expect((await adapter.listSessions())[0]?.title).toBe("вопрос");
  });

  it("re-reads a session when its message log changed", async () => {
    const root = await store();
    const dir = await writeSession(root, "mvs_0000000000000000000000000000beef", {
      messages: [{ message_id: "m1", turn_id: "t1", message: { role: "user", content: "вопрос" } }],
    });

    const adapter = new MinimaxCodeAdapter({ sessionStore: root });
    expect((await adapter.listSessions())[0]?.lastMessage).toBe("вопрос");

    await writeFile(
      join(dir, "messages.jsonl"),
      `${JSON.stringify({ message_id: "m1", turn_id: "t1", message: { role: "user", content: "вопрос" } })}\n${JSON.stringify({ message_id: "m2", turn_id: "t1", message: { role: "assistant", content: "ответ" } })}\n`,
    );

    expect((await adapter.listSessions())[0]?.lastMessage).toBe("ответ");
  });
});
