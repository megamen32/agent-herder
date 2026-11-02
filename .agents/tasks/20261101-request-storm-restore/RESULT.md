# Mac M1 ChatGPT rate-limit incident, 2026-11-01
## Verified facts
- User screenshot shows native conversation load failure, not a numeric rate in the image.
- Actual MacBook-Pro-User.local is arm64. Native ChatGPT PID17564 logs showed HTTP429 catalog and history failures, latest sampled12:37:56UTC.
- At12:32, active Herder100 systemd manager still selected release3a39fae. Its cache had90s TTL,100-chat prewarm every60s,250ms spacing, no working limit0.
- Source10-release-exec.conf changed externally12:34:05 to c0f5426 while diagnosis was ongoing. Our daemon-reload/restart12:37 activated that configured candidate; actual process confirmed c0f5426.
- Existing sourcecache fix is committed in c0f5426, but origin/main does not contain it. No remote push performed.
- Browser passive PerformanceResourceTiming on Mac mini pinnedpage6 confirmed multiple distinct history429 plus list429 about45s apart. Native M1 and browser both affected; common account/IP limiter is a hypothesis, exact server key is unknown.
## Changes
- Restored safe cache module on older selected3a39fae before reload; actual runtime now c0f5426 already contains fixedcache.
- Emergency non-pruning AGENT_HERDER_BROWSER_CHAT_PREWARM_LIMIT=0 in98-history-prewarm-pause.conf.
- Added shared browser-document15min cooldown for Herder-injected list/history scripts after429, before authfetch. Does not intercept native UI sends/fetch.
- Exactpatched API JS installed to actualc0f release, hash0a89f4c0d9b56492a2be1532aa262e88a9180a911a3b23b530cadb7de139569b.
- Startupguard refuses selectedreleases without metadata-cache, serializedspacing, shared429cooldown. Negativeoldrelease and positivecurrent tested.
- Local sourcecommit a2a2ac1, onlyAPI script, tests,guard. No push; no unrelatedfiles committed.
## Verification
-19 focusedtestsPASS and independentreviewPASS.
- Firstrestart12:37; second12:42:51UTC serviceactive. Data/cache retained.
- Cachefiles updated12:17–12:37:24; after12:37 sampled12:38:0.
- Passivebrowser12:43:15 observed real cooldownUntil12:57:40UTC, list/historycounter33. No testHTTP/historyfetch generated.
## Limits
- NativeM1 user-visible recovery not proven; allow service rate-limitwindow to expire rather than forcingreload.
- Cooldown pertab/document, not accountglobal; auth/session429 itself does not setcooldown. Existinginflightrequests notcancelled.
- UserIOmirror onlyDOMreads onMacmini, notM1; discretionaryQA paused byparent.
## Rollback
- Keep prewarm0 while diagnosing; do not restore unsafe bulkcache.
- Before anyrollback re-read actual systemdExecStart to avoid externalrelease race.
- OriginalAPI/cache modules in this folder. Remove only98dropin guard if intentionalrollback demands olderrelease, with incident owner approval; no auto rollback to requeststorm.
