import * as React from "react";

type NavigationProps = {
  active: "chat" | "jobs" | "statistics" | "machines" | "search" | "projects" | "settings" | "logs";
  chatsOpen: boolean;
  menuOpen: boolean;
  onSettings: () => void;
  onChat: () => void;
  onNew: () => void;
  onJobs: () => void;
  onStatistics: () => void;
  onMachines: () => void;
  onSearch: () => void;
  onProjects: () => void;
  onLogs: () => void;
  onMenu: () => void;
};

const paths = {
  chat: "M3 10 12 3l9 7v10H15v-6H9v6H3Z",
  new: "M12 5v14M5 12h14",
  jobs: "M8 4H5v17h14V4h-3M8 3h8v4H8ZM8 12h8M8 16h5",
  statistics: "M4 20V12M10 20V4M16 20V9M22 20H2",
  machines: "M3 4h18v12H3ZM8 21h8M12 16v5",
  search: "M10.5 3a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15ZM16 16l5 5",
  projects: "M3 6h7v6H3ZM14 6h7v6h-7ZM3 16h7v4H3ZM14 16h7v4h-7Z",
  settings: "M4 6h16M4 12h16M4 18h16M8 3v6M16 9v6M10 15v6",
  logs: "M4 4h16v12H4ZM8 20h8M12 16v4M7 8h10M7 12h6",
  menu: "M4 6h16M4 12h16M4 18h16",
};

// Каждому разделу — свой адрес (?page=<раздел>): ссылку можно открыть в новой
// вкладке или в отдельном окне, а адресная строка всегда отражает экран.
const pageHref = (page: "chat" | "projects" | "machines" | "search" | "jobs" | "statistics" | "logs" | "settings"): string => {
  const url = new URL(window.location.href);
  if (page === "chat") url.searchParams.delete("page"); else url.searchParams.set("page", page);
  url.hash = "";
  return `${url.pathname}${url.search}`;
};

export function CodexNavigation(props: NavigationProps) {
  const items: Array<{ id: keyof typeof paths; label: string; action: () => void; href?: string }> = [
    { id: "chat", label: "Чаты", action: props.onChat, href: pageHref("chat") },
    { id: "new", label: "Новый чат", action: props.onNew },
    { id: "projects", label: "Проекты", action: props.onProjects, href: pageHref("projects") },
    { id: "machines", label: "Машины", action: props.onMachines, href: pageHref("machines") },
    { id: "search", label: "Поиск", action: props.onSearch, href: pageHref("search") },
    { id: "jobs", label: "Операции", action: props.onJobs, href: pageHref("jobs") },
    { id: "statistics", label: "Статистика", action: props.onStatistics, href: pageHref("statistics") },
    { id: "logs", label: "Логи", action: props.onLogs, href: pageHref("logs") },
    { id: "settings", label: "Настройки", action: props.onSettings, href: pageHref("settings") },
    { id: "menu", label: "Ещё", action: props.onMenu },
  ];
  return <nav className="codex-navigation" aria-label="Основная навигация">
    <div className="codex-navigation-items">{items.map((item) => {
      const selected = item.id === "chat"
        ? props.active === "chat" && props.chatsOpen
        : item.id === "menu"
          ? props.menuOpen
          : item.id === props.active;
      const className = `${item.id === "menu" ? "nav-menu-toggle " : ""}${selected ? "active" : ""}`;
      const icon = <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d={paths[item.id]} /></svg>;
      const label = <span className="nav-label">{item.label}</span>;
      const href = item.href;
      if (href === undefined) return <button key={item.id} type="button" title={item.label} aria-label={item.label} aria-controls={item.id === "chat" ? "herder-chat-list" : undefined} aria-expanded={item.id === "chat" ? props.chatsOpen : item.id === "menu" ? props.menuOpen : undefined} aria-pressed={item.id === "menu" ? undefined : selected} className={className} onClick={item.action}>{icon}{label}</button>;
      // Настоящая ссылка: обычный клик переключает экран без перезагрузки,
      // а средний клик / «открыть в новой вкладке» открывает раздел по адресу.
      return <a key={item.id} href={href} title={item.label} aria-label={item.label} aria-controls={item.id === "chat" ? "herder-chat-list" : undefined} aria-expanded={item.id === "chat" ? props.chatsOpen : undefined} aria-current={selected ? "page" : undefined} className={className} onClick={(event) => { if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); item.action(); }}>{icon}{label}</a>;
    })}</div>
    <span className="codex-navigation-mark" title="Agent Herder">AH</span>
  </nav>;
}
