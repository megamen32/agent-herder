import * as React from "react";
import type { SessionMessageView } from "../types/index.js";
import { activityMoment, activityTime, mcpToolUsage, sessionActivityEvents, type McpToolUsage } from "./session-activity.js";

/**
 * The work of the session, as the owner reads it in the inspector.
 *
 * Two questions live here: what the session changed and in which order, and
 * which MCP tools it called. Both are read from the transcript the panel
 * already holds; nothing is measured a second time.
 */

/** The moment of an event, in the owner's words. */
function moment(at: string | undefined): string {
  const day = activityMoment(at);
  const time = activityTime(at);
  return day ? `${day} · ${time}` : "";
}

/** The tools of the session, counted once each. */
export function McpUsageBlock({ usage, read }: { usage: McpToolUsage[]; read: boolean }) {
  return <details className="inspector-fold">
    <summary>MCP <span>{read ? usage.length : "—"}</span></summary>
    {usage.length
      ? <ul className="inspector-mcp-list">{usage.map((entry) => <li key={entry.name} title={entry.name}>
        <strong>{entry.name}</strong><small>{entry.count} вызовов</small>
      </li>)}</ul>
      : <p className="inspector-facts-empty">{read
        ? "вызовов MCP не зафиксировано"
        : "переписка не загружена — вызовы MCP появятся вместе с историей"}</p>}
  </details>;
}

/** The timeline of the work of the session. */
export function ActivityTimelineBlock({ messages }: { messages: readonly SessionMessageView[] | undefined }) {
  const events = React.useMemo(() => sessionActivityEvents(messages), [messages]);
  const shown = events.slice(-60).reverse();
  // Переписка прочитана и пуста — это не то же, что переписки нет: панель
  // говорит «действий не было», а не «панель ничего не знает».
  const read = messages !== undefined;
  return <details className="inspector-fold">
    <summary>Таймлайн изменений <span>{read ? events.length : "—"}</span></summary>
    {shown.length
      ? <ol className="inspector-timeline">{shown.map((event, index) => <li key={`${event.at || "x"}-${index}`} className={`timeline-kind-${event.kind}`}>
        <span className="timeline-time">{moment(event.at)}</span>
        <span className="timeline-body">
          <strong>{event.label}</strong>
          <small>{event.tool}{event.paths.length ? ` · ${event.paths.length} файл(ов)` : ""}</small>
        </span>
      </li>)}</ol>
      : <p className="inspector-facts-empty">{read
        ? "инструменты в переписке не вызывались"
        : "переписка не загружена — таймлайн появится, когда панель прочитает историю сессии"}</p>}
    {events.length > shown.length && <small className="settings-hint">Показаны последние {shown.length} из {events.length}.</small>}
  </details>;
}

/** The whole work of the session: the timeline and the MCP tools. */
export function SessionActivityPanel({ messages }: { messages: readonly SessionMessageView[] | undefined }) {
  const usage = React.useMemo(() => mcpToolUsage(messages), [messages]);
  // Переписка прочитана и пуста — это не то же, что переписки нет: панель
  // говорит «действий не было», а не «панель ничего не знает».
  const read = messages !== undefined;
  return <>
    <ActivityTimelineBlock messages={messages} />
    <McpUsageBlock usage={usage} read={read} />
  </>;
}
