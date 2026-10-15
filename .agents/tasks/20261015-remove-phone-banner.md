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
