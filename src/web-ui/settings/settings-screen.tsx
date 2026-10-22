import React from "react";

import { ProjectsSettings } from "../projects-settings.js";
import {
  baseVersions,
  loadSettings,
  loadSettingsAudit,
  recordValue,
  recordsOf,
  rollbackSetting,
  saveSettings,
  type SettingsAuditRecord,
  type SettingsChanges,
  type SettingsRecord,
  type SettingsView,
} from "./settings-client.js";
import { StopControl } from "./stop-control.js";
import { ConnectionsSection } from "./connections-section.js";
import { RuntimeSection } from "./runtime-section.js";
import { ProjectsSection } from "./projects-section.js";
import { FleetConfirmation } from "./fleet-confirmation.js";
import { CommonSettingsSection } from "./common-settings-section.js";
import "./settings.css";

/**
 * The screen of the settings of the herder.
 *
 * The screen shows what the owner needs: the values of the settings of the
 * product, the state of their application, the journal of the changes and the
 * way back. A secret is never shown: the owner types it once and the screen
 * keeps only the fact that it is set and its fingerprint.
 *
 * The screen is split into two tabs: the settings of the herder and the
 * models of the projects. The second tab is the screen of the Projects
 * contour; the herder does not touch it, it only gives it a place.
 */

export type SettingsTab = "herder" | "projects";

/**
 * The one line that says how the state of a setting is in effect.
 *
 * The state itself is one word — «Записано», «Применено», «Применено
 * частично», «Узел недоступен» — and the application is one line. The two say
 * different things, so the screen never repeats one of them twice.
 */
export function applicationText(confirmed: { state: string; applyMode: string; requiresRestart: boolean }): string {
  if (confirmed.state === "Применено") return "работает сейчас";
  if (confirmed.applyMode === "после перезапуска") return "применится после перезапуска";
  if (confirmed.applyMode === "к новым задачам") return "применится к новым задачам";
  return "применится сразу";
}

/** The state of a setting, colored by its meaning in both themes. */
export function stateClass(state: string): string {
  const base = "herder-settings-state";
  if (state === "Применено") return `${base} herder-settings-state-applied`;
  if (state === "Узел недоступен") return `${base} herder-settings-state-unreachable`;
  if (state === "Применяется") return `${base} herder-settings-state-running`;
  return `${base} herder-settings-state-pending`;
}

/** The routes of the projects of the launch policy, as the policy names them. */
export function projectRoutes(policy: unknown): Array<{ project: string; profileId?: string }> {
  if (!policy || typeof policy !== "object") return [];
  const routes = (policy as Record<string, unknown>).projectRoutes;
  if (!Array.isArray(routes)) return [];
  return routes.map((route) => {
    const record = (route ?? {}) as Record<string, unknown>;
    const project = typeof record.project === "string" ? record.project : "маршрут без имени";
    const profileId = typeof record.profileId === "string" && record.profileId.trim() ? record.profileId.trim() : undefined;
    return { project, ...(profileId ? { profileId } : {}) };
  });
}

export function SettingsScreen({
  tab,
  onTabChange,
  onOpenLaunchSettings,
}: {
  tab: SettingsTab;
  onTabChange: (tab: SettingsTab) => void;
  onOpenLaunchSettings: () => void;
}): React.ReactElement {
  return (
    <section className="herder-settings-page" aria-label="Настройки herder">
      <header className="herder-settings-header">
        <div>
          <h1>Настройки herder</h1>
          <p>Все настройки контура — из одного места: значения, применение, журнал изменений и откат.</p>
        </div>
        <div className="herder-settings-tabs" role="tablist" aria-label="Разделы настроек">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "herder"}
            className={tab === "herder" ? "herder-settings-tab herder-settings-tab-active" : "herder-settings-tab"}
            onClick={() => onTabChange("herder")}
          >
            Настройки herder
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "projects"}
            className={tab === "projects" ? "herder-settings-tab herder-settings-tab-active" : "herder-settings-tab"}
            onClick={() => onTabChange("projects")}
          >
            Модели проекта
          </button>
        </div>
      </header>
      <div className="herder-settings-panel" role="tabpanel">
        {tab === "herder" ? <HerderSettings onOpenLaunchSettings={onOpenLaunchSettings} /> : <ProjectsSettings onOpenLaunchSettings={onOpenLaunchSettings} />}
      </div>
    </section>
  );
}

