import * as React from "react";
import type { AutopilotHarness } from "../autopilot/session-store.js";

type ContinuationHarness = "codex" | "zcode";
const HARNESSES = [
  { id: "codex", label: "Codex", autopilot: true, continuation: true },
  { id: "zcode", label: "ZCode", autopilot: true, continuation: true },
  { id: "claude", label: "Claude Code", autopilot: true, continuation: false },
  { id: "opencode", label: "OpenCode", autopilot: true, continuation: false },
  { id: "hermes", label: "Hermes", autopilot: true, continuation: false },
  { id: "qoder", label: "Qoder", autopilot: false, continuation: false },
  { id: "fast-agent", label: "Fast Agent", autopilot: false, continuation: false },
  { id: "chatgpt", label: "ChatGPT", autopilot: false, continuation: false },
] as const;

/** Preserve every unrelated policy field and harness when changing one switch. */
export function withAutopilotHarness<T extends { harnesses: AutopilotHarness[] }>(policy: T, harness: AutopilotHarness, enabled: boolean): T {
  return { ...policy, harnesses: enabled
    ? [...new Set([...policy.harnesses, harness])]
    : policy.harnesses.filter((item) => item !== harness) };
}

export function HarnessAutomationSettings({ autopilot, continuation, autopilotSaving, continuationSaving, autopilotError, continuationError, onAutopilotToggle, onContinuationToggle, onOpenAutopilot, onOpenContinuation }: {
  autopilot?: { enabled: boolean; harnesses: AutopilotHarness[] };
  continuation: Partial<Record<ContinuationHarness, { enabled: boolean }>>;
  autopilotSaving?: AutopilotHarness;
  continuationSaving?: ContinuationHarness;
  autopilotError?: string;
  continuationError?: string;
  onAutopilotToggle: (harness: AutopilotHarness) => void;
  onContinuationToggle: (harness: ContinuationHarness) => void;
  onOpenAutopilot: () => void;
  onOpenContinuation: () => void;
}) {
  return <section className="global-autopilot-card" aria-label="Автоматизация по средам">
    <div className="global-autopilot-head"><div><span className="eyebrow">АВТОМАТИЗАЦИЯ</span><h3>Отдельно для каждой среды</h3><p>Автопродолжение восстанавливает работу после сбоя. Автопилот оценивает незавершённую задачу и выбирает следующий шаг.</p></div></div>
    <p className="settings-help">Каждый переключатель применяется сразу только к своей среде и своему механизму. Настройки отдельной сессии могут его переопределить.</p>
    <p className="settings-help harness-master-help">{autopilot ? autopilot.enabled ? "Общий автопилот включён: он работает в выбранных ниже средах." : "Общий автопилот выключен: выбор среды сохранится, но начнёт действовать после включения общего режима." : "Загружаю общий режим автопилота…"} Автопродолжение использует настройку среды вместо общего режима восстановления. Настройка отдельной сессии имеет приоритет.</p>
    <div className="harness-automation-list">
      {HARNESSES.map((harness) => {
        const recovery = harness.continuation ? continuation[harness.id] : undefined;
        const pilot = harness.autopilot && Boolean(autopilot?.harnesses.includes(harness.id));
        const recoveryId = `harness-continuation-${harness.id}`;
        const pilotId = `harness-autopilot-${harness.id}`;
        return <section className="harness-automation-row" aria-label={`Автоматизация · ${harness.label}`} key={harness.id}>
          <h4>{harness.label}</h4>
          <div className="harness-automation-cell">
            <strong>Автопродолжение</strong>
            <button className={`switch-control ${recovery?.enabled ? "enabled" : ""}`} role="switch" aria-label={`Автопродолжение · ${harness.label}`} aria-checked={Boolean(recovery?.enabled)} disabled={!harness.continuation || !recovery || Boolean(continuationSaving)} aria-describedby={recoveryId} onClick={() => { if (harness.continuation) onContinuationToggle(harness.id); }}><span /></button>
            <small id={recoveryId}>{!harness.continuation ? "Восстановление после сбоя пока не поддерживается" : continuationSaving === harness.id ? "Сохраняю…" : !recovery ? "Загружаю…" : recovery.enabled ? "Включено" : "Выключено"}</small>
          </div>
          <div className="harness-automation-cell">
            <strong>Автопилот</strong>
            <button className={`switch-control ${pilot ? "enabled" : ""}`} role="switch" aria-label={`Автопилот · ${harness.label}`} aria-checked={pilot} disabled={!harness.autopilot || !autopilot || Boolean(autopilotSaving)} aria-describedby={pilotId} onClick={() => { if (harness.autopilot) onAutopilotToggle(harness.id); }}><span /></button>
            <small id={pilotId}>{!harness.autopilot ? "Автопилот пока не поддерживается" : autopilotSaving === harness.id ? "Сохраняю…" : !autopilot ? "Загружаю…" : pilot && !autopilot.enabled ? "Разрешён · общий автопилот выключен" : pilot ? "Включён" : "Выключен"}</small>
          </div>
        </section>;
      })}
    </div>
    {continuationError && <p className="autopilot-error" role="alert">Автопродолжение: {continuationError}</p>}
    {autopilotError && <p className="autopilot-error" role="alert">Автопилот: {autopilotError}</p>}
    <div className="harness-automation-details"><button className="quiet-button" onClick={onOpenContinuation}>Общие параметры автопродолжения →</button><button className="quiet-button" onClick={onOpenAutopilot}>Общие параметры автопилота →</button></div>
  </section>;
}
