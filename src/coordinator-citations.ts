import { createHash, randomUUID } from "node:crypto";
import { coordinatorTransaction } from "./coordinator-state.js";
import { z } from "zod";
import { GoalStore } from "./autopilot/goal-store.js";
import { resolveAutopilotStateDir } from "./autopilot/state-dir.js";

export const citationSource = z
  .object({
    harness: z.string().min(1).max(64),
    sessionId: z.string().min(1).max(512),
    cwd: z.string().min(1).max(4096),
  })
  .strict();
export const citation = citationSource
  .extend({ eventId: z.string().min(1).max(512) })
  .strict();
export const humanCitations = z
  .array(citation)
  .min(1)
  .max(16)
  .optional()
  .describe(
    "References to accepted human inputs returned by human_messages. Herder reads original text and receipt time.",
  );

/** Called at the owner web composer boundary only. MCP cannot mint these events. */
export function recordComposerInput(
  source: z.infer<typeof citationSource>,
  text: string,
  inputId?: string,
) {
  const key = [
    source.harness,
    source.sessionId,
    source.cwd,
    "composer:" + (inputId ?? randomUUID()),
  ];
  coordinatorTransaction((db) => {
    db.prepare("INSERT OR IGNORE INTO human_inputs VALUES(?,?,?,?,?,?)").run(
      ...key,
      new Date().toISOString(),
      text,
    );
    const stored = db
      .prepare(
        "SELECT body FROM human_inputs WHERE harness=? AND session=? AND cwd=? AND event=?",
      )
      .get(...key);
    if (stored?.body !== text) throw new Error("Human input ID conflict");
  });
}

export async function readHumanMessages(
  source: z.infer<typeof citationSource>,
) {
  const store = new GoalStore(resolveAutopilotStateDir());
  const snapshot = await store.snapshot(source).catch((error) => {
    if (
      error instanceof Error &&
      error.message === "goal is not armed for this session"
    )
      return null;
    throw error;
  });
  const goalEvents = snapshot
    ? [
        ...snapshot.goalHistory.flatMap((goal) => goal.primaryEvents),
        ...snapshot.primaryEvents,
      ]
    : [];
  const composer = coordinatorTransaction((db) =>
    db
      .prepare(
        "SELECT event AS eventId,at,body AS text FROM human_inputs WHERE harness=? AND session=? AND cwd=? ORDER BY rowid",
      )
      .all(source.harness, source.sessionId, source.cwd),
  );
  return [
    ...goalEvents.map((event) => ({
      eventId: event.eventId,
      author: "human",
      at: event.receivedAt,
      text: event.text,
    })),
    ...composer.map((row) => ({
      eventId: String(row.eventId),
      author: "human",
      at: String(row.at),
      text: String(row.text),
    })),
  ].sort((a, b) => (a.at ?? "").localeCompare(b.at ?? ""));
}

const marker = "herder.coordinator-message.v1";
export async function renderCoordinatorMessage(
  body: string,
  refs?: z.infer<typeof humanCitations>,
  readSource = readHumanMessages,
) {
  if (!refs && !body.includes(marker)) return body;
  const quotes = [];
  for (const { eventId, ...source } of refs ?? []) {
    const message = (await readSource(source)).find(
      (row) => row.eventId === eventId,
    );
    if (!message?.at)
      throw new Error("Human citation has no accepted source receipt");
    quotes.push({ source, ...message });
  }
  const payload = { schema: marker, instructions: body, humanMessages: quotes };
  const receipt = createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex");
  coordinatorTransaction((db) =>
    db
      .prepare("INSERT OR IGNORE INTO citation_receipts VALUES(?)")
      .run(receipt),
  );
  return JSON.stringify({ ...payload, receipt });
}

export function verifyCoordinatorMessage(envelope: string) {
  const { receipt, schema, instructions, humanMessages } = JSON.parse(envelope);
  const digest = createHash("sha256")
    .update(JSON.stringify({ schema, instructions, humanMessages }))
    .digest("hex");
  const verified =
    digest === receipt &&
    schema === marker &&
    coordinatorTransaction((db) =>
      Boolean(
        db.prepare("SELECT id FROM citation_receipts WHERE id=?").get(digest),
      ),
    );
  return verified
    ? { verified: true, instructions, humanMessages }
    : { verified: false };
}
