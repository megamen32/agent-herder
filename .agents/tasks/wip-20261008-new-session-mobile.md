# Restore new-session creation from the real Agent Herder UI

Owner: native Codex01a11b43. User says new sessions cannot be created; Agent Further is understood as Agent Herder. Preserve the live shared ZCode/Codex runtime and all foreign WIP. This UI work does not relax the communication backend safe-transition blocker.

## Confirmed consumer failure

At <=900px codex-theme hides .codex-navigation and styles.css hides .chat-pane while mobile-sessions-active. The only existing create controls live in the hidden navigation and chat composer. SessionList has search/settings but no create control. Navigation onNew does not switch to mobile chat, so programmatic open leaves the form hidden. openCreateSession also awaits adapters and models before opening, so a slow/blocked API makes even desktop clicks appear to do nothing. Generated native names have only minute precision; two creations in a minute collide. Current creation response ID is discarded and UI returns to list rather than opening that actual session.

## Small fix

Visible accessible new-session button in the session-list header. All create entry points open the form and switch to mobile chat immediately, loading adapters/models independently. Unique generated names include seconds+random suffix. Success uses the returned actual native sessionId to select and load its new chat. Existing POST /api/sessions, guards and native adapters remain unchanged. No model prompt or unsafe backend restart is needed for an empty Codex creation canary.

## Resource and acceptance gates

Reuse existing reviewed Herder verification budget: both existing global/project locks; UID headroom >=2GiB, UID memory full avg10<1/avg60<3%, host memory/IO full avg10<1%. One worker. Tests RAM512MiB/1GiB, swap0, CPU1, Tasks128, IOWeight10, wall120s/command100s, Node heap512MiB and RollDown1. Vite-only build RAM1/2GiB, swap0, CPU1, Tasks128, IOWeight10, wall120s/command100s, Node heap1GiB, existing dependencies, no backend build/restart. Stage static output under .tmp/new-session-fix and atomically replace only served static assets after commit/push. Existing live browser CDP only, one owned tab, own session namespace, no user machines or foreign tab navigation/close; screenshot before retry/cleanup on failure. Browser budget must be finite and gated, no unbounded Chrome launch.

At11:57UTC host full memory PSI11.92%/IO4.48%; tests/build/browser not admitted. Source reads/edits proceed safely. Pending: pressure admission, browser red at390px, targeted existing UI checks, Vite build, static-only deploy, desktop/mobile visible form, empty native Codex creation through the real UI and automatic selection of its returned ID, clean synchronized main. Do not claim completion from source alone. Canonical code map entry and final receipts follow.


34 existing UI checks passed. Browser red on existing borrowed CDP9226 owned tabC0D4D01BF7CBBA3CAF43C8C5653486BB failed before .sessions-heading rendered; its page-level captureScreenshot never answered. No screenshot proof is claimed, no foreign tab/reload/browser cleanup performed. Own hung screenshot client PID4031133 was terminated. Scope-contained own Agent Browser client ended; borrowed Chrome stayed live. The tab remains preserved until its owner surface can be inspected.

A fresh disposable, headed SERVER browser is permitted for this UI acceptance: it is not a harness daemon or a user machine. All Chrome/CLI descendants stay under one scope RAM1/2GiB, swap0, CPU1, Tasks256, IOWeight10, wall120s, own profile under project .tmp capped256MiB, one page. Both project/global locks and fresh pressure gate; keep native services untouched. Standard close is allowed only for this OWN new browser. No arbitrary browser recovery or user profile reset.
