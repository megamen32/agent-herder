import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { SessionWorkspaceStore, sessionWorkspaces } from "./session-workspaces.js";
import { structuredResult } from "./mcp/results.js";
const identitySchema = { runtimeHostId:z.string().trim().min(1).max(512), harness:z.string().trim().min(1).max(64), nativeSessionId:z.string().trim().min(1).max(512) };
const workspaceSchema=z.object({hostId:z.string().trim().min(1).max(512),absolutePath:z.string().startsWith("/").max(4096),source:z.enum(["declared","observed"]),observedAt:z.iso.datetime(),evidence:z.string().min(1).max(4096).optional()});
export function registerSessionWorkspaceTools(server:McpServer,store:SessionWorkspaceStore=sessionWorkspaces):void {
  server.registerTool("session_workspaces_declare",{
    description:"Declare where this session changes code, separately from its GUI/runtime host. At task start declare all actual work computer IDs and absolute project paths; update when work moves. Empty replace means unknown. This records locations only and grants no access. Use union to add locations or replace with expectedVersion to remove them safely; never use launch cwd or titles as evidence.",
    inputSchema:z.object({...identitySchema,workspaces:z.array(workspaceSchema).max(64),mode:z.enum(["replace","union"]),expectedVersion:z.number().int().nonnegative().optional(),observedAt:z.iso.datetime()}),
  },async(args)=>structuredResult({record:await store.declare(args)},true));
  server.registerTool("session_workspaces_get",{description:"Read the durable declared/observed code work areas for an exact runtime host, harness and native session ID. Null means unknown, without guessing from runtime cwd.",inputSchema:z.object(identitySchema)},async(args)=>structuredResult({record:await store.read(args)}));
}
