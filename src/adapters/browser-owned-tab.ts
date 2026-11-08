/** One owned browser tab per provider.
 *
 * The tab is identified by a service marker in its URL, not by a page
 * number: a gateway restart or a closed tab renumbers everything, and a
 * number would either break the driver or make it grab a foreign tab. The
 * driver therefore finds its own marked tab, and when that tab is gone it
 * opens exactly one replacement instead of a tab per operation.
 */
export const OWNED_TAB_QUERY = "herder_owned";

/** The marker value of the one tab this provider owns. */
export function ownedTabMarker(provider: "chatgpt" | "zai"): string {
  return provider;
}

/** The URL of the owned tab for this provider. */
export function ownedTabUrl(origin: string, provider: "chatgpt" | "zai"): string {
  return origin + "/?" + OWNED_TAB_QUERY + "=" + ownedTabMarker(provider);
}

/** True when this URL carries the owned-tab marker of the provider. */
export function isOwnedTabUrl(url: string, provider: "chatgpt" | "zai"): boolean {
  try {
    const parsed = new URL(url);
    return parsed.searchParams.get(OWNED_TAB_QUERY) === ownedTabMarker(provider);
  } catch { return false; }
}

/** The window name of the tab this provider owns. The site rewrites the
 * URL of its own SPA navigation, so the URL marker alone is lost as soon as
 * the tab opens a conversation. The window name survives that navigation and
 * therefore keeps the ownership of exactly one tab per provider. */
export function ownedTabWindowName(provider: "chatgpt" | "zai"): string {
  return "herder-owned:" + ownedTabMarker(provider);
}

/** Read the ownership marker of the current page without any side effect. */
export function ownedTabProbeScript(provider: "chatgpt" | "zai"): string {
  return `() => ({owned: window.name === ${JSON.stringify(ownedTabWindowName(provider))}})`;
}

/** Claim the current page for this provider. Idempotent: an already owned
 * page keeps its marker, and a foreign page is never claimed silently. */
export function ownedTabClaimScript(provider: "chatgpt" | "zai"): string {
  const name = ownedTabWindowName(provider);
  return `() => {
    if(window.name === ${JSON.stringify(name)}) return {owned:true,already:true};
    if(window.name && /^herder-owned:/.test(window.name)) return {owned:false,already:false};
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
): Promise<OwnedTabCandidate | undefined> {
  const marked = pages.find(page => isOwnedTabUrl(page.url, provider));
  if (marked) return marked;
  const script = ownedTabProbeScript(provider);
  for (const page of pages) {
    try {
      const raw = await tools.call("evaluate_script", { pageId: page.id, function: script });
      const fence = "```", start = raw.indexOf(fence + "json"), end = raw.lastIndexOf(fence);
      if (start < 0 || end <= start) continue;
      const parsed = JSON.parse(raw.slice(start + 7, end).trim()) as { owned?: boolean };
      if (parsed.owned === true) return page;
    } catch { /* an unreadable tab is never owned and never closed */ }
  }
  return undefined;
}

/** Claim the given page for this provider, in the page itself. The claim is
 * idempotent and never overwrites a marker of another provider. */
export async function claimOwnedTab(
  tools: { call(name: string, args?: Record<string, unknown>): Promise<string> },
  provider: "chatgpt" | "zai",
  pageId: number,
): Promise<boolean> {
  try {
    const raw = await tools.call("evaluate_script", { pageId, function: ownedTabClaimScript(provider) });
    const fence = "```", start = raw.indexOf(fence + "json"), end = raw.lastIndexOf(fence);
    if (start < 0 || end <= start) return false;
    const parsed = JSON.parse(raw.slice(start + 7, end).trim()) as { owned?: boolean };
    return parsed.owned === true;
  } catch { return false; }
}
