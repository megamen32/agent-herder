import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const harness = process.env.AHAP_HARNESS;
const trace = "native.jsonl";
const methods = ["init", "getSession", "listSessions", "getSessionMessages", "sendMessage", "cancelTurn"];
for await (const line of createInterface({ input: process.stdin })) {
  const { method, params, id } = JSON.parse(line);
  const records = existsSync(trace) ? readFileSync(trace, "utf8").trimEnd().split("\n").map(row => JSON.parse(row)) : [];
  let result = null;
  if (method === "initialize") {
    result = { harness, capabilities: { methods, deliveryModes: ["queue"], nativeProtocol: "direct-cdp",
      controlCapabilities: { cancelTurn: true }, browserFeatures: { attachments: true } } };
  } else if (method === "getSession") {
    result = { harness, id: params.id, status: "idle", cwd: process.cwd(), meta: { nativeStateObserved: true } };
  } else if (method === "listSessions") {
    result = [];
  } else if (method === "getSessionMessages") {
    result = records.filter(row => row.method === "sendMessage" && row.id === params.id).map(row => row.message);
  } else if (method === "sendMessage") {
    const message = { id: "native-" + (records.length + 1), role: "user", text: params.options.message };
    appendFileSync(trace, JSON.stringify({ method, harness, id: params.id, message, attachments: params.options.attachments }) + "\n");
    if (message.text === "lose native response") process.exit(0);
    result = { ok: true, admitted: true, harness, sessionId: params.id, inputId: params.options.inputId, nativeInputMessageId: message.id };
  } else if (method === "cancelTurn") {
    const cancelled = records.some(row => row.method === "sendMessage" && row.id === params.id && row.message.id === params.inputMessageId);
    appendFileSync(trace, JSON.stringify({ method, harness, ...params }) + "\n");
    result = { sessionId: params.id, inputMessageId: params.inputMessageId, cancelled };
  } else if (method !== "init") {
    throw new Error("Unexpected fixture operation " + method);
  }
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}
