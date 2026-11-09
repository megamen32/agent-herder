# Isolated browser fixture for the installed Herder smoke

The fixture runs its own agent-browser namespace, persistent profile and Vibe relay. The smoke still performs browser interaction through Vibe. The fixture manager uses the exact CLI session only to attest that a Vibe-created nonce belongs to the isolated profile, and restores the previous CLI tab selection before returning.

## Reviewed installation

Bundle `ci-browser-fixture.mjs` with the existing installed-smoke build. Install that immutable bundle at `/opt/agent-herder-ci-smoke/ci-browser-fixture.mjs`. Keep the bundle and service definitions controlled by root. The runner receives no direct browser or personal-account credentials.

Copy the example to `/etc/agent-herder-ci-smoke/browser-fixture.json`, fill current executable hashes, and pin the exact reviewed UI URL. A dedicated local runtime can use an explicit `http://127.0.0.1:<port>/` URL. Other plain HTTP origins, credentials in URLs and alternate configuration paths are rejected. Set the config owner to `root:roomhacker` and mode `0640`. The smoke fixture must pin this config's SHA256.

The state directory `/var/lib/agent-herder-ci-smoke/browser-fixture`, browser profile and relay state directory must belong to the runtime owner and have mode `0700`. Provision these directories explicitly before enabling the service. `proper-lockfile` serializes the manager's lifecycle and profile attestation. The manager cannot attach to the default or personal namespace.

The CLI child receives an explicit environment without `XDG_RUNTIME_DIR` or `DBUS_SESSION_BUS_ADDRESS`. This preserves the original namespace socket and PID directory under `HOME/.agent-browser/namespaces/<namespace>/run`. Setting `XDG_RUNTIME_DIR` would move that native runtime directory and invalidate the manager's process binding; the service manager's own environment is separate.

Install `ci-browser-fixture.relay.service` as `agent-herder-ci-vibe.service` and `ci-browser-fixture.service` as `agent-herder-ci-browser.service`. Review the relay ports, state directory, runtime UID and executable paths against the exact config before enabling either unit. The manager rejects a relay which does not own both loopback listeners, the expected systemd MainPID and the matching PID file.

Every browser service start first restarts its dedicated relay with one fixed systemd command, then waits up to ten seconds for the complete relay process and listener proof. This applies to an operator restart and `Restart=on-failure`. The maintained relay assigns anonymous extension connections from an in-memory counter; a fresh relay before Chrome therefore preserves the explicit `session_1` binding after every browser generation. The fixture never chooses a newly discovered session or changes its configured session ID. `Wants` permits the fixed prestart relay restart without propagating a stop back into the browser's start job. Only that fixed relay restart runs with root privileges; readiness, the browser manager and the relay run as the runtime owner.

## Bootstrap migration

A running unmanaged session cannot be adopted or relaunched by `serve`. To migrate an existing owned bootstrap fixture, record its current daemon, main Chrome and relay PID plus `/proc` start ticks, exact Vibe page ID and fresh nonce in an optional root-controlled `bootstrap` object. It contains `idle_timeout_ms: 1800000`, `relay_systemd_unit: "agent-herder-ci-vibe-bootstrap.service"`, `page_id`, `nonce`, and `daemon`, `browser`, `relay` objects with `pid` and string `start_ticks`.

Run `bootstrap-attest --page-id <id> --nonce <uuid>` after Vibe has set `window.name` to `herder-ci-anchor-<uuid>` on its owned UI page. This checks the original processes, configured profile, unique marker and actual UI API response. Its receipt explicitly says `managed: false`; it cannot satisfy installed CI. The operator can then stop only that proven bootstrap session and relay and start the reviewed managed units. Never issue `close --all`, stop a different profile, or infer identity from an old PID alone.

The managed browser starts with idle timeout zero and keeps a persistent private profile. On a fresh owned session, the manager opens only its configured UI URL and creates its own persistent fixture marker. It does not perform login, inject credentials, switch account or change the extension relay setting. Missing authorization remains a failed smoke until the approved credential consumer or operator restores that exact profile.

