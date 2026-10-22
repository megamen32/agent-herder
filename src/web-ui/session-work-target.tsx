import * as React from "react";

/** The four states of one work-target operation; the same states the MCP tool returns. */
export type SessionTargetState = "updated" | "unchanged" | "unreachable" | "unsupported";

/** Receipt of one work-target operation, exactly as the server answers it. */
export type SessionTargetReceipt = {
  sessionId: string;
  harness: string;
  hostId: string;
  cwd: string;
  previous: { hostId: string; cwd: string };
  state: SessionTargetState;
  reason?: string;
};

/** How the result is shown to the owner. */
export type SessionTargetOutcome = { state: SessionTargetState; message: string; tone: "ok" | "neutral" | "error" };

/** A machine of the fleet with the label the owner knows it by. */
export type WorkTargetHost = { hostId: string; label: string };

/** The live session whose work place is shown. */
export type WorkTargetSession = { id: string; harness: string; cwd: string; hostId?: string };

/**
 * Human-facing result of one operation. An unreachable machine never reads as
 * success: it says the machine is unreachable and why.
 */
export function sessionTargetOutcome(receipt: SessionTargetReceipt): SessionTargetOutcome {
  switch (receipt.state) {
    case "updated":
      return { state: "updated", message: "Рабочая машина и каталог обновлены", tone: "ok" };
    case "unchanged":
      return { state: "unchanged", message: "Ничего не изменилось", tone: "neutral" };
    case "unreachable":
      return { state: "unreachable", message: `Машина недоступна: ${receipt.reason ?? "причина неизвестна"}`, tone: "error" };
    case "unsupported":
      return { state: "unsupported", message: `Эта машина не поддерживает смену рабочего места: ${receipt.reason ?? "причина неизвестна"}`, tone: "error" };
  }
}

/** Machine label of the owner; the raw id stays visible next to it. */
export function workTargetHostLabel(hosts: WorkTargetHost[], hostId: string): string {
  const found = hosts.find((host) => host.hostId.toLowerCase() === hostId.toLowerCase());
  return found?.label ?? hostId;
}

/** The body of one work-target operation; an empty field keeps the current value. */
export function workTargetRequestBody(
  session: { id: string; harness: string },
  hostId: string,
  cwd: string,
): { sessionId: string; harness: string; hostId?: string; cwd?: string } {
  const machine = hostId.trim();
  const directory = cwd.trim();
  return {
    sessionId: session.id,
    harness: session.harness,
    ...(machine ? { hostId: machine } : {}),
    ...(directory ? { cwd: directory } : {}),
  };
}

/** Reads the effective work target of a live session; an unreadable session has no target. */
export async function readWorkTarget(session: { id: string; harness: string }): Promise<SessionTargetReceipt | undefined> {
  try {
    const query = new URLSearchParams({ sessionId: session.id, harness: session.harness });
    const response = await fetch(`/api/session-target?${query.toString()}`, { headers: { accept: "application/json" }, cache: "no-store" });
    if (!response.ok) return undefined;
    const body = await response.json().catch(() => undefined) as SessionTargetReceipt | undefined;
    return body && typeof body.hostId === "string" && typeof body.cwd === "string" ? body : undefined;
  } catch {
    return undefined;
  }
}

/** Applies the work target and returns the honest receipt of the server. */
export async function applyWorkTarget(
  session: { id: string; harness: string },
  hostId: string,
  cwd: string,
): Promise<{ receipt?: SessionTargetReceipt; error?: string }> {
  try {
    const response = await fetch("/api/session-target", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(workTargetRequestBody(session, hostId, cwd)),
    });
    const payload = await response.json().catch(() => undefined) as (SessionTargetReceipt & { error?: string }) | undefined;
    if (!response.ok) return { error: payload?.error ?? `Запрос отклонён (${response.status})` };
    if (!payload || typeof payload.state !== "string") return { error: "Сервер не вернул состояние рабочего места." };
    return { receipt: payload };
  } catch (error) {
    return { error: `Не удалось применить рабочее место: ${(error as Error).message}` };
  }
}

/** Value of the machine select that asks for a machine outside the known fleet. */
const CUSTOM_HOST = "__custom__";

/**
 * The work target of one live session: the machine it works on and the
 * directory it works in. The server owns the truth — this block shows it and
 * asks for a change, and it never presents an unreachable machine as done.
 */
