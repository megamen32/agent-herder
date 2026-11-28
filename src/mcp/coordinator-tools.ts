import { createHash } from "node:crypto";
import {
  createNoticePlacePayload,
  createNoticePlaceSink,
} from "../autopilot/index.js";
import type { AgentSession } from "../types/index.js";
import { registerUrlWatch } from "./url-watch.js";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { coordinatorTransaction } from "../coordinator-state.js";
import {
  citationSource,
  readHumanMessages,
  verifyCoordinatorMessage,
} from "../coordinator-citations.js";
import { structuredResult } from "./results.js";

const key = z.string().trim().min(1).max(512);
const project = z.object({ project: key });
const target = project.extend({ harness: key, sessionId: key });
const states = z.enum([
  "working",
  "blocked-on-human",
  "review-ready",
  "done",
  "failed",
  "stopped",
]);

type WorkerReader = (
  harness: string,
  id: string,
) => Promise<AgentSession | null>;

async function sendDigest(project: string, batchId: string, body: string) {
  const eventUrl = process.env.NOTIFY_CENTER_EVENT_URL,
    token = process.env.NOTIFY_CENTER_TOKEN;
  if (!eventUrl || !token)
    throw new Error("Configure the Notice producer before sending a digest");
  const key =
    "coordinator-digest-" +
    createHash("sha256")
      .update(JSON.stringify([project, batchId]))
      .digest("hex");
  await createNoticePlaceSink({ eventUrl, token }).send(
    createNoticePlacePayload({
      project: process.env.NOTIFY_CENTER_PROJECT || "agent-herder",
      recipient: process.env.NOTIFY_CENTER_RECIPIENT || "me",
      kind: "update",
      severity: "info",
      title: project,
      body,
      dedupKey: key,
      correlationId: key,
      idempotencyKey: key,
    }),
  );
}

