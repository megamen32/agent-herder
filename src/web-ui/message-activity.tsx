import * as React from "react";
import type { SessionMessagePart } from "../types/index.js";

export type MessagePartSegment = { kind: "activity" | "content"; parts: SessionMessagePart[] };

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
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index]!;
    if (part.type === "thinking") {
      if (!showReasoning) continue;
      rows.push(<details className="oc-disclosure activity-thinking" key={`thinking:${index}`}>
        <summary>Думаю</summary>
        {part.text?.trim() ? <pre>{part.text}</pre> : <p className="activity-empty-summary">Codex не сохранил публичную сводку этого события.</p>}
      </details>);
      continue;
    }
    if (part.type !== "tool_call" && part.type !== "tool_result") continue;
    if (!showTools) continue;
    const isCall = part.type === "tool_call";
    const next = parts[index + 1];
    const result = isCall && part.name && part.name !== "subagent" && next?.type === "tool_result" && next.name === part.name ? next : undefined;
    if (result) index += 1;
    const input = isCall && typeof part.input === "object" && part.input !== null ? part.input as Record<string, unknown> : undefined;
    const isSubagentEvent = isCall && part.name === "subagent";
    const command = isCall && part.name === "command"
      ? typeof input?.command === "string" ? input.command : Array.isArray(input?.command) && input.command.every((value) => typeof value === "string") ? input.command.join(" ") : undefined
      : undefined;
    const agentPath = isSubagentEvent && typeof input?.agentPath === "string" ? input.agentPath : undefined;
    const name = isSubagentEvent ? `Субагент${agentPath ? ` · ${agentPath}` : ""}` : command ? `command · ${command}` : part.name || (isCall ? "Вызов инструмента" : "Результат инструмента");
    const subagentKind = typeof input?.kind === "string" ? input.kind : undefined;
    const error = result?.error === true || !isCall && part.error === true;
    const status = isSubagentEvent
      ? subagentKind === "interacted" ? "Взаимодействие" : subagentKind === "spawned" ? "Запуск" : "Событие"
      : isCall && !result ? "Вызов" : error ? "Ошибка" : "Готово";
    const output = result ? result.output : !isCall ? part.output : undefined;
    rows.push(<details className={`tool-actions tool-action-row${error ? " tool-actions-failed" : ""}`} key={`tool:${index}`}>
      <summary>
        <span className="tool-actions-icon" aria-hidden="true">⌘</span>
        <span className="tool-action-name">{name}</span>
        <small className="tool-action-status">{status}</small>
      </summary>
      <div className="tool-actions-body">
        {isCall && part.input !== undefined && <><b>Вход</b><pre>{JSON.stringify(part.input, null, 2)}</pre></>}
        {output !== undefined && <><b>Результат</b><pre>{output}</pre></>}
      </div>
    </details>);
  }
  return <div className="message-activity-rows">
    {rows}
  </div>;
}
