import * as React from "react";
import type { SessionMessagePart } from "../types/index.js";

export type MessagePartSegment = { kind: "activity" | "content"; parts: SessionMessagePart[] };

function toolLabel(part: SessionMessagePart): { label: string; commands: boolean } {
  const input = typeof part.input === "object" && part.input !== null ? part.input as Record<string, unknown> : undefined;
  const name = part.name || "";
  if (name === "subagent") {
    const agent = typeof input?.agentPath === "string" ? ` ${input.agentPath}` : "";
    const completed = input?.kind === "completed" || input?.kind === "finished";
    return { label: `Субагент${agent}${completed ? " завершил работу" : input?.kind === "spawned" ? " запущен" : ""}`, commands: false };
  }
  // Read wrapper source as data only. Never execute it or evaluate arguments.
  const code = name === "exec" || name === "functions.exec"
    ? typeof part.input === "string" ? part.input : typeof input?.code === "string" ? input.code : ""
    : "";
  const wrapped = code ? Array.from(code.matchAll(/\btools(?:\.([A-Za-z_$][\w$]*)|\[\s*["']([\w.:-]+)["']\s*\])\s*\(/g), match => match[1] || match[2]!) : [];
  if (wrapped.length) {
    const labels = wrapped.map(tool => toolLabel({ type: "tool_call", name: tool }));
    return labels.every(label => label.commands) ? { label: "Выполнил команды", commands: true }
      : { label: [...new Set(labels.map(label => label.label))].join(" · "), commands: false };
  }
  const short = name.replace(/^functions\./, "");
  if (["command", "exec_command", "shell_exec", "bash", "terminal"].includes(short)) return { label: "Выполнил команды", commands: true };
  if (short === "view_image") return { label: "Просмотрено изображение", commands: false };
  if (["read_file", "read_text_file"].includes(short)) return { label: "Прочитан файл", commands: false };
  if (short === "apply_patch") return { label: "Внесены изменения", commands: false };
  if (short === "write_stdin") return { label: "Проверено выполнение команды", commands: false };
  const mcp = name.match(/^(?:mcp__)?(.+?)__(?:.+)$/);
  if (mcp) {
    const aliases: Record<string, string> = { agent_herder: "Agent Herder", context_mode: "Context Mode", UserIO: "UserIO", userio: "UserIO", gptadmin: "GPTAdmin", noticeplace: "Notice Place", AskSecret: "AskSecret", xerj: "XERJ", grepmesh: "GrepMesh" };
    const integration = aliases[mcp[1]!] || mcp[1]!.replace(/^(?:codex_apps__)/, "").replace(/[_-]+/g, " ");
    return { label: `Использовано ${integration}`, commands: false };
  }
  return { label: name === "exec" || name === "functions.exec" ? "Выполнен сценарий" : "Использован инструмент", commands: false };
}

type ToolEntry = { part: SessionMessagePart; result?: SessionMessagePart };

function ActivityIcon({ label }: { label: string }) {
  const kind = label.includes("команд") || label === "Выполнен сценарий" ? "terminal"
    : label === "Просмотрено изображение" ? "image" : "integration";
  return <svg className="activity-semantic-icon" data-activity-icon={kind} aria-hidden="true" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
    {kind === "terminal" ? <><rect x="2" y="3" width="16" height="14" rx="2" /><path d="m5 7 3 3-3 3m5 0h4" /></>
      : kind === "image" ? <><rect x="2" y="3" width="16" height="14" rx="2" /><circle cx="6.5" cy="7.5" r="1.5" /><path d="m3 15 4-4 3 3 3-5 4 6" /></>
        : <><path d="M7 2v4m6-4v4M5 6h10v3a5 5 0 0 1-10 0V6Zm5 8v4" /></>}
  </svg>;
}

function ToolDetails({ entries, label }: { entries: ToolEntry[]; label: string }) {
  const failed = entries.some(({ part, result }) => part.error || result?.error);
  return <details className={`tool-actions tool-action-row${failed ? " tool-actions-failed" : ""}`}>
    <summary><ActivityIcon label={label} /><span className="tool-action-name">{label}</span></summary>
    <div className="tool-actions-body">
      {entries.map(({ part, result }, index) => <div className="tool-actions-item" key={index}>
        <b>{part.name || "Инструмент"} · {part.error || result?.error ? "Ошибка" : part.name === "subagent" ? "Взаимодействие" : result || part.type === "tool_result" ? "Готово" : "Вызов"}</b>
        {part.type === "tool_call" && part.input !== undefined && <><b>Вход</b><pre>{typeof part.input === "string" ? part.input : JSON.stringify(part.input, null, 2)}</pre></>}
        {(result?.output ?? part.output) !== undefined && <><b>Результат</b><pre>{result?.output ?? part.output}</pre></>}
      </div>)}
    </div>
  </details>;
}

export function groupMessagePartSegments(parts: SessionMessagePart[]): MessagePartSegment[] {
  const segments: MessagePartSegment[] = [];
  for (const part of parts) {
    const kind = part.type === "thinking" || part.type === "tool_call" || part.type === "tool_result" ? "activity" : "content";
    const previous = segments[segments.length - 1];
    if (previous?.kind === kind) previous.parts.push(part);
    else segments.push({ kind, parts: [part] });
  }
  return segments;
}

export function MessageActivityRows({ parts, showReasoning, showTools }: {
  parts: SessionMessagePart[];
  showReasoning: boolean;
  showTools: boolean;
}) {
  const rows: React.ReactNode[] = [];
  let commands: ToolEntry[] = [];
  const flushCommands = () => {
    if (!commands.length) return;
    rows.push(<ToolDetails key={`commands:${rows.length}`} entries={commands} label="Выполнил команды" />);
    commands = [];
  };
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index]!;
    if (part.type === "thinking") {
      if (!part.text?.trim() && index !== parts.length - 1) continue;
      flushCommands();
      if (!showReasoning) continue;
      rows.push(<details className="oc-disclosure activity-thinking" key={`thinking:${index}`}>
        <summary>Думаю</summary>
        {part.text?.trim() ? <pre>{part.text}</pre> : <p className="activity-empty-summary">Codex не сохранил публичную сводку этого события.</p>}
      </details>);
      continue;
    }
    if (part.type !== "tool_call" && part.type !== "tool_result") { flushCommands(); continue; }
    if (!showTools) continue;
    const isCall = part.type === "tool_call";
    const next = parts[index + 1];
    const result = isCall && part.name && part.name !== "subagent" && next?.type === "tool_result" && next.name === part.name ? next : undefined;
    if (result) index += 1;
    const label = toolLabel(part);
    if (label.commands) commands.push({ part, result });
    else {
      flushCommands();
      rows.push(<ToolDetails key={`tool:${index}`} entries={[{ part, result }]} label={label.label} />);
    }
  }
  flushCommands();
  return <div className="message-activity-rows">
    {rows}
  </div>;
}
