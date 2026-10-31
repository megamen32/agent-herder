import * as React from "react";

/**
 * Быстрые фильтры списка сессий: то, что владелец переключает каждый день,
 * — без похода в «Настройки списка».
 *
 * Каждая кнопка показывает своё состояние (aria-pressed) и своё число, и
 * переключение сразу меняет список. Счётчик «Сейчас работают» и список
 * обязаны говорить одно и то же, поэтому у фильтра есть и число, и подпись.
 */

/** Какой срез сессий показывает список. */
export type SessionStatusFilter = "working" | "waiting" | "all";

export type SessionQuickFilterCounts = {
  /** Сессии, которые сейчас работают или ждут ввода. */
  working: number;
  /** Сессии, которые стоят и готовы принять задачу. */
  waiting: number;
  /** Сколько сессий каждой среды в загруженном списке. */
  byHarness: { harness: string; count: number }[];
  /** Сколько сессий загружено всего. */
  total: number;
};

export type SessionQuickFiltersProps = {
  counts: SessionQuickFilterCounts;
  status: SessionStatusFilter;
  onStatusChange: (status: SessionStatusFilter) => void;
  /** Выбранная среда фильтра: пустая строка — все среды. */
  harness: string;
  onHarnessChange: (harness: string) => void;
};

/** Короткая подпись среды для кнопки фильтра. */
export function harnessLabel(harness: string): string {
  const known: Record<string, string> = {
    codex: "Codex",
    zcode: "ZCode",
    opencode: "OpenCode",
    "minimax-code": "MiniMax Code",
    chatgpt: "ChatGPT",
    "browser-chat": "Browser chats (ZAI)",
    hermes: "Hermes",
    fastagent: "Fast Agent",
    qoder: "Qoder",
    claude: "Claude",
  };
  return known[harness] || harness;
}

export function SessionQuickFilters({ counts, status, onStatusChange, harness, onHarnessChange }: SessionQuickFiltersProps) {
  const buttons: { key: string; label: string; count?: number; pressed: boolean; onClick: () => void }[] = [
    { key: "working", label: "Работают", count: counts.working, pressed: status === "working", onClick: () => onStatusChange("working") },
    { key: "waiting", label: "Ждут задачи", count: counts.waiting, pressed: status === "waiting", onClick: () => onStatusChange("waiting") },
    { key: "all", label: "Все", count: counts.total, pressed: status === "all", onClick: () => onStatusChange("all") },
  ];
  for (const entry of counts.byHarness) {
    if (!entry.harness) continue;
    buttons.push({
      key: `harness:${entry.harness}`,
      label: harnessLabel(entry.harness),
      count: entry.count,
      pressed: harness === entry.harness,
      onClick: () => onHarnessChange(harness === entry.harness ? "" : entry.harness),
    });
  }
  return <div className="session-quick-filters" role="group" aria-label="Быстрый фильтр сессий">
    {buttons.map((button) => <button key={button.key} type="button" className={`session-quick-chip ${button.pressed ? "pressed" : ""}`}
      aria-pressed={button.pressed} onClick={button.onClick} title={button.pressed ? `${button.label}: фильтр включён` : `Показать только: ${button.label}`}>
      <span>{button.label}</span>{button.count !== undefined && <b>{button.count}</b>}
    </button>)}
  </div>;
}
