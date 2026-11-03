import React from "react";

/** A button + Ctrl+Shift+R hotkey that triggers a full paginated rescan of
 * every ChatGPT conversation via POST /api/sessions/chatgpt/rescan. The driver
 * paginates offset=0,100,200… with a 15s gap between pages, so a scan can take
 * a while; the button shows progress and the result line stays until the next
 * click. The endpoint only exists for browser-chat harnesses that expose
 * fullScan() (currently ChatGPT). */
export function RescanButton(): React.ReactElement {
  const [busy, setBusy] = React.useState(false);
  const [result, setResult] = React.useState<string | null>(null);

  const rescan = React.useCallback(async () => {
    if (busy) return;
    setBusy(true); setResult(null);
    try {
      const r = await fetch("/api/sessions/chatgpt/rescan", { method: "POST" });
      const d = await r.json().catch(() => ({ ok: false, error: "непонятный ответ" }));
      setResult(d.ok ? `Пересканировано: ${d.count} чатов (${d.pages} стр.)` : `Ошибка: ${d.error || r.status}`);
    } catch (e) {
      setResult("Ошибка: " + (e instanceof Error ? e.message : String(e)));
    } finally { setBusy(false); }
  }, [busy]);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && (e.key === "R" || e.key === "r" || e.code === "KeyR")) {
        e.preventDefault();
        void rescan();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rescan]);

  return (
    <div className="rescan-control">
      <button className="quiet-button" onClick={() => void rescan()} disabled={busy} title="Ctrl+Shift+R — пересканировать все чаты ChatGPT">
        {busy ? "Сканирую…" : "Пересканировать чаты"}
      </button>
      {result && <small role="status">{result}</small>}
    </div>
  );
}
