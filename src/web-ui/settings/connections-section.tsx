import React from "react";

/**
 * The connection of the herder to the Notice Place.
 *
 * The integration is isolated: the herder keeps its own part of the
 * connection in its own store, and the panel only shows it. The token of the
 * service account is write-only: it goes to the file of the product once and
 * never comes back to the browser — the panel shows the fingerprint only.
 *
 * The check of the connection asks the center whether it answers and whether
 * it accepts the authorization. It starts no executor of the herder and it
 * creates no event in the center. The compatibility of the release of the
 * center is proved by the pairing with the center, and the screen says so
 * instead of promising it.
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
};

export const CONNECTIONS_ENDPOINT = "/api/settings/connections";
export const CONNECTION_CHECK_ENDPOINT = "/api/settings/connections/check";
export const CONNECTION_REVOKE_ENDPOINT = "/api/settings/connections/revoke";

/** The state of the connection, in one line. */
export function connectionStateText(connection: ConnectionRecord | null): string {
  if (!connection) return "Подключение к центру уведомлений не настроено.";
  if (connection.state === "revoked") {
    return `Подключение отозвано${connection.revokedAt ? ` ${connection.revokedAt}` : ""}.`;
  }
  return `Подключено к ${connection.centerUrl ?? "центру уведомлений"}, цель — ${connection.purpose ?? "не названа"}.`;
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

export function ConnectionsSection(): React.ReactElement {
  const [connection, setConnection] = React.useState<ConnectionRecord | null>(null);
  const [centerUrl, setCenterUrl] = React.useState("");
  const [purpose, setPurpose] = React.useState("");
  const [permissions, setPermissions] = React.useState("");
  const [token, setToken] = React.useState("");
  const [check, setCheck] = React.useState<ConnectionCheck | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const read = React.useCallback(async (): Promise<void> => {
    try {
      const response = await fetch(CONNECTIONS_ENDPOINT);
      const body = await response.json() as { ok?: boolean; connection?: ConnectionRecord | null };
      setConnection(body.connection ?? null);
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
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="herder-settings-block" aria-label="Подключение к центру уведомлений">
      <h2>Подключение к центру уведомлений</h2>
      <p className="herder-settings-state-line" role="status">{connectionStateText(connection)}</p>
      <p className="herder-settings-hint">
        Подключение изолировано: herder хранит свою часть подключения в своём хранилище, общего env-файла нет.
        Проверка соединения подтверждает авторизацию и не запускает исполнителя.
      </p>

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
            placeholder="noticeplace.health-analysis"
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
        <button type="button" className="herder-settings-button" onClick={() => { void runCheck(); }} disabled={busy}>
          Проверить соединение
        </button>
        <button type="button" className="herder-settings-button herder-settings-button-danger" onClick={() => { void revoke(); }} disabled={busy}>
          Отозвать
        </button>
      </div>

      {connection?.tokenFingerprint ? (
        <p className="herder-settings-hint">Ключ сервисной учётной записи: {connection.tokenFingerprint}. Значение ключа не показывается и не выгружается.</p>
      ) : null}
      {error ? <p className="herder-settings-error" role="alert">{error}</p> : null}
      {check ? <p className="herder-settings-notice" role="status">{checkText(check)}</p> : null}
    </section>
  );
}
