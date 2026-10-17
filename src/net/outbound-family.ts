import net from "node:net";
import { networkInterfaces } from "node:os";
import { readFile } from "node:fs/promises";

/** One IPv6 reachability fact read from the kernel. */
export interface OutboundIpv6Reachability {
  /** A non-link-local IPv6 address is bound to a real interface. */
  hasGlobalAddress: boolean;
  /** A non-link-local IPv6 default route exists. */
  hasDefaultRoute: boolean;
}

/** True when IPv6 is published but cannot actually reach the network. */
export function ipv6Unreachable(state: OutboundIpv6Reachability): boolean {
  return !state.hasGlobalAddress || !state.hasDefaultRoute;
}

export interface OutboundFamilyDecision {
  /** Whether Happy Eyeballs address racing is switched off for this process. */
  disableAutoSelectFamily: boolean;
  /** Human-readable reason, or undefined when the host keeps the Node default. */
  reason?: string;
}

/**
 * Decide whether this host must stop racing A and AAAA addresses at once.
 *
 * Node enables Happy Eyeballs by default (`net.getDefaultAutoSelectFamily()` is
 * true). It connects to every resolved address in parallel and abandons the
 * stragglers after `autoSelectFamilyAttemptTimeout`. On a host that resolves an
 * AAAA record but has no IPv6 egress, the AAAA leg dies instantly with
 * `ENETUNREACH`, and the stagger timer then manufactures
 * `connect ETIMEDOUT` for the IPv4 leg that is still connecting
 * (`node:net` `createConnectionError`). Observed on server-100 against
 * `api.z.ai`, which publishes both families: roughly 10-20% of new connections
 * failed with a flat ~505 ms `ETIMEDOUT`, and the autopilot batch planner read
 * that as "the judge could not build a safe plan".
 *
 * There is nothing for address racing to win when no global IPv6 address and no
 * IPv6 default route exist, so such a host connects to one address at a time.
 * A genuinely dual-stack host keeps the Node default.
 */
export function decideOutboundFamily(
  state: OutboundIpv6Reachability,
  autoSelectFamilyEnabled: boolean,
): OutboundFamilyDecision {
  if (!autoSelectFamilyEnabled) return { disableAutoSelectFamily: false };
  if (!ipv6Unreachable(state)) return { disableAutoSelectFamily: false };
  const missing = [
    !state.hasGlobalAddress ? "глобального IPv6-адреса" : undefined,
    !state.hasDefaultRoute ? "маршрута IPv6 по умолчанию" : undefined,
  ].filter((entry): entry is string => !!entry);
  return {
    disableAutoSelectFamily: true,
    reason: `автовыбор семейства адресов выключен: нет ${missing.join(" и ")}, IPv6-соединения заведомо нерабочие`,
  };
}

/** A zone-scoped IPv6 prefix, as used by `ip -6` and `os.networkInterfaces()`. */
const LINK_LOCAL_V6 = /^(fe80:|::1$|::$)/i;
/** Unique local addresses (fc00::/7), such as the Tailscale interface address. */
const UNIQUE_LOCAL_V6 = /^f[cd][0-9a-f]{2}:/i;

export function hasGlobalIpv6Address(addresses: readonly string[] = globalIpv6Addresses()): boolean {
  return addresses.some((address) => {
    const address6 = address.split("%")[0] ?? "";
    if (!address6.includes(":")) return false;
    // A ULA is routable only inside its own overlay network and never reaches the
    // public internet, so it must not count as evidence of IPv6 egress.
    return !LINK_LOCAL_V6.test(address6) && !UNIQUE_LOCAL_V6.test(address6);
  });
}

/** Every non-link-local IPv6 address currently bound to an interface. */
export function globalIpv6Addresses(): string[] {
  const addresses: string[] = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) if (entry.family === "IPv6") addresses.push(entry.address);
  }
  return addresses;
}

/**
 * True when the kernel routing table holds an IPv6 default route.
 *
 * `/proc/net/ipv6_route` lists ten columns per row: destination, destination
 * prefix, source, source prefix, next hop, metric, refcount, use, flags and the
 * interface name. A row is the default route only when the destination word is
 * all zeros, the prefix length is `00`, the next hop is a real gateway, and the
 * interface is not loopback: Linux keeps a placeholder all-zero row on `lo` that
 * otherwise reads as a default route on every host. Any read failure is
 * reported as "no default route", because without a provable route the host must
 * not race an AAAA leg it cannot use.
 */
export async function hasIpv6DefaultRoute(
  readRouteTable: () => Promise<string> = () => readFile("/proc/net/ipv6_route", "utf8"),
): Promise<boolean> {
  let table: string;
  try {
    table = await readRouteTable();
  } catch {
    return false;
  }
  return table.split("\n").some((line) => {
    const columns = line.trim().split(/\s+/);
    if (columns.length < 10) return false;
    const [destination, prefix, , , nextHop, , , , , iface] = columns;
    return /^0+$/.test(destination ?? "")
      && prefix === "00"
      && !/^0+$/.test(nextHop ?? "")
      && iface !== "lo";
  });
}

/** Read the current IPv6 reachability facts from the kernel. */
export async function readIpv6Reachability(): Promise<OutboundIpv6Reachability> {
  return { hasGlobalAddress: hasGlobalIpv6Address(), hasDefaultRoute: await hasIpv6DefaultRoute() };
}

export interface ApplyOutboundFamilyOptions {
  state: OutboundIpv6Reachability;
  enableAutoSelectFamily: (enabled: boolean) => void;
  currentAutoSelectFamily: () => boolean;
}

/**
 * Apply the decision for one process. Returns it so the caller can log why the
 * process left the Node default in place.
 */
export function applyOutboundFamily(options: ApplyOutboundFamilyOptions): OutboundFamilyDecision {
  const decision = decideOutboundFamily(options.state, options.currentAutoSelectFamily());
  if (decision.disableAutoSelectFamily) options.enableAutoSelectFamily(false);
  return decision;
}

/**
 * Apply the decision to this process using the real kernel and the real Node
 * socket defaults. Call once, before any outbound request is issued.
 */
export async function applyOutboundFamilyToProcess(): Promise<OutboundFamilyDecision> {
  return applyOutboundFamily({
    state: await readIpv6Reachability(),
    enableAutoSelectFamily: (enabled) => { net.setDefaultAutoSelectFamily(enabled); },
    currentAutoSelectFamily: () => net.getDefaultAutoSelectFamily(),
  });
}