import React, { useEffect, useState } from "react";
import type { S21Ownership } from "../s21-resource-ownership.js";
import { s21OwnershipView } from "./s21-ownership-view.js";
import "./s21-resource-status.css";
export function S21ResourceStatus() {
  const [value, setValue] = useState<S21Ownership | null>(null);
  useEffect(() => {
    let stopped = false, timer: ReturnType<typeof setTimeout>, controller: AbortController;
    const refresh = async () => {
      controller = new AbortController();
      const deadline = setTimeout(() => controller.abort(), 6000);
      try {
        const response = await fetch("/api/resources/s21-lease", { signal: controller.signal, cache: "no-store" });
        if (!response.ok) throw new Error("unavailable");
        const next = await response.json() as S21Ownership;
        if (!stopped) setValue(next);
      } catch { if (!stopped) setValue(null); }
      finally { clearTimeout(deadline); if (!stopped) timer = setTimeout(refresh, 30000); }
    };
    void refresh();
    return () => { stopped = true; clearTimeout(timer); controller?.abort(); };
  }, []);
  const view = s21OwnershipView(value);
  return <div className="s21-resource-status" role="status" aria-label="Аренда телефона S21">
    <span><strong>{view.label}</strong><small>{view.detail}</small></span>
    {view.href && <a href={view.href}>Открыть сессию</a>}
  </div>;
}
