import { appendFileSync } from "node:fs";
import readline from "node:readline";

const counterFile = process.env.FAKE_ACP_COUNTER;
const sessions = [{
  sessionId: "fake-session-1",
  cwd: process.cwd(),
  title: "Fake ACP session",
  updatedAt: new Date().toISOString(),
}];

function record(method) {
  if (counterFile) appendFileSync(counterFile, `${method}\n`);
}

function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function notify(sessionId, update) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } })}\n`);
}

const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  const request = JSON.parse(line);
  record(request.method);
  if (request.method === "initialize") {
    reply(request.id, {
      protocolVersion: 1,
      agentInfo: { name: "fake-acp", version: "1.0.0" },
      agentCapabilities: {
        loadSession: process.env.FAKE_ACP_NO_LOAD !== "1",
        sessionCapabilities: { list: {}, resume: {}, close: {} },
      },
    });
    return;
  }
  if (request.method === "session/list") {
    reply(request.id, { sessions });
    return;
  }
  if (request.method === "session/load" || request.method === "session/resume") {
    notify("fake-session-1", { sessionUpdate: "user_message_chunk", content: { type: "text", text: "old prompt" } });
    notify("fake-session-1", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "old answer" } });
    notify("fake-session-1", { sessionUpdate: "tool_call", toolCallId: "tool-1", title: "Bash", rawInput: { command: "npm test" }, status: "in_progress" });
    notify("fake-session-1", { sessionUpdate: "tool_call_update", toolCallId: "tool-1", status: "completed", rawOutput: "passed" });
    reply(request.id, {});
    return;
  }
  if (request.method === "session/prompt") {
    reply(request.id, { stopReason: "end_turn" });
    return;
  }
  if (request.method === "session/set_config_option") {
    reply(request.id, {
      configOptions: [{
        id: "model",
        name: "Model",
        type: "select",
        currentValue: request.params.value,
        options: [{ name: "Lite", value: "lite" }, { name: "Ultimate", value: "ultimate" }],
      }],
    });
    return;
  }
  if (request.method === "session/close") {
    reply(request.id, {});
    return;
  }
  reply(request.id, {});
});
