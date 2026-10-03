/** Convert one Streamable HTTP response into JSONL messages for stdio MCP. */
export function decodeMcpHttpPayload(contentType: string | null, payload: string): string[] {
  if (!payload.trim()) return [];
  if (!contentType?.toLowerCase().includes("text/event-stream")) {
    return [normalizeJson(payload.trim())];
  }

  const messages: string[] = [];
  for (const event of payload.split(/\r?\n\r?\n/)) {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
      .trim();
    if (!data || data === "[DONE]") continue;
    messages.push(normalizeJson(data));
  }
  return messages;
}

function normalizeJson(value: string): string {
  return JSON.stringify(JSON.parse(value));
}
