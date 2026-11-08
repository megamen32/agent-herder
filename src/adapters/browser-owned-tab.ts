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
