# ISOREVIEW: exact RED classification

This review changes no production source. Parent owns duplicate-scope fixture
and Z.ai account-drift repair; SolK owns the ChatGPT driver. No browser/network,
native mutations or installer actions were used. Four local tests: one positive
control and three expected-behavior regressions. Current unresolved regressions
are intentionally RED, not xfail or silently accepted behavior.

Command, exit code and exact source SHA-256 before/after are retained in
`profile-isolation-review-snapshot.json`; output is in
`profile-isolation-review-run.log`. Changes made by other owners after that
snapshot are not covered by this verdict.

## RED 1: duplicate scopes accepted by the multi-account consumer

Classification: confirmed fixture/input-validation defect, not a Rust routing
or browser isolation failure, and not a fake-harness crash mistaken for one.

`tests/native/v1_multi_browser_stand.py:96-119` checks scope formatting inside
the loop but not uniqueness. Test calls the real `run()` with `[A,A]`, a local
digest-valid fixture manifest and a nonexistent run root. Only native bootstrap
is mocked; it raises the deliberate sentinel `native bootstrap reached`.
Observed output: RuntimeError, bootstrap_calls=1. Expected: ValueError and zero
bootstrap calls. Thus duplicate input crosses the native bootstrap boundary.
It does NOT prove the whole duplicate-account case would PASS; later steps are
deliberately not executed. Concrete risk: an operator can accidentally submit
the same account twice while intending two distinct profiles.

Owner: parent. Fix is input cardinality/uniqueness validation before bootstrap.
No source change by this reviewer.

## RED 2: duplicate persistent ChatGPT markers choose the first page

Classification: confirmed ambiguity-guard defect in ownership resolution;
not proven cross-account access or a model send.

Two pages have plain ChatGPT root/conversation URLs after SPA navigation;
both answer the actual account-scoped `window.name` ownership probe with true.
The real driver calls the real `resolveOwnedTab`. URL-marker duplicate detection
does not apply. `src/adapters/browser-owned-tab.ts:70-80` returns immediately on
the first persistent owned marker and never examines the second. The driver's
`verifyPinnedAccountScope()` resolves successfully instead of rejecting with
duplicate_owned_browser_tabs. The subsequent mocked account response is A;
its real account guard would still reject a wrong account.

The fake transport is intentionally declarative: it supplies list_pages and
evaluation results, does not execute a real browser or inspect live names. The
source early return independently establishes why the second marker is unseen.
The precondition (two identical window names) is possible after duplicate-tab
creation/restore but was not observed live by this review. This is a concrete
negative ownership-contract case, not proof that two accounts were mixed.

Owner: parent/SolK as assigned. Resolver must detect multiple persistent matches
as well as URL-marker matches. Reviewer made no source change.

## RED 3: Z.ai create rebinds a verified A instance to B

Classification: confirmed runner/driver mutation guard defect, with one stated
test seam; no live cross-account send/archive is claimed.

Test uses the real configured factory, AHAP server, BrowserChatAdapter.createSession
and ZaiCdpDriver.createChat with isolated draft storage and fake Chrome transport.
Factory verifies A through the real ZAI_LIST_API_SCRIPT selection. Passive
adapter.init is replaced with a local hook that switches the fake page's actual
account to B. This models an account switch after verification; accountVerified
and driver cache still name A when the runner checks them. No expected-scope
guard is mocked away in create/driver.

The actual AHAP create request succeeds and returns `zai::draft%3A...` rather
than an account error. `src/ahap-browser-runner.ts:216-219` uses cached
assertAccount only; `src/adapters/zai-cdp-driver.ts:444-451` then overwrites
accountScope from B and creates the durable draft under B's scope without
checking expected A. That is the exact proven effect. Subsequent send behavior
and a live request to B were not executed or proven.

Why the init hook is legitimate: it substitutes the unrelated passive inventory
scan while keeping production account verification and mutation path. Account
drift can also occur between real verification and a later create request. This
test does not claim passive initialization itself causes the account switch.

An intermediate test attempt used the real passive scan with an incomplete
fake snapshot; it failed during init with stage=adapter_init. That failure WAS
a fake-harness error and was discarded/corrected. The current regression first
asserts successful AHAP init, then fails specifically because create returned a
draft. Do not use the intermediate init failure as product evidence.

Owner: parent for the account guard, Kierkegaard for his assigned browser/Z.ai
source slice. Reviewer made no source change and sends no duplicate assignment.

## PASS control and proof limits

Account A archive selected page 7 and, after renumbering and fresh-driver
restart, page 41, while B remained on pages 11/3. Fake transport records actual
selected evaluate_script page IDs. No new_page/navigate/close action occurred.
The archive script response itself is mocked: this proves account selection,
not native archive, HTTP PATCH semantics, one-core routing or full live acceptance.

The existing Rust multi-profile test separately uses identical native IDs and
separate authorities and checks first-account archive leaves the second alone.
This review did not rerun it or substitute its proof for the browser-driver tests.

## MV3 live facts supplied by owner, not probed here

Owner states extension 0.9.11 is installed in the Mac Default profile from
`/Users/roomhacker/Downloads/Universal-UserIO-Agent-0.9.11`, extension ID
`aoigpennaaneniokbkochaojddgifamc`; multiple service-worker target IDs were seen.
Gateway evaluation returned `Chrome access unavailable`. Chrome quit was executed
for the five-minute quiet window. These are supplied live observations, not
independently verified by this offline slice.

This replaces only the earlier unknown about installation. It does not establish
which worker fired which request, or that all observed worker targets belonged
to this extension/version. Static ZIP findings remain: background.js starts GPT
sync alarms, sync issues auth/list/detail reads, and there is no 429 handling.
Chrome quit should stop that browser's workers; no browser reopen/probe was made
here and no five-minute quiet measurement is claimed by this reviewer.
