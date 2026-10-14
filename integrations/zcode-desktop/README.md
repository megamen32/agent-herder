# ZCode Desktop external task catalogue refresh — candidate

Status: source candidate and regression verified, **not installed**. The parent
AGENTS.md runtime-source policy requires a human decision before changing the
installed managed runtime after the native MCP/configuration path failed.

ZCode Desktop3.15.3 keeps each WindowHostController source snapshot indefinitely
until its own task service emits a workspace event. Herder commits valid task
metadata through a separate native server. Both processes open the same SQLite
index, but Desktop receives no event and omits the new IDs. Switching the native
Timeline/By project view did not repair it. Existing tasks/history remain intact.

The candidate observes the two catalogue file revisions every2s. It serially
refreshes only already registered, online local sources through the existing
native refreshSource path. It never sends an agent input, creates a task, starts
a runtime, changes pin/archive state or steals the current selection. Overlapping
polls coalesce; dispose clears its unreferenced timer. Remote/offline sources are
excluded. New project folders still follow ZCode's normal workspace registration.

`stage-catalog-refresh.mjs` validates the exact native controller SHA256, adds the
observer and cleanup, and writes **only** a separate candidate under project
`.tmp`. It never rewrites the installed ASAR. Version drift refuses staging.

Validation15Oct2026:
- Focused integration, expected5s/emergency50s: exact extracted installed native
  controller hides a newly added same-workspace task (RED); same native function
  plus candidate observes that identical ID after an external revision (GREEN).
- Fast unit, expected .1s/max2s each: unchanged/local/remote/offline filtering,
  timer disposal, slow-read coalescing/retry, and unsupported-runtime refusal.
- Full staged native module parses with Node. Native guard peak46,317,568B,
  no swap/OOM, same-generation cleanup confirmed. Existing source-job budget
  CPU1/RAM1,296,039,936Bhard/tasks128/swap0/private temp256MiB was retained.
- Private evidence: `.tmp/zcode-desktop-visibility-20261015/`, including native
  before screenshot, exact native source, RED/GREEN receipts and staged module.

Activation still requires the runtime policy decision, protected archive backup,
reviewed packaging/rollback and a safe native application handoff. It must not
interrupt active Desktop-owned CLI turns. Final acceptance must show a fresh
Herder task in the actual running Desktop, with original IDs/history retained.

The human approved this precise native-source exception15Oct after reviewing the
TDD candidate. The existing live controller observer was then activated without
replacing script source or restarting Desktop/host/CLI processes. Its initial
reconciliation restored the hidden airlock task. A new real Herder create_session
in that existing project produced sess_d6546a0b-4a48-4934-98f3-8202ffaeb6ab;
the actual Desktop automatically displayed it. No model prompt was submitted.

`asar_catalog_install.py` persists the same reviewed candidate using a journalled
single-entry ASAR update. It refuses unexpected source hashes, changed archive
identity, unsupported integrity format and variable-length header mutations.
It appends the candidate, fsyncs, then updates one fixed-size metadata object;
original host source bytes remain intact. A protected header/length journal
allows exact rollback. This needs under10MiB extra disk, not another340MiB copy.
Three focused archive tests prove SHA256 readback, byte-for-byte rollback,
unknown-source refusal and protection of later foreign archive changes.
