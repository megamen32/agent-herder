# Remove unrelated phone banner

Human request15Oct: remove S21 free/busy strip from Agent Herder header.
Own src/web-ui/main.tsx import/render only. Unmount removes polling and CSS
from the frontend bundle; phone lease API/MCP/enforcement stays untouched.
Canonical main; preserve unrelated untracked OpenCode release artifacts.
No new tests for this two-line removable UI element. Verify frontend build,
actual served bundle and rendered desktop/mobile page where available.
Build category fast unit/build verification, expected15s/max150s, finite
512MiB soft=hard/CPU1/tasks128/swap0/IO10/temp256MiB/files20000, current source
guard with fresh measured service/native obligations. Browser on44 only,
existing managed Agent Browser route and finite native service budget.
Current plan: this bounded fast task; .planning/STATE.md original milestones
retained. Frontend-only activation, no backend/SDK/session restart.

Completed: frontend7491bfd compiled in5.14s, peak178110464B, swap/OOM0,
same-generation source-guard cleanup. Compared previous public pin3fc63f4:
ONLY two removed main.tsx lines across frontend/config/dependency inputs.
Published source before activation; new public pinned release and direct
service static files serve index-DT9VPUOm.js. nginx config canonical source
published ef0e50ac (private index preserves foreign infrastructure WIP).
nginx -t/reload succeeded, backend remains PID436876, old hashed assets retained.

Rendered acceptance: task-owned Agent Browser Chrome on44 through private SSH
forward to the actual production service.1280px and390px: actual chat header
rendered, S21 DOM count0, phone text absent, no s21-lease requests, mobile
no horizontal overflow. Same new JS as public pinned release. Public auth
continues302 unauthenticated; no credential/state copy or auth bypass.
First headed bootstrap had no X server; no page/screenshot existed. Retained
failed attempts. Explicit headless launch with short session name succeeded.
Direct static staging initially inherited private source file permissions;
fixed only hash-verified owned assets to644 after capturing blank-page evidence,
then actual JS200 and rendered acceptance passed. Public release was already644.
No new source tests for this removable low-impact element; frontend build and
real rendering are the proportional checks. Evidence .tmp/remove-phone-banner-
20261015/{activation,acceptance}.json and owned screenshots. No session input,
stop/resume, phone action or automation policy changed.
