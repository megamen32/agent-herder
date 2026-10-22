import React from "react";

/**
 * What the node of the herder really has.
 *
 * The section reads the routes that already exist: the catalog of the models
 * of a harness, the hosts of the fleet and the sessions of the fleet. It
 * starts nothing: a read of a catalog and a read of a list are reads.
 *
 * When a route does not answer, the section says why and offers the action
 * that is possible here — instead of an empty state that looks like a
 * finished answer.
 */

export const MODELS_ENDPOINT = "/api/models";
export const FLEET_HOSTS_ENDPOINT = "/api/fleet/hosts";
export const FLEET_SESSIONS_ENDPOINT = "/api/fleet/sessions";

export type RuntimeModels = { ok: boolean; harness: string; models: string[]; error?: string };
export type RuntimeFleet = { ok: boolean; hosts: string[]; sessions: number; error?: string };

/** The models of a harness, as the catalog answers them. */
export function modelsOf(body: unknown): string[] {
  if (Array.isArray(body)) {
    return body.map((item) => {
      if (typeof item === "string") return item;
      if (item && typeof item === "object") {
        const record = item as Record<string, unknown>;
        const id = record.id ?? record.model ?? record.name;
        if (typeof id === "string") return id;
      }
      return String(item);
    });
  }
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    for (const key of ["models", "items", "data"]) {
      if (Array.isArray(record[key])) return modelsOf(record[key]);
    }
  }
  return [];
}

/** The hosts of the fleet, as the route answers them. */
export function hostsOf(body: unknown): string[] {
  if (!body || typeof body !== "object") return [];
  const record = body as Record<string, unknown>;
  const hosts = record.hosts;
  if (!Array.isArray(hosts)) return [];
  return hosts.map((host) => {
    if (typeof host === "string") return host;
    if (host && typeof host === "object") {
      const item = host as Record<string, unknown>;
      const name = item.hostId ?? item.host ?? item.id ?? item.name;
      return typeof name === "string" ? name : "узел без имени";
    }
    return "узел без имени";
  });
}

/** The number of the sessions of the fleet, as the route answers them. */
export function sessionsOf(body: unknown): number {
  if (!body || typeof body !== "object") return 0;
  const record = body as Record<string, unknown>;
  if (Array.isArray(record.sessions)) return record.sessions.length;
  if (typeof record.total === "number") return record.total;
  if (typeof record.sessionCount === "number") return record.sessionCount;
  return 0;
}

export function RuntimeSection(): React.ReactElement {
  const [harness, setHarness] = React.useState("opencode");
  const [models, setModels] = React.useState<RuntimeModels | null>(null);
  const [fleet, setFleet] = React.useState<RuntimeFleet | null>(null);
  const [busy, setBusy] = React.useState(false);

  const readModels = async (): Promise<void> => {
    setBusy(true);
    try {
      const response = await fetch(`${MODELS_ENDPOINT}?harness=${encodeURIComponent(harness.trim())}`);
      const text = await response.text();
      let body: unknown = {};
      try {
        body = text ? JSON.parse(text) : {};
      } catch {
        body = {};
      }
      if (!response.ok) {
        const reason = (body as { error?: string }).error ?? `сервер ответил ${response.status}`;
        setModels({ ok: false, harness: harness.trim(), models: [], error: reason });
        return;
      }
      setModels({ ok: true, harness: harness.trim(), models: modelsOf(body) });
    } catch (cause) {
      setModels({ ok: false, harness: harness.trim(), models: [], error: (cause as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const readFleet = async (): Promise<void> => {
    setBusy(true);
    try {
      const hostsResponse = await fetch(FLEET_HOSTS_ENDPOINT);
      const hostsText = await hostsResponse.text();
      let hostsBody: unknown = {};
      try {
        hostsBody = hostsText ? JSON.parse(hostsText) : {};
      } catch {
        hostsBody = {};
      }
      if (!hostsResponse.ok) {
        const reason = (hostsBody as { error?: string }).error ?? `сервер ответил ${hostsResponse.status}`;
        setFleet({ ok: false, hosts: [], sessions: 0, error: reason });
        return;
      }
      const sessionsResponse = await fetch(`${FLEET_SESSIONS_ENDPOINT}?limit=50`);
      const sessionsText = await sessionsResponse.text();
      let sessionsBody: unknown = {};
      try {
        sessionsBody = sessionsText ? JSON.parse(sessionsText) : {};
      } catch {
        sessionsBody = {};
      }
      if (!sessionsResponse.ok) {
        const reason = (sessionsBody as { error?: string }).error ?? `сервер ответил ${sessionsResponse.status}`;
        setFleet({ ok: false, hosts: hostsOf(hostsBody), sessions: 0, error: reason });
        return;
      }
      setFleet({ ok: true, hosts: hostsOf(hostsBody), sessions: sessionsOf(sessionsBody) });
    } catch (cause) {
      setFleet({ ok: false, hosts: [], sessions: 0, error: (cause as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="herder-settings-block" aria-label="Модели и узлы">
      <h2>Модели и узлы</h2>
      <p className="herder-settings-hint">
        Каталог моделей среды и состояние флота. Чтение каталога и списка не запускает ни одного исполнителя.
      </p>

      <div className="herder-settings-row">
        <label className="herder-settings-field">
          <span>Среда исполнения</span>
          <input
            value={harness}
            onChange={(event) => setHarness(event.target.value)}
            placeholder="opencode"
            aria-label="Среда исполнения для каталога моделей"
          />
        </label>
      </div>
      <div className="herder-settings-actions">
        <button type="button" className="herder-settings-button" onClick={() => { void readModels(); }} disabled={busy}>
          Показать модели среды
        </button>
        <button type="button" className="herder-settings-button" onClick={() => { void readFleet(); }} disabled={busy}>
          Показать узлы и сессии флота
        </button>
      </div>

      {models ? (
        models.ok ? (
          models.models.length ? (
            <table className="herder-settings-table">
              <thead>
                <tr><th>Модель</th><th>Среда</th></tr>
              </thead>
              <tbody>
                {models.models.map((model) => (
                  <tr key={model}><td><code>{model}</code></td><td>{models.harness}</td></tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="herder-settings-hint">Среда {models.harness} не назвала ни одной модели.</p>
          )
        ) : (
          <p className="herder-settings-error" role="alert">Каталог моделей не прочитан: {models.error}</p>
        )
      ) : null}

      {fleet ? (
        fleet.ok ? (
          <>
            <p className="herder-settings-state-line" role="status">
              Узлов в флоте: {fleet.hosts.length}. Сессий в выборке флота: {fleet.sessions}.
            </p>
            {fleet.hosts.length ? (
              <table className="herder-settings-table">
                <thead>
                  <tr><th>Узел</th></tr>
                </thead>
                <tbody>
                  {fleet.hosts.map((host) => (
                    <tr key={host}><td>{host}</td></tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="herder-settings-hint">Флот не назвал ни одного узла.</p>
            )}
          </>
        ) : (
          <p className="herder-settings-error" role="alert">Флот не прочитан: {fleet.error}</p>
        )
      ) : null}
    </section>
  );
}
