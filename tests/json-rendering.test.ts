import { describe, expect, it } from "vitest";
import { formatJsonPayload, readJsonRenderingOptOut, splitSystemBlocks, writeJsonRenderingOptOut } from "../src/web-ui/json-rendering.js";

function fakeStorage(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => { items.set(key, value); },
    removeItem: (key: string) => { items.delete(key); },
    items,
  };
}

describe("system blocks in rendered messages", () => {
  it("preserves fenced code containing service-tag examples", () => {
    const text = "До\n```xml\n<system-reminder>пример</system-reminder>\n```\nПосле";
    expect(splitSystemBlocks(text)).toEqual({ text, blocks: [] });
  });

  it("preserves an unfinished streamed fence", () => {
    const text = "```js\nconst answer = 42;";
    expect(splitSystemBlocks(text)).toEqual({ text, blocks: [] });
  });

  it("collapses service prose while preserving adjacent code", () => {
    const result = splitSystemBlocks("<system-reminder> служебное </system-reminder>\n```json\n{\"ok\":true}\n```\nГотово");
    expect(result).toEqual({
      text: "```json\n{\"ok\":true}\n```\nГотово",
      blocks: [{ label: "Системное напоминание", body: "служебное" }],
    });
  });
});

describe("formatJsonPayload", () => {
  it("formats a bare JSON object", () => {
    expect(formatJsonPayload('{"status":"plans_ready","dedup_key":"fleet-health:vusa:cpu"}'))
      .toBe('{\n  "status": "plans_ready",\n  "dedup_key": "fleet-health:vusa:cpu"\n}');
  });

  it("formats a bare JSON array", () => {
    expect(formatJsonPayload("[1,2]")).toBe("[\n  1,\n  2\n]");
  });

  it("keeps surrounding whitespace out of the rendered value", () => {
    expect(formatJsonPayload("\n  {\"a\":1}\n")).toBe('{\n  "a": 1\n}');
  });

  it("keeps nested structure readable", () => {
    expect(formatJsonPayload('{"a":{"b":[true,null]}}')).toBe('{\n  "a": {\n    "b": [\n      true,\n      null\n    ]\n  }\n}');
  });

  it("ignores prose that merely contains JSON", () => {
    expect(formatJsonPayload("Готово. Вот результат: {\"status\":\"ok\"} — проверьте.")).toBeUndefined();
  });

  it("ignores fenced JSON inside a larger answer", () => {
    expect(formatJsonPayload("Итог:\n```json\n{\"status\":\"ok\"}\n```\nГотово.")).toBeUndefined();
  });

  it("ignores bare scalars", () => {
    expect(formatJsonPayload("true")).toBeUndefined();
    expect(formatJsonPayload("42")).toBeUndefined();
    expect(formatJsonPayload('"готово"')).toBeUndefined();
  });

  it("ignores broken JSON that starts like an object", () => {
    expect(formatJsonPayload('{"status":"ok",')).toBeUndefined();
    expect(formatJsonPayload("{готово}")).toBeUndefined();
  });

  it("ignores empty and single-character answers", () => {
    expect(formatJsonPayload("")).toBeUndefined();
    expect(formatJsonPayload("   \n ")).toBeUndefined();
    expect(formatJsonPayload("{")).toBeUndefined();
  });
});

describe("json rendering opt-out", () => {
  it("is off by default, so JSON renders as JSON", () => {
    expect(readJsonRenderingOptOut(fakeStorage())).toBe(false);
  });

  it("round-trips the opt-out and clears it back", () => {
    const storage = fakeStorage();
    writeJsonRenderingOptOut(storage, true);
    expect(storage.items.get("agent-herder.json-rendering.opt-out")).toBe("1");
    expect(readJsonRenderingOptOut(storage)).toBe(true);
    writeJsonRenderingOptOut(storage, false);
    expect(readJsonRenderingOptOut(storage)).toBe(false);
    expect(storage.items.has("agent-herder.json-rendering.opt-out")).toBe(false);
  });

  it("falls back to rendering JSON when storage is unavailable", () => {
    const broken = {
      getItem: () => { throw Error("denied"); },
      setItem: () => { throw Error("denied"); },
      removeItem: () => { throw Error("denied"); },
    };
    expect(readJsonRenderingOptOut(broken)).toBe(false);
    expect(() => writeJsonRenderingOptOut(broken, true)).not.toThrow();
  });
});
