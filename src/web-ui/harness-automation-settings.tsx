import * as React from "react";
import type { AutopilotHarness } from "../autopilot/session-store.js";

const HARNESSES = [
  ["codex", "Codex"], ["zcode", "ZCode"], ["claude", "Claude Code"],
  ["opencode", "OpenCode"], ["hermes", "Hermes"], ["qoder", "Qoder"],
  ["fast-agent", "Fast Agent"], ["chatgpt", "ChatGPT"],
] as const;

export function withAutopilotHarness<T extends { harnesses: AutopilotHarness[] }>(policy: T, harness: AutopilotHarness, enabled: boolean): T {
  return { ...policy, harnesses: enabled ? [...new Set([...policy.harnesses, harness])] : policy.harnesses.filter((item) => item !== harness) };
}

/** One mechanism per settings page; each harness keeps its independent switch. */
export function HarnessAutomationSettings({ mode, available, enabled, loaded, saving, onToggle }: {
  mode: "autopilot" | "autocontinue";
  available: ReadonlySet<string>;
  enabled: ReadonlySet<string>;
  loaded?: ReadonlySet<string>;
  saving?: string;
  onToggle: (harness: string) => void;
}) {
  const label = mode === "autopilot" ? "Автопилот" : "Автопродолжение";
  const renderRow = ([id, name]: (typeof HARNESSES)[number]) => {
      const supported = available.has(id);
      const ready = supported && (!loaded || loaded.has(id));
      const checked = ready && enabled.has(id);
      return <section className="harness-setting-row" key={id} aria-label={`${label} · ${name}`}>
        <div><strong>{name}</strong><small id={`${mode}-${id}-status`}>{!supported ? "Пока не поддерживается" : saving === id ? "Сохраняю…" : !ready ? "Загружаю…" : checked ? "Разрешено" : "Выключено"}</small></div>
        <button className={`switch-control ${checked ? "enabled" : ""}`} role="switch" aria-label={`${label} · ${name}`} aria-checked={checked} aria-describedby={`${mode}-${id}-status`} disabled={!ready || Boolean(saving)} onClick={() => onToggle(id)}><span /></button>
      </section>;
  };
  const unavailable = HARNESSES.filter(([id]) => !available.has(id));
  return <div className="harness-automation-list" aria-label={`${label} по средам`}>
    {HARNESSES.filter(([id]) => available.has(id)).map(renderRow)}
    {!!unavailable.length && <details className="settings-advanced"><summary>Пока недоступные агенты ({unavailable.length})</summary>{unavailable.map(renderRow)}</details>}
  </div>;
}
