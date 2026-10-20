# H33 host readiness and pre-admission fallback

`admitIntegratorSession` consumes a refreshed `FleetView` from the existing
fleet discovery service. A candidate must have a fresh `ready` host receipt,
advertise the requested harness in `createHarnesses`, and pass a separate
host-owned readiness observation for the exact checkout root, execution cwd,
harness version, required tools, `gpt-6-luna`, and resource readiness. A model
value that is absent, different, or whitespace is rejected before host admission;
the host create command always carries the exact pinned model.

The readiness adapter must resolve both requested paths on the selected host and
return a `HostPathResolution` attestation. It binds the exact requested checkout
root and cwd to normalized canonical paths, the H31 root identity, and the host's
realpath containment result. The code independently checks canonical containment
with the host's POSIX or Windows path rules; it does not use a string-prefix
check. A symlink or other canonical alias is accepted only when the host owner
explicitly attests equivalence for the requested root and cwd. The admission
port receives the canonical checkout root and canonical cwd, along with the
original requested paths for traceability. The path resolution is re-read before
admission and must remain identical to the one covered by the H31 proof.

The readiness observation supplies the runtime instance ID. The function then
calls the existing H31 `resolveProjectExecutionScope` contract with the exact
project, root identity, isolation-policy revision, attempt, host and runtime
instance. Only a fresh trusted proof from the runtime owner makes the candidate
eligible. Caller or model fields cannot substitute for that proof.

The selected host readiness and H31 proof are refreshed immediately before
each admission, and its exact execution binding is carried into the injected
admission port. Admission is sequential and bounded to two hosts. The first
host's explicit
`not_attempted` plus `retryable: true` receipt is the only outcome that permits
trying a second eligible host. Both calls carry the same `inputId` and
`attemptId`. Created, unknown, malformed, mismatched, thrown/lost, or
non-retryable outcomes stop immediately. In particular, an accepted or unknown
outcome never causes a second native create.

## Optional durable H34 attempt journal

The trusted internal `attempts` port is optional and is only provided by the
H34 composition. `request.attemptId` remains the stable operation ID across
host fallback. After current readiness/path/H31 checks, `prepare` atomically
reserves an attempt and returns its native `inputId` and `attemptOrdinal`.
Only `claimed: true` reaches native create. H33 uses that exact `inputId` in
the create command, verifies the returned receipt still carries it, and passes
the actual receipt unchanged to `record` before considering another host.
Prepare failure, an unclaimed reservation, a mismatched receipt, or uncertain
recording never reaches a fallback host. A lost create response is recorded as
UNKNOWN using the already reserved ID. If prepare fails before returning an
ID, H33 returns UNKNOWN without fabricating an ID; H34's durable read remains
authoritative. The caller request's `inputId` is never substituted for a
durable ID or used to rewrite a native receipt.

Without the optional attempts port the existing H33 source seam retains its
input behavior; it remains unregistered and cannot be used as the durable H34
composition.

## Source limits

The current `FleetHost` discovery DTO proves observed host identity, freshness,
state, generation and advertised create harnesses. It does not provide an
attested harness version, effective tool set, resolved checkout/cwd, model
availability, runtime instance ID, or resource-readiness receipt. These facts
are therefore required from an injected trusted `readiness.observe` port; this
change does not implement or claim that provider exists. Until an authorized
composition root wires such a port and the runtime-owner resolver, there is no
eligible host. This module defines no fallback issuer and does not launch or
share a session, change `src/index.ts`, or claim H31/H32/H34 integration or
product acceptance.
