import React from "react";

/**
 * The connection of the herder to the Notice Place.
 *
 * The integration is isolated: the herder keeps its own part of the
 * connection in its own store, and the panel only shows it. The token of the
 * service account is write-only: it goes to the file of the product once and
 * never comes back to the browser — the panel shows the fingerprint only.
 *
 * The check of the connection reads the state of the center: it starts no
 * executor of the herder and it creates no event in the center. The panel
 * shows the three answers apart — the center answered, the center took the
 * credential, the center and the herder speak one contract — and it never
 * promises a compatibility it did not see.
 *
 * The revocation is shown as it is: the record of the herder says that the
 * connection is revoked, and the probe of the revocation asks the route of
 * the launch whether it refuses the center now. The probe cannot authorize
 * anything and starts nothing.
 */

export type ConnectionRecord = {
  centerUrl?: string;
  purpose?: string;
  permissions?: string[];
  state?: "connected" | "revoked";
  connectedAt?: string;
  revokedAt?: string | null;
  tokenFingerprint?: string;
};

export type ConnectionCheck = {
  reachable?: boolean;
  authorized?: boolean;
  compatible?: boolean;
  detail?: string;
  status?: number;
  checkedAt?: string;
  centerSchema?: string;
  centerStatus?: string;
  purposeAccepted?: boolean;
  project?: string;
};

export const CONNECTIONS_ENDPOINT = "/api/settings/connections";
export const CONNECTION_CHECK_ENDPOINT = "/api/settings/connections/check";
export const CONNECTION_REVOKE_ENDPOINT = "/api/settings/connections/revoke";
/** The route of the launch: the probe of the revocation asks it and nothing else. */
export const LAUNCH_ENDPOINT = "/api/automation/project-launch";
/** The purpose of the analysis of an incident: the route of the launch takes it and nothing else. */
export const CONNECTION_PURPOSE = "noticeplace.health-analysis";

/** The state of the connection, in one line. */
export function connectionStateText(connection: ConnectionRecord | null): string {
  if (!connection) return "Подключение к центру уведомлений не настроено.";
  if (connection.state === "revoked") {
    return `Подключение отозвано${connection.revokedAt ? ` ${connection.revokedAt}` : ""}. Herder больше не проверяет связь с центром.`;
  }
  return `Подключено к ${connection.centerUrl ?? "центру уведомлений"}, цель — ${connection.purpose ?? "не названа"}.`;
}

/** The color of the state line, by the meaning of the state in both themes. */
export function connectionStateClass(connection: ConnectionRecord | null): string {
  const base = "herder-settings-state";
  if (!connection) return `${base} ${base}-pending`;
  return connection.state === "revoked" ? `${base} ${base}-error` : `${base} ${base}-applied`;
}

/** What the check found, in words. */
export function checkText(check: ConnectionCheck | null): string {
  if (!check) return "";
  const parts = [
    check.reachable ? "центр ответил" : "центр не ответил",
    check.authorized ? "авторизация принята" : "авторизация не подтверждена",
    check.compatible ? "совместимость подтверждена" : "совместимость не подтверждена",
  ];
  return `${parts.join(" · ")}. ${check.detail ?? ""}`.trim();
}

/** What the answer of the check says about the connection, in one line. */
export function checkEvidenceText(check: ConnectionCheck | null): string {
  if (!check) return "";
  const parts: string[] = [];
  if (check.centerSchema) parts.push(`контракт центра: ${check.centerSchema}`);
  if (check.centerStatus) parts.push(`состояние центра: ${check.centerStatus}`);
  if (check.project) parts.push(`проект: ${check.project}`);
  if (check.checkedAt) parts.push(`проверено ${check.checkedAt}`);
  return parts.join(" · ");
}

/** What the route of the launch answered to the probe of the revocation. */
export type RevokeProbe = { status: number; code?: string; error?: string };

/**
 * The probe that shows whether the revocation is in force.
 *
 * The probe asks the herder's own route of the launch with a bearer that can
 * never authorize and with a body that the route refuses before any dispatch:
 * no executor starts, no session opens and nothing is created in the center.
 * The answer says whether the route refuses by the revoked connection or only
 * by the token.
 */