/** The settings of the herder itself. */
export function HerderSettings({ onOpenLaunchSettings }: { onOpenLaunchSettings: () => void }): React.ReactElement {
  const [view, setView] = React.useState<SettingsView | null>(null);
  const [audit, setAudit] = React.useState<SettingsAuditRecord[]>([]);
  const [drafts, setDrafts] = React.useState<Record<string, string>>({});
  const [secretDrafts, setSecretDrafts] = React.useState<Record<string, string>>({});
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [difference, setDifference] = React.useState<string | null>(null);

  const reload = React.useCallback(async () => {
    try {
      const [settings, journal] = await Promise.all([loadSettings(), loadSettingsAudit(50)]);
      setView(settings);
      setAudit(journal);
      setError(null);
    } catch (cause) {
      setError((cause as Error).message);
    }
  }, []);

  // The screen reads only the settings and the journal: nothing here starts
  // an executor of the herder.
  React.useEffect(() => { void reload(); }, [reload]);

  const envRecords = view ? recordsOf(view, "herder.env") : [];
  const nodeRecords = view ? recordsOf(view, "node-config") : [];

  const save = async (changes: SettingsChanges, ids: string[]): Promise<void> => {
    if (!view) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    setDifference(null);
    const result = await saveSettings(
      ids.length > 0 ? { ...changes, baseVersion: baseVersions(view, ids) } : changes,
      view.etag,
    );
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      if (result.difference?.length) {
        setDifference(result.difference
          .map((item) => `${item.id}: было версии ${item.baseVersion}, стало ${item.currentVersion}${item.changedBy ? ` (${item.changedBy})` : ""}`)
          .join("; "));
      }
      await reload();
      return;
    }
    setView(result.view);
    // The value of a secret leaves the form with the answer: it is never
    // kept in the state of the screen.
    setSecretDrafts({});
    setNotice("Записано.");
    await reload();
  };

  const saveEnvironment = async (): Promise<void> => {
    const environment: Record<string, string | null> = {};
    const ids: string[] = [];
    for (const [key, value] of Object.entries(drafts)) {
      environment[key] = value;
      ids.push(`herder.env/${key}`);
    }
    for (const [key, value] of Object.entries(secretDrafts)) {
      if (!value) continue;
      environment[key] = value;
      ids.push(`herder.env/${key}`);
    }
    if (Object.keys(environment).length === 0) return;
    await save({ environment }, ids);
    setDrafts({});
  };

  const revokeSecret = async (key: string): Promise<void> => {
    await save({ secrets: { [key]: { operation: "revoke" } } }, []);
  };

  const checkSecret = async (key: string, fingerprint?: string): Promise<void> => {
    if (!view) return;
    const result = await saveSettings({ secrets: { [key]: { operation: "check", ...(fingerprint ? { fingerprint } : {}) } } }, view.etag);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    const body = result.view as unknown as { results?: Record<string, { state?: string; matches?: boolean; expired?: boolean }> };
    const check = body.results?.[key];
    setNotice(check
      ? `Проверка ${key}: ${check.state === "ok" ? "тот же ключ, что вы видели" : check.state === "expired" ? "срок истёк" : check.state === "changed" ? "ключ изменился" : "ключ не задан"}`
      : "Проверка выполнена.");
    await reload();
  };

  const rollback = async (record: SettingsAuditRecord): Promise<void> => {
    if (!view) return;
    const result = await rollbackSetting(record.entity, record.key, view.etag);
    if (!result.ok) {
      setError(result.error);
      await reload();
      return;
    }
    setView(result.view);
    setNotice(`Откат выполнен: ${record.key}`);
    await reload();
  };

  if (!view) {
    return (
      <div className="herder-settings-block">
        {error ? <p className="herder-settings-error" role="alert">{error}</p> : <p className="herder-settings-hint">Читаю настройки…</p>}
      </div>
    );
  }

  return (
    <div className="herder-settings-content">
      {error ? <p className="herder-settings-error" role="alert">{error}</p> : null}
      {difference ? <p className="herder-settings-notice" role="status">Разница: {difference}</p> : null}
      {notice ? <p className="herder-settings-notice" role="status">{notice}</p> : null}

      <section className="herder-settings-block" aria-label="Переменные продукта herder">
        <h2>Переменные продукта herder</h2>
        <p className="herder-settings-hint">
          Источник — {view.environment.path}. {view.environment.applies ?? ""}
        </p>
        <table className="herder-settings-table">
          <thead>
            <tr><th>Настройка</th><th>Значение</th><th>Состояние</th><th>Действия</th></tr>
          </thead>
          <tbody>
            {envRecords.map((record) => {
              const key = record.id.slice("herder.env/".length);
              const secret = record.desired.value === null && record.desired.fingerprint !== undefined;
              // A common setting is changed here once and reaches every node
              // that takes the common settings.
              const common = (view.commonSettings?.keys ?? []).includes(key);
              return (
                <tr key={record.id}>
                  <td>
                    <strong>{record.humanName}</strong>
                    {common ? <span className="herder-settings-badge">общая настройка</span> : null}
                    <span className="herder-settings-action">{record.action}</span>
                    <details className="herder-settings-details">
                      <summary>Технические подробности</summary>
                      <code>{record.id}</code> · область {record.scope.kind} · источник {record.source} · ревизия {record.desired.desired_revision} · в силе{" "}
                        {record.confirmed.applied_revision === null ? "не подтверждена, ждёт перезапуска" : record.confirmed.applied_revision}
                    </details>
                  </td>
                  <td>
                    {secret ? (
                      <span className="herder-settings-secret">
                        {record.desired.fingerprint ? `задан · ${record.desired.fingerprint}` : "не задан"}
                      </span>
                    ) : (
                      <input
                        className="herder-settings-input"
                        value={drafts[key] ?? recordValue(record)}
                        onChange={(event) => setDrafts((previous) => ({ ...previous, [key]: event.target.value }))}
                        aria-label={`${record.humanName}: значение`}
                      />
                    )}
                  </td>
                  <td>
                    <span className={stateClass(record.confirmed.state)}>{record.confirmed.state}</span>
                    <span className="herder-settings-hint">{applicationText(record.confirmed)}</span>
                    {record.changedBy ? <span className="herder-settings-hint">{record.changedBy} · {record.changedAt}</span> : null}
                  </td>
                  <td className="herder-settings-actions">
                    {secret ? (
                      <>
                        <input
                          type="password"
                          className="herder-settings-input"
                          autoComplete="new-password"
                          value={secretDrafts[key] ?? ""}
                          onChange={(event) => setSecretDrafts((previous) => ({ ...previous, [key]: event.target.value }))}
                          placeholder="новое значение"
                          aria-label={`${record.humanName}: новое значение`}
                        />
                        <button type="button" className="herder-settings-button" disabled={busy || !secretDrafts[key]} onClick={() => { void saveEnvironment(); }}>Заменить</button>
                        <button type="button" className="herder-settings-button" disabled={busy} onClick={() => { void checkSecret(key, record.desired.fingerprint); }}>Проверить</button>
                        <button type="button" className="herder-settings-button" disabled={busy} onClick={() => { void revokeSecret(key); }}>Отозвать</button>
                      </>
                    ) : (
                      <>
                        <button type="button" className="herder-settings-button" disabled={busy || !(key in drafts)} onClick={() => { void saveEnvironment(); }}>Сохранить</button>
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <section className="herder-settings-block" aria-label="Конфигурация узла">
        <h2>Конфигурация узла</h2>
        <p className="herder-settings-hint">
          {view.fleetNode.present
            ? `Файл узла: ${view.fleetNode.path}. Идентичность узла и отпечаток источника — параметры запуска, формой не меняются.`
            : `Узла нет: ${view.fleetNode.note ?? view.fleetNode.path}`}
        </p>
        <table className="herder-settings-table">
          <thead>
            <tr><th>Настройка</th><th>Значение</th><th>Состояние</th></tr>
          </thead>
          <tbody>
            {nodeRecords.map((record) => (
              <tr key={record.id}>
                <td>
                  <strong>{record.humanName}</strong>
                  <span className="herder-settings-action">{record.action}</span>
                </td>
                <td><code>{recordValue(record)}</code></td>
                <td>
                  <span className={stateClass(record.confirmed.state)}>{record.confirmed.state}</span>
                  <span className="herder-settings-hint">{applicationText(record.confirmed)}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="herder-settings-block" aria-label="Политика запуска">
        <h2>Политика запуска</h2>
        {view.launchPolicy.state === "valid" ? (
          <>
            <p className="herder-settings-hint">
              Политика живёт в своём разделе и меняется там: {view.launchPolicy.write ?? view.launchPolicy.endpoint}
            </p>
            <table className="herder-settings-table">
              <thead>
                <tr><th>Параметр</th><th>Значение</th></tr>
              </thead>
              <tbody>
                {Object.entries((view.launchPolicy.policy ?? {}) as Record<string, unknown>).map(([key, value]) => (
                  <tr key={key}>
                    <td><code>{key}</code></td>
                    <td><code>{typeof value === "object" ? JSON.stringify(value) : String(value)}</code></td>
                  </tr>
                ))}
              </tbody>
            </table>
            {projectRoutes(view.launchPolicy.policy).length ? (
              <table className="herder-settings-table">
                <thead>
                  <tr><th>Маршрут проекта</th><th>Профиль ИИ</th></tr>
                </thead>
                <tbody>
                  {projectRoutes(view.launchPolicy.policy).map((route) => (
                    <tr key={route.project}>
                      <td>{route.project}</td>
                      <td>
                        {route.profileId ? (
                          <>
                            <code>{route.profileId}</code>{" "}
                            {/* The profile lives in the herder: the link opens
                                it here instead of editing it in two places. */}
                            <a href="#herder-projects">Открыть профиль в Herder</a>
                          </>
                        ) : (
                          <span>профиль не назван</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}
          </>
        ) : (
          <div className="herder-settings-not-configured">
            <p>Политика запуска на этом узле не настроена.</p>
            {/* The reason of the absence is named: an empty state that looks
                like a finished answer is not an answer. */}
            <p className="herder-settings-hint">
              Состояние: {view.launchPolicy.state}
              {view.launchPolicy.error ? ` — ${view.launchPolicy.error}` : ""}
            </p>
            <button type="button" className="herder-settings-button" onClick={onOpenLaunchSettings}>
              Настройки запуска новых сессий →
            </button>
          </div>
        )}
      </section>

      <ProjectsSection view={view} onSave={save} />
      <RuntimeSection />
      <ConnectionsSection />
      <StopControl />

      <CommonSettingsSection />

      <FleetConfirmation />

      <section className="herder-settings-block" aria-label="Журнал изменений">
        <h2>Журнал изменений</h2>
        <button type="button" className="herder-settings-button" onClick={() => { void reload(); }}>Обновить журнал</button>
        <table className="herder-settings-table">
          <thead>
            <tr><th>Когда</th><th>Кто</th><th>Что</th><th>Действие</th></tr>
          </thead>
          <tbody>
            {audit.map((record) => (
              <tr key={record.id}>
                <td>{record.at}</td>
                <td>{record.actor}</td>
                <td>
                  <code>{record.key}</code>
                  <span className="herder-settings-hint">
                    {record.kind === "secret"
                      ? ` секрет: ${record.after.configured ? "задан" : "не задан"} · ${record.after.fingerprint ?? "—"}`
                      : ` ${JSON.stringify(record.before.value ?? null)} → ${JSON.stringify(record.after.value ?? null)}`}
                  </span>
                </td>
                <td>
                  <button type="button" className="herder-settings-button" disabled={busy} onClick={() => { void rollback(record); }}>Откатить</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
