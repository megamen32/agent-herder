import React from "react";

type ClientToken = { id: string; name: string; createdAt: string; revokedAt?: string | null; inputId?: string };
type Connection = { url: string; tokens: ClientToken[]; enabled?: boolean };
const endpoint = "/api/mcp-connection";
const errorText = (code: unknown) => ({
  owner_required: "Для управления токенами войдите как владелец Herder.",
  managed_mcp_url_unavailable: "Публичный адрес MCP этого узла не настроен.",
  token_registry_unavailable: "Хранилище токенов недоступно. Повторите чтение позже.",
  same_origin_required: "Откройте настройки на обычном адресе Herder и повторите действие.",
  issue_already_attempted: "Токен этой попытки уже создан; повторно получить его значение нельзя. Проверьте список токенов.",
  token_registry_full: "Реестр токенов заполнен. Для новых подключений нужна очистка старых записей реестра.",
  invalid_issue_request: "Укажите название подключения длиной до 64 символов.",
  token_not_found: "Токен не найден. Обновите список.",
} as Record<string, string>)[String(code)] || "Не удалось выполнить запрос к Herder. Повторите чтение позже.";

export function McpConnectionSection(): React.ReactElement {
  const [connection, setConnection] = React.useState<Connection>();
  const [name, setName] = React.useState("Мой MCP-клиент");
  const [issued, setIssued] = React.useState<{ token: string; record: ClientToken }>();
  const [visible, setVisible] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const [notice, setNotice] = React.useState("");
  const [unknownIssue, setUnknownIssue] = React.useState(false);
  const pending = React.useRef(false);

  const read = React.useCallback(async (signal?: AbortSignal) => {
    const response = await fetch(endpoint, { signal, cache: "no-store" }).catch(() => { throw new Error("Не удалось связаться с Herder. Повторите чтение позже."); });
    const body = await response.json().catch(() => { throw new Error("Не удалось прочитать подключение MCP. Проверьте вход в кабинет и повторите чтение."); });
    if (!response.ok) throw new Error(errorText(body.error));
    setConnection(body);
  }, []);
  React.useEffect(() => {
    const controller = new AbortController();
    void read(controller.signal).catch(reason => { if (!controller.signal.aborted) setError(reason.message); });
    return () => controller.abort();
  }, [read]);

  const copy = async (value: string, label: string) => {
    try { await navigator.clipboard.writeText(value); setError(""); setNotice(label); }
    catch { setError("Браузер не разрешил копирование. Выделите поле вручную и скопируйте его."); }
  };
  const issue = async (event: React.FormEvent) => {
    event.preventDefault();
    if (pending.current || unknownIssue || !name.trim()) return;
    pending.current = true; setBusy(true); setError(""); setNotice(""); setIssued(undefined); setVisible(false);
    let responseKnown = false;
    try {
      const response = await fetch(endpoint, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "issue", name: name.trim(), inputId: crypto.randomUUID() }),
      });
      const body = await response.json();
      responseKnown = true;
      if (!response.ok) throw new Error(errorText(body.error));
      if (typeof body.token !== "string" || !body.record?.id) { responseKnown = false; throw new Error("Ответ о выдаче токена неполный."); }
      setIssued({ token: body.token, record: body.record });
      setConnection(current => current ? { ...current, tokens: [...current.tokens, body.record] } : current);
      setNotice("Токен создан. Скопируйте его сейчас: после закрытия страницы значение повторно не показывается.");
    } catch (reason) {
      if (!responseKnown) {
        setUnknownIssue(true);
        setError("Ответ о выдаче токена не получен. Проверьте список: токен мог быть создан. Повторная выдача автоматически не отправляется.");
      } else setError((reason as Error).message);
    } finally { pending.current = false; setBusy(false); }
  };
  const revoke = async (record: ClientToken) => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "revoke", id: record.id }) });
      const body = await response.json();
      if (!response.ok) throw new Error(errorText(body.error));
      if (body.record?.id !== record.id || !body.record?.revokedAt) throw new Error("Отзыв не подтверждён.");
      if (issued?.record.id === record.id) { setIssued(undefined); setVisible(false); }
      setConnection(current => current ? { ...current, tokens: current.tokens.map(row => row.id === record.id ? body.record : row) } : current);
      setNotice("Токен отозван. Новые MCP-запросы с ним не принимаются.");
    } catch { setError("Не удалось подтвердить отзыв. Обновите список токенов, прежде чем повторять действие."); }
    finally { pending.current = false; setBusy(false); }
  };
  const config = issued && connection ? JSON.stringify({ mcpServers: { "agent-herder": { url: connection.url, headers: { Authorization: `Bearer ${issued.token}` } } } }, null, 2) : "";

  return <section className="herder-settings-block" aria-label="Подключение MCP">
    <h2>Подключение MCP</h2>
    <p>Подключите Agent Herder к вашему агенту или MCP-клиенту по HTTP. Токен даёт права владельца на просмотр и управление сессиями.</p>
    {connection && <>
      <label className="herder-settings-field"><span>Адрес MCP</span><input className="herder-settings-input" aria-label="Адрес MCP" readOnly value={connection.url} /></label>
      <div className="herder-settings-actions"><button className="herder-settings-button" type="button" onClick={() => void copy(connection.url, "Адрес MCP скопирован.")}>Скопировать адрес</button></div>
      {connection.enabled === false && <p role="status">HTTP MCP на этом узле не включён. Выдача токенов недоступна.</p>}
      <form onSubmit={event => void issue(event)}>
        <label className="herder-settings-field"><span>Название подключения</span><input className="herder-settings-input" aria-label="Название MCP-подключения" value={name} maxLength={64} onChange={event => setName(event.target.value)} /></label>
        <button className="primary-button" type="submit" disabled={busy || unknownIssue || !name.trim() || connection.enabled === false}>{busy ? "Обрабатываю…" : "Создать токен"}</button>
      </form>
      {issued && <div className="herder-settings-block" aria-label="Новый токен MCP" data-token-id={issued.record.id}>
        <label className="herder-settings-field"><span>Bearer-токен</span><input className="herder-settings-input" aria-label="Новый bearer-токен MCP" type={visible ? "text" : "password"} value={issued.token} readOnly autoComplete="off" spellCheck={false} /></label>
        <div className="herder-settings-actions">
          <button type="button" className="herder-settings-button" onClick={() => setVisible(current => !current)}>{visible ? "Скрыть токен" : "Показать токен"}</button>
          <button type="button" className="herder-settings-button" onClick={() => void copy(issued.token, "Токен скопирован.")}>Скопировать токен</button>
          <button type="button" className="herder-settings-button" onClick={() => void copy(config, "Конфигурация MCP скопирована.")}>Скопировать конфигурацию</button>
        </div>
        <p>В клиенте выберите HTTP / Streamable HTTP и передайте заголовок <code>Authorization: Bearer &lt;токен&gt;</code>. Скопированная JSON-конфигурация уже содержит адрес и заголовок.</p>
      </div>}
      <h3>Выданные токены</h3>
      {connection.tokens.length === 0 ? <p>Токенов ещё нет.</p> : <ul id="mcp-client-token-list" aria-label="Выданные токены MCP">{connection.tokens.map(record => <li key={record.id}>
        <strong>{record.name}</strong>{" · "}{Number.isFinite(Date.parse(record.createdAt)) ? new Date(record.createdAt).toLocaleString("ru-RU") : "дата неизвестна"}{" · "}
        {record.revokedAt ? "Отозван" : <button type="button" className="quiet-button" disabled={busy} aria-label={`Отозвать токен ${record.name}`} onClick={() => void revoke(record)}>Отозвать</button>}
      </li>)}</ul>}
      <small>Отзыв запрещает новые запросы; уже отправленные команды сессиям не отменяются.</small>
    </>}
    {notice && <p role="status">{notice}</p>}
    {error && <p className="autopilot-error" role="alert">{error}</p>}
    <div className="herder-settings-actions"><button type="button" className="herder-settings-button" disabled={busy} onClick={async () => {
      if (pending.current) return;
      pending.current = true; setBusy(true); setError("");
      try { await read(); } catch (reason) { setError((reason as Error).message); }
      finally { pending.current = false; setBusy(false); }
    }}>Обновить список токенов</button>
      {unknownIssue && <button type="button" className="quiet-button" onClick={() => { setUnknownIssue(false); setNotice("Для нового подключения будет создан другой токен. Неиспользуемый токен из предыдущей попытки можно отозвать в списке."); }}>Создать другой токен</button>}
    </div>
  </section>;
}
