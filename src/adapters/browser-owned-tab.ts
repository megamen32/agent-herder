/** One owned browser tab per provider/account scope.
 *
 * The tab is identified by a service marker in its URL, not by a page
 * number: a gateway restart or a closed tab renumbers everything, and a
 * number would either break the driver or make it grab a foreign tab. The
 * driver therefore finds its own marked tab, and when that tab is gone it
 * opens exactly one replacement instead of a tab per operation.
 */
export const OWNED_TAB_QUERY = "herder_owned";

/** The marker value of the one tab this provider owns. */
export function ownedTabMarker(provider: "chatgpt" | "zai", scope?: string): string {
  return scope ? provider + ":" + scope : provider;
}

/** The URL of the owned tab for this provider. */
export function ownedTabUrl(origin: string, provider: "chatgpt" | "zai", scope?: string): string {
  return origin + "/?" + OWNED_TAB_QUERY + "=" + encodeURIComponent(ownedTabMarker(provider, scope));
}

/** True when this URL carries the owned-tab marker of the provider. */
export function isOwnedTabUrl(url: string, provider: "chatgpt" | "zai", scope?: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.searchParams.get(OWNED_TAB_QUERY) === ownedTabMarker(provider, scope);
  } catch { return false; }
}

/** The window name of the tab this provider owns. The site rewrites the
 * URL of its own SPA navigation, so the URL marker alone is lost as soon as
 * the tab opens a conversation. The window name survives that navigation and
 * therefore keeps the ownership of exactly one tab per provider. */
export function ownedTabWindowName(provider: "chatgpt" | "zai", scope?: string): string {
  return "herder-owned:" + ownedTabMarker(provider, scope);
}

/** Read the ownership marker of the current page without any side effect. */
export function ownedTabProbeScript(provider: "chatgpt" | "zai", scope?: string): string {
  return `() => ({owned: window.name === ${JSON.stringify(ownedTabWindowName(provider, scope))}})`;
}

/** Claim the current page for this provider. Idempotent: an already owned
 * page keeps its marker, and a foreign page is never claimed silently. */
export function ownedTabClaimScript(provider: "chatgpt" | "zai", scope?: string): string {
  const name = ownedTabWindowName(provider, scope);
  return `() => {
    if(window.name === ${JSON.stringify(name)}) return {owned:true,already:true};
    if(window.name && /^herder-owned:/.test(window.name) && window.name !== ${JSON.stringify(scope ? ownedTabWindowName(provider) : name)}) return {owned:false,already:false};
    try{window.name = ${JSON.stringify(name)};}catch{return {owned:false,already:false};}
    return {owned:window.name === ${JSON.stringify(name)},already:false};
  }`;
}

export interface OwnedTabCandidate { id: number; url: string; selected?: boolean }

/** Resolve the one tab this provider owns.
 *
 * The URL marker is checked first because it is free. When the site dropped
 * it during its own navigation, the page itself still carries the ownership
 * marker, so the remaining candidate tabs are probed read-only. A tab that
 * does not answer is never claimed and never closed. */
export async function resolveOwnedTab(
  tools: { call(name: string, args?: Record<string, unknown>): Promise<string> },
  provider: "chatgpt" | "zai",
  pages: readonly OwnedTabCandidate[],
  scope?: string,
): Promise<OwnedTabCandidate | undefined> {
  const marked = pages.filter(page => isOwnedTabUrl(page.url, provider, scope));
  if (scope && marked.length > 1) throw new Error("duplicate_owned_browser_tabs");
  if (marked[0]) return marked[0];
  const script = ownedTabProbeScript(provider, scope);
  const discovered: OwnedTabCandidate[] = [];
  for (const page of pages) {
    try {
      const raw = await tools.call("evaluate_script", { pageId: page.id, function: script });
      const fence = "```", start = raw.indexOf(fence + "json"), end = raw.lastIndexOf(fence);
      if (start < 0 || end <= start) continue;
      const parsed = JSON.parse(raw.slice(start + 7, end).trim()) as { owned?: boolean };
      if (parsed.owned === true) {
        if (!scope) return page;
        discovered.push(page);
      }
    } catch { /* an unreadable tab is never owned and never closed */ }
  }
  if (discovered.length > 1) throw new Error("duplicate_owned_browser_tabs");
  return discovered[0];
}

/** Claim the given page for this provider, in the page itself. The claim is
 * idempotent and never overwrites a marker of another provider. */
export async function claimOwnedTab(
  tools: { call(name: string, args?: Record<string, unknown>): Promise<string> },
  provider: "chatgpt" | "zai",
  pageId: number,
  scope?: string,
): Promise<boolean> {
  try {
    const raw = await tools.call("evaluate_script", { pageId, function: ownedTabClaimScript(provider, scope) });
    const fence = "```", start = raw.indexOf(fence + "json"), end = raw.lastIndexOf(fence);
    if (start < 0 || end <= start) return false;
    const parsed = JSON.parse(raw.slice(start + 7, end).trim()) as { owned?: boolean };
    return parsed.owned === true;
  } catch { return false; }
}