export async function probeRevokedLaunch(fetchImpl: typeof fetch = fetch): Promise<RevokeProbe> {
  try {
    const response = await fetchImpl(LAUNCH_ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer herder-panel-revocation-probe",
      },
      body: JSON.stringify({ purpose: CONNECTION_PURPOSE }),
    });
    let body: { code?: string; error?: string } = {};
    try {
      body = (await response.json()) as { code?: string; error?: string };
    } catch {
      body = {};
    }
    return { status: response.status, code: body.code, error: body.error };
  } catch (cause) {
    return { status: 0, error: (cause as Error).message };
  }
}

/** What the probe of the revocation says, in words. */
export function revokeEffectText(probe: RevokeProbe | null): string {
  if (!probe) return "";
  if (probe.status === 0) return "Маршрут запуска не ответил на пробу отзыва.";
  if (probe.code === "connection_revoked") {
    return "Отзыв действует: маршрут запуска отказал центру по отозванному подключению — центр больше не получает разрешение на анализ инцидента.";
  }
  return "Отзыв записан в herder, но маршрут запуска анализа инцидента не смотрит на состояние подключения: центр ещё получает разрешение. Маршрут должен отказывать по состоянию подключения.";
}

export function ConnectionsSection(): React.ReactElement {
  const [connection, setConnection] = React.useState<ConnectionRecord | null>(null);
  const [centerUrl, setCenterUrl] = React.useState("");
  const [purpose, setPurpose] = React.useState("");
  const [permissions, setPermissions] = React.useState("");
  const [token, setToken] = React.useState("");
  const [check, setCheck] = React.useState<ConnectionCheck | null>(null);
  const [revokeProbe, setRevokeProbe] = React.useState<RevokeProbe | null>(null);
  const [confirming, setConfirming] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const connected = connection?.state === "connected";
  const revoked = connection?.state === "revoked";

  const read = React.useCallback(async (): Promise<void> => {
    try {
      const response = await fetch(CONNECTIONS_ENDPOINT);
      const body = await response.json() as { ok?: boolean; connection?: ConnectionRecord | null };
      const current = body.connection ?? null;
      setConnection(current);
      // The form shows the connection that is in effect, and the owner edits
      // the fields of that connection instead of writing them again.
      setCenterUrl(current?.centerUrl ?? "");
      setPurpose(current?.purpose ?? CONNECTION_PURPOSE);
      setPermissions((current?.permissions ?? []).join(", "));
    } catch (cause) {
      setError((cause as Error).message);
    }
  }, []);

  React.useEffect(() => { void read(); }, [read]);

  const connect = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(CONNECTIONS_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          centerUrl: centerUrl.trim(),
          purpose: purpose.trim(),
          permissions: permissions.split(",").map((item) => item.trim()).filter(Boolean),
          ...(token.trim() ? { token: token.trim() } : {}),
        }),
      });
      const body = await response.json() as { ok?: boolean; connection?: ConnectionRecord; error?: string };
      if (!response.ok) {
        setError(body.error ?? `сервер ответил ${response.status}`);
        return;
      }
      setConnection(body.connection ?? null);
      // The token is write-only: it is gone from the browser right away.
      setToken("");
      setCheck(null);
      setRevokeProbe(null);
      setConfirming(false);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const runCheck = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(CONNECTION_CHECK_ENDPOINT, { method: "POST" });
      const body = await response.json() as { ok?: boolean; check?: ConnectionCheck; error?: string };
      if (!response.ok) {
        setError(body.error ?? `сервер ответил ${response.status}`);
        return;
      }
      setCheck(body.check ?? null);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const runRevokeProbe = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      setRevokeProbe(await probeRevokedLaunch());
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(CONNECTION_REVOKE_ENDPOINT, { method: "POST" });
      const body = await response.json() as { ok?: boolean; connection?: ConnectionRecord; error?: string };
      if (!response.ok) {
        setError(body.error ?? `сервер ответил ${response.status}`);
        return;
      }
      setConnection(body.connection ?? null);
      setCheck(null);
      setConfirming(false);
      // The record says that the connection is revoked. The probe of the
      // revocation asks the route of the launch whether it refuses the center
      // now: the panel shows what is true, not what should be.
      setRevokeProbe(await probeRevokedLaunch());
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="herder-settings-block" aria-label="Подключение к центру уведомлений">
      <h2>Подключение к центру уведомлений</h2>
      <p className={connectionStateClass(connection)} role="status">{connectionStateText(connection)}</p>
      <p className="herder-settings-hint">
        Подключение изолировано: herder хранит свою часть подключения в своём хранилище, общего env-файла нет.
        Проверка соединения подтверждает авторизацию и совместимость и не запускает исполнителя.
      </p>
      <p className="herder-settings-hint">
        Запуск с центра доходит до herder запросом POST /api/automation/project-launch: токен
        service-учётной записи идёт в заголовке Authorization и не в теле, запрос несёт purpose,
        operation_id и модель запуска. Проверка соединения этот запрос не делает.
      </p>

      {connection?.permissions?.length ? (
        <p className="herder-settings-hint">Разрешения, выданные владельцем: {connection.permissions.join(", ")}.</p>
      ) : null}
      {connection?.connectedAt ? (
        <p className="herder-settings-hint">Подключение подтверждено {connection.connectedAt}.</p>
      ) : null}

      <div className="herder-settings-row">
        <label className="herder-settings-field">
          <span>Адрес центра</span>
          <input
            value={centerUrl}
            onChange={(event) => setCenterUrl(event.target.value)}
            placeholder="https://center.example"
            aria-label="Адрес центра уведомлений"
          />
        </label>
        <label className="herder-settings-field">
          <span>Цель подключения</span>
          <input
            value={purpose}
            onChange={(event) => setPurpose(event.target.value)}
            placeholder={CONNECTION_PURPOSE}
            aria-label="Цель подключения"
          />
        </label>
      </div>
      <div className="herder-settings-row">
        <label className="herder-settings-field">
          <span>Разрешения</span>
          <input
            value={permissions}
            onChange={(event) => setPermissions(event.target.value)}
            placeholder="через запятую"
            aria-label="Разрешения подключения"
          />
        </label>
        <label className="herder-settings-field">
          <span>Ключ сервисной учётной записи</span>
          <input
            type="password"
            autoComplete="off"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            aria-label="Ключ сервисной учётной записи"
          />
        </label>
      </div>
      <div className="herder-settings-actions">
        <button type="button" className="herder-settings-button" onClick={() => { void connect(); }} disabled={busy}>
          {busy ? "Подключаю…" : "Подключить"}
        </button>
        <button type="button" className="herder-settings-button" onClick={() => { void runCheck(); }} disabled={busy || !connected}>
          Проверить соединение
        </button>
        {confirming ? (
          <>
            <button type="button" className="herder-settings-button herder-settings-button-danger" onClick={() => { void revoke(); }} disabled={busy}>
              Точно отозвать
            </button>
            <button type="button" className="herder-settings-button" onClick={() => setConfirming(false)} disabled={busy}>
              Отмена
            </button>
          </>
        ) : (
          <button type="button" className="herder-settings-button herder-settings-button-danger" onClick={() => setConfirming(true)} disabled={busy || !connected}>
            Отозвать
          </button>
        )}
        {revoked ? (
          <button type="button" className="herder-settings-button" onClick={() => { void runRevokeProbe(); }} disabled={busy}>
            Проверить отзыв
          </button>
        ) : null}
      </div>

      {connection?.tokenFingerprint ? (
        <p className="herder-settings-hint">Ключ сервисной учётной записи: {connection.tokenFingerprint}. Значение ключа не показывается и не выгружается.</p>
      ) : null}
      {error ? <p className="herder-settings-error" role="alert">{error}</p> : null}
      {check ? (
        <>
          <p className="herder-settings-notice" role="status">{checkText(check)}</p>
          {checkEvidenceText(check) ? <p className="herder-settings-hint">{checkEvidenceText(check)}</p> : null}
        </>
      ) : null}
      {revoked ? (
        <p className="herder-settings-notice" role="status">{revokeEffectText(revokeProbe)}</p>
      ) : null}
    </section>
  );
}
