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
export function ownedTabMarker(provider: "chatgpt" | "zai", scope?: string, namespace?: string): string {
  const marker = scope ? provider + ":" + scope : provider;
  return namespace ? marker + ":" + namespace : marker;
}

/** The URL of the owned tab for this provider. */
export function ownedTabUrl(origin: string, provider: "chatgpt" | "zai", scope?: string, namespace?: string): string {
  return origin + "/?" + OWNED_TAB_QUERY + "=" + encodeURIComponent(ownedTabMarker(provider, scope, namespace));
}

/** True when this URL carries the owned-tab marker of the provider. */
export function isOwnedTabUrl(url: string, provider: "chatgpt" | "zai", scope?: string, namespace?: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.searchParams.get(OWNED_TAB_QUERY) === ownedTabMarker(provider, scope, namespace);
  } catch { return false; }
}

/** The window name of the tab this provider owns. The site rewrites the
 * URL of its own SPA navigation, so the URL marker alone is lost as soon as
 * the tab opens a conversation. The window name survives that navigation and
 * therefore keeps the ownership of exactly one tab per provider. */
export function ownedTabWindowName(provider: "chatgpt" | "zai", scope?: string, namespace?: string): string {
  return "herder-owned:" + ownedTabMarker(provider, scope, namespace);
}

/** Read the ownership marker of the current page without any side effect. */
export function ownedTabProbeScript(provider: "chatgpt" | "zai", scope?: string, namespace?: string): string {
  return `() => ({owned: window.name === ${JSON.stringify(ownedTabWindowName(provider, scope, namespace))}})`;
}

/** Claim the current page for this provider. Idempotent: an already owned
 * page keeps its marker, and a foreign page is never claimed silently. */
export function ownedTabClaimScript(provider: "chatgpt" | "zai", scope?: string, namespace?: string): string {
  const name = ownedTabWindowName(provider, scope, namespace);
  return `() => {
    if(window.name === ${JSON.stringify(name)}) return {owned:true,already:true};
    if(window.name && /^herder-owned:/.test(window.name) && window.name !== ${JSON.stringify(scope ? ownedTabWindowName(provider, undefined, namespace) : name)}) return {owned:false,already:false};
    try{window.name = ${JSON.stringify(name)};}catch{return {owned:false,already:false};}
    return {owned:window.name === ${JSON.stringify(name)},already:false};
  }`;
}

export interface OwnedTabCandidate { id: number; url: string; selected?: boolean }
interface OwnedTabTools {
  call(name: string, args?: Record<string, unknown>): Promise<string>;
  readonly ownedTabNamespace?: string;
  readonly ownedTabAccountScope?: string;
}

/** Resolve the one tab this provider owns.
 *
 * The URL marker is checked first because it is free. When the site dropped
 * it during its own navigation, the page itself still carries the ownership
 * marker, so the remaining candidate tabs are probed read-only. A tab that
 * does not answer is never claimed and never closed. */
export async function resolveOwnedTab(
  tools: OwnedTabTools,
  provider: "chatgpt" | "zai",
  pages: readonly OwnedTabCandidate[],
  scope?: string,
): Promise<OwnedTabCandidate | undefined> {
  const namespace = tools.ownedTabNamespace;
  scope ??= namespace ? tools.ownedTabAccountScope : undefined;
  const marked = pages.filter(page => isOwnedTabUrl(page.url, provider, scope, namespace));
  if ((scope || namespace) && marked.length > 1) throw new Error("duplicate_owned_browser_tabs");
  if (marked[0]) return marked[0];
  const script = ownedTabProbeScript(provider, scope, namespace);
  const discovered: OwnedTabCandidate[] = [];
  for (const page of pages) {
    if (namespace && new URL(page.url).searchParams.has(OWNED_TAB_QUERY)) continue;
    try {
      const raw = await tools.call("evaluate_script", { pageId: page.id, function: script });
      const fence = "```", start = raw.indexOf(fence + "json"), end = raw.lastIndexOf(fence);
      if (start < 0 || end <= start) {
        if (namespace) throw new Error("owned_tab_probe_invalid");
        continue;
      }
      const parsed = JSON.parse(raw.slice(start + 7, end).trim()) as { owned?: boolean };
      if (parsed.owned === true) {
        if (!scope && !namespace) return page;
        discovered.push(page);
      }
    } catch (error) {
      if (namespace) throw error; // An uncertain read cannot authorize a replacement tab.
      /* an unreadable legacy tab is never owned and never closed */
    }
  }
  if (discovered.length > 1) throw new Error("duplicate_owned_browser_tabs");
  return discovered[0];
}

/** Claim the given page for this provider, in the page itself. The claim is
 * idempotent and never overwrites a marker of another provider. */
export async function claimOwnedTab(
  tools: OwnedTabTools,
  provider: "chatgpt" | "zai",
  pageId: number,
  scope?: string,
): Promise<boolean> {
  const namespace = tools.ownedTabNamespace;
  scope ??= namespace ? tools.ownedTabAccountScope : undefined;
  try {
    const raw = await tools.call("evaluate_script", { pageId, function: ownedTabClaimScript(provider, scope, namespace) });
    const fence = "```", start = raw.indexOf(fence + "json"), end = raw.lastIndexOf(fence);
    if (start < 0 || end <= start) {
      if (namespace) throw new Error("owned_tab_claim_invalid");
      return false;
    }
    const parsed = JSON.parse(raw.slice(start + 7, end).trim()) as { owned?: boolean };
    if (namespace && parsed.owned !== true) throw new Error("owned_tab_claim_refused");
    return parsed.owned === true;
  } catch (error) {
    if (namespace) throw error;
    return false;
  }
}
