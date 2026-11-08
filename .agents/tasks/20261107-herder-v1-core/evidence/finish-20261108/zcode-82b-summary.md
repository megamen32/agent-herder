# ZCode candidate 82b91db9: INCOMPLETE

Manifest SHA-256: `cff8e8dd19dd61358d0df1a4ec9d94f1fef0431f8af91f3b40eef74f437cd6b1`.
The reviewed stand ran once via the existing network-namespace/bwrap launcher,
using an isolated official ZCode supervisor and loopback-only fake model.
No real provider, browser, installed runtime or foreign processes were changed.

Two distinct native inputs and two fake-model answers were read back from the
same session; native full export, search, projects and restart/readback passed.
The fake model counter was 0 before and 3 after the exercise; two native
answers are proven separately from the provider HTTP request count.

Archive was attempted exactly once after restart/readback. Actual public wire
reply: `{"code":"unsupported_archive","effect":"none"}`, `isError=true`.
The stand correctly exited 1 instead of reporting PASS. No retry was issued.
This is an archive capability gap in the selected candidate; adapter/core repair
belongs to the integrator/assigned CLI owner, outside this source-fixture slice.

Full actual archive reply and safe consumer evidence: `zcode-82b-result.json`.
Exact command: `zcode-82b-command.json`. Complete output: `zcode-82b-run.log`.
Retained root: `/home/roomhacker/herder-artifacts/ci-runs/zcode-82b91db9-archive-ede4cb8ab457`.
Original durable receipt: `home/zcode-v1-receipt.json` inside that root.
The supervisor log confirms its own core stopped on SIGTERM and supervisor exited.

Next action: add/declare the native ZCode archive capability in the owning
adapter/runner, produce a new immutable candidate, then use a new isolated root
for affected acceptance. Do not repeat this run's archive or native sends.
