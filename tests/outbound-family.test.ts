import { describe, expect, it } from "vitest";
import {
  applyOutboundFamily,
  decideOutboundFamily,
  hasGlobalIpv6Address,
  hasIpv6DefaultRoute,
  ipv6Unreachable,
} from "../src/net/outbound-family.js";

/**
 * The real `/proc/net/ipv6_route` rows captured on server-100, where the
 * incident happened: two Tailscale ULA routes and a loopback placeholder, and no
 * default route at all.
 */
const server100RouteTable = [
  "fd7a115ca1e000000000000000000053 80 00000000000000000000000000000000 00 00000000000000000000000000000000 00000400 0000000b 00000000 00000001 tailscale0",
  "fd7a115ca1e000000000000000000000 30 00000000000000000000000000000000 00 00000000000000000000000000000000 00000400 00000001 00000000 00000001 tailscale0",
  "00000000000000000000000000000000 00 00000000000000000000000000000000 00 00000000000000000000000000000000 ffffffff 00000001 00000000 00200200       lo",
  "",
].join("\n");

/** A genuine default route: zero destination, prefix 00, real gateway, real NIC. */
const defaultRoute = "00000000000000000000000000000000 00 00000000000000000000000000000000 00 fe800000000000000000000000000001 00000400 00000001 00000000 00000003 eth0";
const hostRoute = "240b0405115d95000000000000000000 80 00000000000000000000000000000000 00 0000000000000000000000000000f8 00000206 00000080 00000000 00000001 eth0";

describe("outbound address-family selection", () => {
  // Fast unit: the decision that keeps a host without IPv6 egress from racing
  // an AAAA leg. Catches a planner transport that invents `connect ETIMEDOUT`
  // for the still-connecting IPv4 leg and reports it as an unusable judge route.
  // Expected <100ms, maximum 5s; pure functions, no sockets and no network.
  it("stops address racing only where IPv6 is published but unreachable", () => {
    expect(ipv6Unreachable({ hasGlobalAddress: false, hasDefaultRoute: false })).toBe(true);
    expect(ipv6Unreachable({ hasGlobalAddress: true, hasDefaultRoute: false })).toBe(true);
    expect(ipv6Unreachable({ hasGlobalAddress: false, hasDefaultRoute: true })).toBe(true);
    expect(ipv6Unreachable({ hasGlobalAddress: true, hasDefaultRoute: true })).toBe(false);

    // The server-100 shape: api.z.ai publishes AAAA, the host has neither.
    const server100 = decideOutboundFamily({ hasGlobalAddress: false, hasDefaultRoute: false }, true);
    expect(server100.disableAutoSelectFamily).toBe(true);
    expect(server100.reason).toContain("IPv6");

    // A dual-stack host keeps the Node default; racing is what helps there.
    expect(decideOutboundFamily({ hasGlobalAddress: true, hasDefaultRoute: true }, true).disableAutoSelectFamily).toBe(false);
    // Already-disabled hosts are left alone.
    expect(decideOutboundFamily({ hasGlobalAddress: false, hasDefaultRoute: false }, false).disableAutoSelectFamily).toBe(false);
  });

  // Fast unit: the apply step must actually change the process default, because
  // the daemon's judge client reads Node's socket default and nothing else.
  // Expected <100ms, maximum 5s; injected callbacks only, no real sockets.
  it("applies the decision exactly once and never re-enables it", () => {
    const applied: boolean[] = [];
    const decision = applyOutboundFamily({
      state: { hasGlobalAddress: false, hasDefaultRoute: false },
      enableAutoSelectFamily: (enabled) => { applied.push(enabled); },
      currentAutoSelectFamily: () => true,
    });
    expect(decision.disableAutoSelectFamily).toBe(true);
    expect(applied).toEqual([false]);

    const dualStack: boolean[] = [];
    applyOutboundFamily({
      state: { hasGlobalAddress: true, hasDefaultRoute: true },
      enableAutoSelectFamily: (enabled) => { dualStack.push(enabled); },
      currentAutoSelectFamily: () => true,
    });
    expect(dualStack).toEqual([]);
  });

  // Fast unit: the kernel facts that drive the decision. Catches a probe that
  // mistakes the tailscale ULA or a link-local address for real IPv6 reachability,
  // or reads the `lo` placeholder as a default route, which would leave the
  // synthetic timeouts in place on the very host that reported the incident.
  // Expected <100ms, maximum 5s; injected tables, no real network.
  it("reads global addresses and the default route without guessing", async () => {
    expect(hasGlobalIpv6Address(["fe80::1%eth0", "::1"])).toBe(false);
    expect(hasGlobalIpv6Address(["240b:4005:115:d950::1"])).toBe(true);
    expect(hasGlobalIpv6Address(["240b:4005:115:d950::1%eth0"])).toBe(true);
    expect(hasGlobalIpv6Address([])).toBe(false);
    // An IPv4 literal must never satisfy an IPv6 question.
    expect(hasGlobalIpv6Address(["192.168.2.100"])).toBe(false);
    // A Tailscale ULA is overlay-internal and never reaches the internet.
    expect(hasGlobalIpv6Address(["fd7a:115c:a1e0::2836:3a25"])).toBe(false);

    expect(await hasIpv6DefaultRoute(async () => `${defaultRoute}\n${hostRoute}\n`)).toBe(true);
    expect(await hasIpv6DefaultRoute(async () => `${hostRoute}\n`)).toBe(false);
    expect(await hasIpv6DefaultRoute(async () => "")).toBe(false);
    // An unreadable table proves nothing, so it must not enable racing.
    expect(await hasIpv6DefaultRoute(async () => { throw new Error("EACCES"); })).toBe(false);
    // The incident host: no default route, only overlay and loopback rows.
    expect(await hasIpv6DefaultRoute(async () => server100RouteTable)).toBe(false);
  });

  // Fast unit: the exact host profile that produced the incident must select the
  // fix, end to end through the decision. Without this a regression in either
  // kernel probe silently re-enables the synthetic `connect ETIMEDOUT`.
  // Expected <100ms, maximum 5s; injected tables, no real network.
  it("classifies the incident host as IPv6-unreachable and stops racing", async () => {
    const state = {
      hasGlobalAddress: hasGlobalIpv6Address(["fd7a:115c:a1e0::2836:3a25"]),
      hasDefaultRoute: await hasIpv6DefaultRoute(async () => server100RouteTable),
    };
    expect(state).toEqual({ hasGlobalAddress: false, hasDefaultRoute: false });
    const enabled: boolean[] = [];
    const decision = applyOutboundFamily({
      state,
      enableAutoSelectFamily: (on) => { enabled.push(on); },
      currentAutoSelectFamily: () => true,
    });
    expect(decision.disableAutoSelectFamily).toBe(true);
    expect(enabled).toEqual([false]);
  });
});