export function registerCoordinatorTools(
  server: McpServer,
  readWorker: WorkerReader,
  pendingQuestions?: () => Promise<Set<string>>,
  readSource = readHumanMessages,
) {
  registerUrlWatch(server);
  server.registerTool(
    "human_messages",
    {
      description:
        "Read original accepted goal messages with citation identifiers, author and time. Supply the source tuple and eventId on deliver or send_message.",
      inputSchema: z.union([
        citationSource,
        z.object({ envelope: z.string().min(1).max(1000000) }).strict(),
      ]),
    },
    async (source) =>
      "envelope" in source
        ? structuredResult(verifyCoordinatorMessage(source.envelope))
        : structuredResult({
            source,
            messages: await readSource(source),
          }),
  );

  server.registerTool(
    "project_memory",
    {
      description:
        "Read a shared project document or replace it with an atomic revision check. Revision zero means absent.",
      inputSchema: z.discriminatedUnion("action", [
        project.extend({ action: z.literal("read") }),
        project.extend({
          action: z.literal("write"),
          ifMatch: z.number().int().nonnegative(),
          text: z.string().max(128000),
        }),
      ]),
    },
    async (args) =>
      structuredResult(
        coordinatorTransaction((db) => {
          const current = db
            .prepare("SELECT revision,body AS text FROM memory WHERE project=?")
            .get(args.project) ?? { revision: 0, text: "" };
          if (args.action === "read") return { ...current, ok: true };
          if (args.ifMatch !== current.revision)
            return {
              ok: false,
              error: "revision_conflict",
              revision: current.revision,
            };
          const revision = args.ifMatch + 1;
          db.prepare("INSERT OR REPLACE INTO memory VALUES(?,?,?)").run(
            args.project,
            revision,
            args.text,
          );
          return { ok: true, revision };
        }),
      ),
  );

  server.registerTool(
    "worker",
    {
      description:
        "List project assignments, update their coordinator-declared state and PRs, resolve or reopen. Native stop and rename remain separate operations.",
      inputSchema: z.discriminatedUnion("action", [
        project.extend({ action: z.literal("list") }),
        target.extend({
          action: z.literal("update"),
          state: states,
          prs: z
            .array(z.url({ protocol: /^https$/ }))
            .max(16)
            .optional(),
        }),
        target.extend({ action: z.literal("resolve") }),
        target.extend({ action: z.literal("reopen") }),
      ]),
    },
    async (args) => {
      if (args.action === "list") {
        const rows = coordinatorTransaction((db) =>
          db
            .prepare(
              "SELECT harness,session AS sessionId,title,state,prs FROM workers WHERE project=? ORDER BY title,session",
            )
            .all(args.project),
        );
        const blocked = await pendingQuestions?.();
        const workers = await Promise.all(
          rows.map(async (row) => {
            const native = await readWorker(
              String(row.harness),
              String(row.sessionId),
            );
            let state = row.state === "tracking" ? "working" : row.state;
            if (row.state === "tracking" && native) {
              if (native.status === "stopped") state = "stopped";
              else if (native.status === "error") state = "failed";
              else if (
                native.status === "needs_input" ||
                blocked?.has(JSON.stringify([row.harness, row.sessionId]))
              )
                state = "blocked-on-human";
              else if (
                native.status === "idle" &&
                (native.meta?.nativeLastTurn as { status?: string })?.status ===
                  "completed"
              )
                state = "review-ready";
            }
            return {
              ...row,
              title: native?.title ?? row.title,
              state,
              prs: JSON.parse(String(row.prs)),
            };
          }),
        );
        return structuredResult({ workers });
      }
      return structuredResult(
        coordinatorTransaction((db) => {
          const state =
            args.action === "update"
              ? args.state
              : args.action === "resolve"
                ? "done"
                : "working";
          const prs =
            args.action === "update" && args.prs
              ? JSON.stringify(args.prs)
              : null;
          const changed = db
            .prepare(
              "UPDATE workers SET state=?,prs=coalesce(?,prs) WHERE project=? AND harness=? AND session=?",
            )
            .run(state, prs, args.project, args.harness, args.sessionId);
          if (!changed.changes) throw new Error("Unknown project worker");
          return { state };
        }),
      );
    },
  );

  server.registerTool(
    "message_reaction",
    {
      description:
        "Record or read acknowledgements for a worker message. Repeating the same actor's reaction replaces it.",
      inputSchema: target.extend({
        messageId: key,
        ack: z
          .object({ actor: key, reaction: z.string().min(1).max(32) })
          .optional(),
      }),
    },
    async (args) =>
      structuredResult(
        coordinatorTransaction((db) => {
          const identity = [
            args.project,
            args.harness,
            args.sessionId,
            args.messageId,
          ];
          if (args.ack)
            db.prepare(
              "INSERT OR REPLACE INTO reactions VALUES(?,?,?,?,?,?)",
            ).run(...identity, args.ack.actor, args.ack.reaction);
          return {
            reactions: db
              .prepare(
                "SELECT actor,reaction FROM reactions WHERE project=? AND harness=? AND session=? AND message=? ORDER BY actor",
              )
              .all(...identity),
          };
        }),
      ),
  );

  server.registerTool(
    "project_digest",
    {
      description:
        "Hold project updates until human activity goes quiet. Queue by stable ID. Flush returns one digest per batchId, replayable after a lost response.",
      inputSchema: z.discriminatedUnion("action", [
        project.extend({
          action: z.literal("presence"),
          quietMs: z.number().int().min(0).max(86400000),
        }),
        project.extend({
          action: z.literal("queue"),
          id: key,
          text: z.string().min(1).max(4000),
        }),
        project.extend({
          action: z.literal("flush"),
          batchId: key,
          send: z.boolean().default(false),
        }),
      ]),
    },
    async (args) => {
      const result = coordinatorTransaction((db) => {
        if (args.action === "presence") {
          const quietUntil = Date.now() + args.quietMs;
          db.prepare("INSERT OR REPLACE INTO presence VALUES(?,?)").run(
            args.project,
            quietUntil,
          );
          return { quietUntil };
        }
        if (args.action === "queue") {
          db.prepare(
            "INSERT OR IGNORE INTO updates(project,id,body) VALUES(?,?,?)",
          ).run(args.project, args.id, args.text);
          if (
            db
              .prepare("SELECT body FROM updates WHERE project=? AND id=?")
              .get(args.project, args.id)?.body !== args.text
          )
            throw new Error("Update ID conflict");
          return { queued: true };
        }
        const read = () =>
          db
            .prepare(
              "SELECT body FROM updates WHERE project=? AND batch=? ORDER BY rowid",
            )
            .all(args.project, args.batchId);
        const previous = read();
        if (previous.length)
          return {
            digest: previous.map((r) => r.body).join("\n"),
            batchId: args.batchId,
          };
        const quietUntil = Number(
          db
            .prepare("SELECT quietUntil FROM presence WHERE project=?")
            .get(args.project)?.quietUntil ?? 0,
        );
        if (quietUntil > Date.now()) return { held: true, quietUntil };
        const pending = db
          .prepare(
            "SELECT rowid AS n,body FROM updates WHERE project=? AND batch IS NULL ORDER BY rowid LIMIT 32",
          )
          .all(args.project);
        let size = 0;
        for (const row of pending) {
          size += String(row.body).length + 1;
          if (size > 8192) break;
          db.prepare("UPDATE updates SET batch=? WHERE rowid=?").run(
            args.batchId,
            row.n,
          );
        }
        return {
          batchId: args.batchId,
          digest: read()
            .map((r) => r.body)
            .join("\n"),
        };
      });
      if (args.action === "flush" && args.send && result.digest) {
        await sendDigest(args.project, args.batchId, result.digest);
        return structuredResult({ ...result, sent: true });
      }
      return structuredResult(result);
    },
  );
}
