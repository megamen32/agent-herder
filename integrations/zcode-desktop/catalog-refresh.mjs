/** Refresh native Desktop projections after another process commits task metadata.
 * One serial, unreferenced timer per window; no prompts, sessions or processes. */
export function startHerderCatalogRefresh({readRevision, listSources, refreshSource, onError = () => {}, timers = globalThis, intervalMs = 2000}) {
  let disposed = false, busy = false, revision;
  try { revision = readRevision(); } catch (error) { onError(error); }
  const tick = async () => {
    if (disposed || busy) return;
    busy = true;
    try {
      const next = readRevision();
      if (next === revision) return;
      let complete = true;
      for (const source of listSources()) {
        if (disposed) return;
        if (source.scope.kind !== 'local' || source.sourceAvailability !== 'online') continue;
        try { await refreshSource(source); }
        catch (error) { complete = false; if (!disposed) onError(error, source); }
      }
      if (complete && !disposed) revision = next;
    } catch (error) { if (!disposed) onError(error); }
    finally { busy = false; }
  };
  const timer = timers.setInterval(tick, intervalMs);
  timer.unref?.();
  return {dispose() { disposed = true; timers.clearInterval(timer); }};
}