export function SessionWorkTarget({ session, hosts, localHostId, onApplied }: {
  session: WorkTargetSession;
  hosts: WorkTargetHost[];
  localHostId?: string;
  onApplied?: (receipt: SessionTargetReceipt) => void;
}) {
  const [current, setCurrent] = React.useState({ hostId: session.hostId ?? localHostId ?? "", cwd: session.cwd });
  const [hostId, setHostId] = React.useState(current.hostId);
  const [cwd, setCwd] = React.useState(current.cwd);
  const [custom, setCustom] = React.useState(false);
  const [customHostId, setCustomHostId] = React.useState("");
  const [outcome, setOutcome] = React.useState<SessionTargetOutcome>();
  const [error, setError] = React.useState<string>();
  const [pending, setPending] = React.useState(false);

  // The declared work target is the truth; the session row only knows where it started.
  React.useEffect(() => {
    let live = true;
    const fallback = { hostId: session.hostId ?? localHostId ?? "", cwd: session.cwd };
    setCurrent(fallback);
    setHostId(fallback.hostId);
    setCwd(fallback.cwd);
    setCustom(false);
    setCustomHostId("");
    setOutcome(undefined);
    setError(undefined);
    void readWorkTarget({ id: session.id, harness: session.harness }).then((receipt) => {
      if (!live || !receipt) return;
      setCurrent({ hostId: receipt.hostId, cwd: receipt.cwd });
      setHostId(receipt.hostId);
      setCwd(receipt.cwd);
    });
    return () => { live = false; };
  }, [session.id, session.harness]);

  const knownHosts = hosts.slice();
  if (current.hostId && !knownHosts.some((host) => host.hostId.toLowerCase() === current.hostId.toLowerCase())) {
    knownHosts.push({ hostId: current.hostId, label: current.hostId });
  }
  const effectiveHostId = custom ? customHostId.trim() : hostId;

  const apply = async () => {
    setPending(true);
    setOutcome(undefined);
    setError(undefined);
    const result = await applyWorkTarget({ id: session.id, harness: session.harness }, effectiveHostId, cwd);
    setPending(false);
    if (result.error || !result.receipt) {
      setError(result.error ?? "Сервер не вернул состояние рабочего места.");
      return;
    }
    const receipt = result.receipt;
    setOutcome(sessionTargetOutcome(receipt));
    if (receipt.state !== "updated") return;
    // Only an applied target becomes the current one; a refused target keeps the old place.
    setCurrent({ hostId: receipt.hostId, cwd: receipt.cwd });
    setHostId(receipt.hostId);
    setCwd(receipt.cwd);
    setCustom(false);
    setCustomHostId("");
    onApplied?.(receipt);
  };

  return <section className="work-target" aria-label="Рабочая машина">
    <div className="work-target-current">
      <span className="eyebrow">РАБОЧАЯ МАШИНА</span>
      <strong>{workTargetHostLabel(hosts, current.hostId)}</strong>
      <code title={current.hostId}>{current.hostId || "машина не подтверждена"}</code>
      <small>Каталог: <code title={current.cwd}>{current.cwd || "не задан"}</code></small>
    </div>
    <div className="work-target-form">
      <label>Машина
        <select aria-label="Рабочая машина" value={custom ? CUSTOM_HOST : hostId} onChange={(event) => {
          const value = event.target.value;
          if (value === CUSTOM_HOST) { setCustom(true); return; }
          setCustom(false);
          setHostId(value);
        }}>
          {knownHosts.map((host) => <option key={host.hostId} value={host.hostId}>{host.label} · {host.hostId}</option>)}
          <option value={CUSTOM_HOST}>Другая машина…</option>
        </select>
      </label>
      {custom && <label>Машина (hostId)
        <input aria-label="Идентификатор рабочей машины" value={customHostId} placeholder="например, server-44"
          onChange={(event) => setCustomHostId(event.target.value)} />
      </label>}
      <label>Каталог
        <input aria-label="Рабочий каталог" value={cwd} onChange={(event) => setCwd(event.target.value)} />
      </label>
      <button type="button" className="quiet-button" disabled={pending} onClick={() => void apply()}>
        {pending ? "Применяем…" : "Применить"}
      </button>
    </div>
    {outcome && <p className={`work-target-result work-target-${outcome.tone}`} role="status">{outcome.message}</p>}
    {error && <p className="work-target-result work-target-error" role="alert">{error}</p>}
  </section>;
}
