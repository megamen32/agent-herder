# Plan

1. Add bounded account-local durable style profile in the existing autopilot state seam.
2. Have the existing judge consolidate human-only preferences and predict the next request
   in the same completion; inject profile into stop and batch planner requests.
3. Verify persistence, deduplication, concurrency, generated-input exclusion and cross-project
   consumption; scoped publish and real LLM canary without dispatching a native continuation.

Budget: existing build heap 1GiB, one worker; explicit cgroup RAM high/max 2GiB,
swap0, CPU100%, Tasks64, IOWeight25; temp/output <=100MiB; no GPU.
Fast unit expected10s/max100s. Focused integration (judge wire + store)10s/max100s.
Typecheck expected30s/max300s. Live read/LLM canary expected40s/max400s.
No nightly suite needed. Ordinary checks do not restart the daemon.
