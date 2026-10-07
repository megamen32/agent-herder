import * as React from "react";

type NavigationProps = {
  active: "chat" | "jobs" | "statistics";
  onChat: () => void;
  onNew: () => void;
  onJobs: () => void;
  onStatistics: () => void;
};

const paths = {
  chat: "M3 10 12 3l9 7v10H15v-6H9v6H3Z",
  new: "M12 5v14M5 12h14",
  jobs: "M8 4H5v17h14V4h-3M8 3h8v4H8ZM8 12h8M8 16h5",
  statistics: "M4 20V12M10 20V4M16 20V9M22 20H2",
};

export function CodexNavigation(props: NavigationProps) {
  const items = [
    { id: "chat", label: "Чаты", action: props.onChat },
    { id: "new", label: "Новый чат", action: props.onNew },
    { id: "jobs", label: "Задачи", action: props.onJobs },
    { id: "statistics", label: "Статистика", action: props.onStatistics },
  ] as const;
  return <nav className="codex-navigation" aria-label="Основная навигация">
    <div className="codex-navigation-items">{items.map((item) => <button key={item.id} type="button" title={item.label} aria-label={item.label} aria-pressed={item.id === props.active} className={item.id === props.active ? "active" : ""} onClick={item.action}><svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d={paths[item.id]} /></svg></button>)}</div>
    <span className="codex-navigation-mark" title="Agent Herder">AH</span>
  </nav>;
}