If a sign-in redirect clears the fixture marker, restart only the owned browser service after successful sign-in. The retained profile keeps its approved session and the new managed generation receives a fresh marker. `verify` does not silently recreate a marker or change the selected account.

## Fixed commands and receipts

Every command begins with `--config /etc/agent-herder-ci-smoke/browser-fixture.json`.

| Command | Purpose |
| --- | --- |
| `serve` | Start a new owned browser, resume the same verified generation, or recover a proven-dead owned generation under the rules below. |
| `wait-relay` | Wait up to ten seconds for the exact dedicated relay's process and loopback listener proof. Its READY result is not a browser acceptance receipt. |
| `verify` | Read the current managed generation, fixed UI anchor and same-origin API status without opening a new page. |
| `attest --page-id <id> --nonce <uuid>` | Correlate the smoke's Vibe-owned page with the exact CLI profile, then restore the original selection. |
| `bootstrap-attest --page-id <id> --nonce <uuid>` | Verify the separately pinned bootstrap generation before an operator-reviewed migration. |
| `stop` | Close only the current managed namespace after checking its stored process identities; reconcile the same attempt if the CLI response is unknown. |

A managed PASS includes `managed: true`, config SHA256, generation, exact profile, session, namespace, daemon/Chrome/relay PIDs and start ticks, pinned relay binding, `authenticated: true`, `api_status: 200`, an `api_content_type` of `application/json` with optional parameters, current origin and CLI tab ID. Attestation also includes the requested Vibe page ID and nonce marker. The generation incorporates the host boot ID, config digest and all three PID/start-time pairs. A PID reuse, changed binary, wrong process parent, different profile, missing loopback listener, ambiguous marker or failed tab-selection restoration fails the operation.

`verify` reports `vibe_page_correlated: false`: it checks the managed process and profile before the smoke constructs its Vibe client. The subsequent `attest` requires the client's fresh unique marker in that exact profile and reports `vibe_page_correlated: true`. The smoke must complete this attestation before sending model prompts.

The manager never returns credentials or session contents. The fixed API probe allows twenty seconds for response headers and requires status 200 with the JSON media type. It requests body cancellation without awaiting that promise or reading the body; a stalled cancellation cannot delay a known result. A network timeout remains `fixture_ui_api_unavailable` and does not imply that the account needs another login. Only CLI evaluation receives a twenty-five-second budget; other reads retain their six-second limit. The manager never accepts caller-provided JavaScript. Allow 60 seconds for a manager invocation so its bounded scan can restore the original selection before the parent times out.

The periodic health check defers to its next tick when a legitimate probe holds the fixture lock (`ELOCKED`). This is a deferred check, not a successful proof. Compromised locks, process identity failures and generation changes still fail the service. Lifecycle start/stop and explicit verification keep the original lock rules and acquisition bounds.

An uncertain start leaves a private `start-intent.json` and refuses blind replay. An uncertain close retains state until disappearance of the original daemon and browser is proven. It does not restart a daemon to close an orphan browser. A managed browser can still be closed if its relay is unavailable. `KillMode=mixed` first sends the stop signal only to the manager, allowing its checked native close and state cleanup to finish. The entire dedicated control group remains subject to the final kill after the sixty-second stop timeout. This prevents systemd from terminating Chrome and its daemon concurrently with the manager's close operation.

After a crash or reboot, recovery requires the unchanged trusted config, a valid stored generation including its original boot ID, proof that both old process identities are gone, no active namespace daemon, no exact-profile browser roots, and a verified current dedicated relay. Any surviving process or ambiguous identity blocks recovery. The manager writes a private recovery receipt and archives the old state before creating one fresh start intent. A leftover intent matching a fully verified running generation is reconciled without launching again; a different or unreadable intent blocks replay.

Run the focused contract tests with `node --test tests/native/ci-browser-fixture.test.mjs`. Unit tests establish the guards; deployment acceptance still requires real `verify` and `attest` receipts followed by the five-harness smoke.
