# Luna release route: UserIO shared extension (2026-11-10)

## Scope and ownership

This is a read-only release-preparation note for Lead. The canonical Herder checkout is /home/roomhacker/agents-projects/agent-herder. The UserIO primary checkout is dirty/diverged and was not modified. The active extension worktree /home/roomhacker/agents-projects/.worktrees/userio-herder-shared-20261110 was inspected only; its active lib/UI paths were not modified. No commit, publish, Chrome reload, extension install, browser adapter, model call, or outbound message was performed.

## Confirmed route

The shortest permitted route is:

1. Build or select the reviewed MV3 artifact src/universal_userio/static/vk-userio-extension-mv3.zip and its byte identical alias vk-userio-extension.zip. The checked source manifest is Universal UserIO Agent, MV3, version 0.9.25. Source hash observed: 3d3c75f71a6a6fa600d823913adabc3735eb56c14cb20d96a0194c51873bd036 for both zip names.
2. On the Mac Mini, identify the existing extension directory for each named Chrome profile, then run extensions/vk-inbox/scripts/install_macos.py with --archive <reviewed-zip> --target <profile-extension-dir> --no-reload. The installer validates the single MV3 manifest and extension key, rejects unsafe archives and downgrades, preserves existing lib/config.js, writes a protected ZIP backup under ~/Library/Application Support/UserIO/extension-backups/, and changes no Chrome profile storage. Reload is a separate Lead action.
3. Keep each profile's protected UserIO principal and token-file reference separate. The reference is an absolute path to a worker-owned ordinary file with mode 0600; the token value must never enter this evidence or a command line. The principal must match the extension OAuth principal.
4. After Lead reloads the extension, run the isolated fixture proof: actual loaded extension -> loopback UserIO fixture, profile A = work and profile B = personal. Assert both profile/agent-instance/account-scope bindings and that a read from A cannot return B data. Then perform the required live existing-account ordinary Herder read and record the native completion plus readback. These are separate proofs; source checks, a package hash, an HTTP response, or a unit test do not satisfy either.

## Existing UserIO deployment boundary

UserIO is currently a three-container Docker deployment (frontend, backend, voice) with persistent state and an existing static route. The documented container route is authoritative for server changes; old runtime_release.py extension procedures and the one-time cutover path are not applicable. Any UserIO backend change must use the existing protected Compose/host configuration and preserve the retained previous container/image for rollback. The protected token reference remains a file path only. Do not inspect, copy, or print its contents.

## Single allowed Mac Mini live pass

The one bounded SSH pass used the configured alias mac-mini-2012.lan, and confirmed host mac-mini-2012.lan. It read only extension-backup path names, container image/mount fields if Docker was available, and Docker availability. It found protected backup ZIPs under /Users/roomhacker/Library/Application Support/UserIO/extension-backups/. The expected Chrome extension directory was not found at the single Default profile path probed. Docker was unavailable on this Mac Mini. No credentials, cookies, token URLs, configs, or raw transcripts were printed. No second live SSH pass is permitted in this worker scope.

## Prepared commands for Lead (future steps; not PASS)

Run from the reviewed extension worktree after Lead confirms the exact profile directory and artifact:

    set -eu
    ROOT=/home/roomhacker/agents-projects/.worktrees/userio-herder-shared-20261110
    ZIP="$ROOT/src/universal_userio/static/vk-userio-extension-mv3.zip"
    sha256sum "$ZIP" "$ROOT/src/universal_userio/static/vk-userio-extension.zip"
    python3 "$ROOT/extensions/vk-inbox/scripts/install_macos.py" \
      --archive "$ZIP" \
      --target '<exact Chrome profile extension directory>' \
      --no-reload

The installer itself is the staged backup/CAS-like safety boundary: it creates the backup before file replacement and refuses a mismatched key, downgrade, unsafe archive, symlink, or invalid manifest. Rollback preparation is to retain the emitted backup receipt and restore that ZIP to the same exact target only after Lead verifies the current target and profile identity. Do not invoke the installer against a guessed path.

For the isolated proof, Lead should use the existing loopback UserIO fixture API and the extension's normal UserIO transport. Seed two fixture principals and two account refs (work, personal), bind profile A to work and profile B to personal, then collect only redacted proof fields: profile label, agent_instance_id, account-scope digest, fixture request ID, selected account ref, and readback status. Do not log Authorization headers or fixture token values. The proof must include a negative cross-profile read assertion.

For the live proof, use one existing approved account and one ordinary Herder read through the extension/loopback UserIO path. Record the original request ID, native chat ref, completed native turn status, and exact readback identity; do not send, create, or retry an unknown operation. A successful source/test run or an installed package remains only preparation evidence until these two consumer proofs are independently observed.

## Exact blocker

The shortest route is blocked at live consumer proof because the exact Chrome profile extension target and the current Mac Mini installed extension state were not established by the permitted single read-only pass: the probed Default-profile extension directory was absent, while only backup ZIP names were visible. Docker is also unavailable on the Mac Mini, so no local UserIO container fixture can be inferred there. Lead must provide/derive the exact profile target through the already-approved browser/extension workflow and run the two required proofs after reload. Until then the package, source manifest, backup mechanism, and commands are prepared but acceptance is UNKNOWN.
