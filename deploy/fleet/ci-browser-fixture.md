# Isolated browser fixture for the installed Herder smoke

The fixture runs its own agent-browser namespace, persistent profile and Vibe relay. The smoke still performs browser interaction through Vibe. The fixture manager uses the exact CLI session only to attest that a Vibe-created nonce belongs to the isolated profile, and restores the previous CLI tab selection before returning.

## Reviewed installation

Bundle `ci-browser-fixture.mjs` with the existing installed-smoke build. Install that immutable bundle at `/opt/agent-herder-ci-smoke/ci-browser-fixture.mjs`. Keep the bundle and service definitions controlled by root. The runner receives no direct browser or personal-account credentials.

Copy the example to `/etc/agent-herder-ci-smoke/browser-fixture.json`, fill current executable hashes, and pin the exact reviewed UI URL. A dedicated local runtime can use an explicit `http://127.0.0.1:<port>/` URL. Other plain HTTP origins, credentials in URLs and alternate configuration paths are rejected. Set the config owner to `root:roomhacker` and mode `0640`. The smoke fixture must pin this config's SHA256.

The primary Vibe path stays in `browser.extensions_path`. An optional `browser.extra_extension_paths` array can add explicitly reviewed extensions, such as the node's bezbrowser profile copy. Every entry must be an absolute path without a comma, and the complete list must contain no duplicates. The daemon environment and Chrome's loaded extension paths must match this exact reviewed list; missing or additional paths fail verification. The Vibe relay and five-harness smoke transport remain unchanged.

The source-owned `ci-browser-launcher.py` is installed beside the bundle as a root-owned executable. The fixture selects it through `AGENT_BROWSER_EXECUTABLE_PATH`. It reads the same protected configuration, verifies the real Chrome binary hash and exact profile/load paths, removes only `--disable-extensions-except`, then uses `exec` to keep Chrome's PID and daemon parent. Existing load paths and screenshot arguments are preserved. This allows extensions installed persistently in the profile to run. The wrapper is included in build, provision and installed-file integrity receipts.

The browser configuration and its hash do not change for this launcher update. An already running legacy generation remains verifiable with its original checks; the next normal supervised stop/start selects the wrapper. New generations additionally prove that the restricting switch is absent. Installing the source artifacts does not itself restart a browser.

For a pinned Chromium build affected by stalled background CDP screenshots, the reviewed optional `browser.cdp_screenshot_new_surface: true` setting passes `--enable-features=CDPScreenshotNewSurface` through the CLI's supported `AGENT_BROWSER_ARGS` launch option. It uses Chromium's new-surface capture path without activating a tab. The native CLI merges this feature with its existing feature list. The manager checks both the daemon environment and the actual single Chrome feature switch, rejects a shadowing or disabling flag, and retains all other process/profile/extension checks. Omitted or `false` preserves the previous launch settings. Enable it only as a reviewed config change, with real background capture acceptance on that pinned browser.

When changing the extension list of an installed fixture, stop its current managed generation with the existing reviewed configuration first. Preserve a private backup of that config, its immutable bundle and the persistent profile's session state. Install the new bundle, update the root-controlled browser config and the installed smoke fixture's pinned config hash together, then start the same managed unit. A changed config must not be used to adopt an old running generation. Record real `verify`, Vibe `attest` and five-harness smoke receipts after restart.

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


## 2026-11-13 bezbrowser compatibility acceptance

The dedicated server-100 fixture was refreshed from source `72c069dbb4ff73dc7d76745015ae922627960588`. Its installed manager SHA256 is `130ccda333632b4a3d123c91c03f8b355695631e5546842918fc39de56cef504`. The reviewed configuration keeps the existing Vibe extension, adds the physical bezbrowser extension copy and enables the optional new-surface capture path. Chrome's actual single feature switch retained `NetworkService,NetworkServiceInProcess` and added `CDPScreenshotNewSurface`. The installed collector, bindings and general Herder runtime were preserved.

Acceptance on the real persistent Chromium 154 profile passed after a managed restart:

- All 28 focused fixture contract tests passed.
- bezbrowser retained browser identity `e6cc9d1e-326e-4bc3-b9d0-87c7c3e43d4e` and passed two independent principals, isolated input/clicks, lease rejection, a real MCP Task, two background screenshots and cleanup. Run `f7647f24-0ea5-4542-9246-4b66535c96e3` captured the screenshots in 586 ms and 1028 ms.
- The fixed manager's `verify` passed for generation `5facf343bfda8522e63e9055844909eebdbb4f7c46b453822fee052a12dc4222`, with the configured UI API returning 200 and JSON.
- The installed Vibe bindings opened a fresh owned page, passed the fixed manager's `attest` with `vibe_page_correlated: true`, then closed that page and all temporary transports. No model messages were submitted by this compatibility check.

The full installed five-harness smoke remains incomplete. Run `bezbrowser-ci-20261113-7e2fc1abe358` stopped before model submission and before creating its browser page, with identity UNKNOWN and `transport_or_provider_failure`; owned process cleanup passed. The existing fixture still pins runtime source `bba8b81e433853d1d8dc843646000c6f4cfa4b64`, whose runtime manifest is absent. This condition existed before the browser refresh. The earlier UI 502 was no longer present during the final verify and attest. Complete the five-harness gate after the independently owned Herder runtime binding is reconciled; this browser change does not replace that binding or weaken the gate.

Private receipts on server-100 are under `/home/roomhacker/.local/share/bezbrowser-deploy/fleet-20261113/linux-100/`: `ci-surface-activation.json`, `accept-cft-agent-herder-new-surface.json`, `ci-vibe-attestation.json` and `five-harness-surface.json`. The root-owned rollback copy is `/var/lib/agent-herder-ci-smoke/maintenance/bezbrowser-surface-72c069db-20261113`. The same dedicated browser, relay and CI runner services are active.
