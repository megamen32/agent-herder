"""Canonical LHC writer with the human's 60-minute rule for this plan only."""
from pathlib import Path
import sys

PLAN = Path(__file__).resolve().parent
TOOLS = Path('/home/roomhacker/.codex/plugins/cache/megamen32-plugins/last-human-commit/1.15.1/tools')

if len(sys.argv) < 3 or Path(sys.argv[2]).resolve() != PLAN:
    raise SystemExit(f'Usage: python3 {__file__} <canonical-command> {PLAN} [arguments]; other plans are refused')
sys.path.insert(0, str(TOOLS))
import lhc_plan_json

# Direct owner correction 2026-11-07. No installed file or global setting is changed.
lhc_plan_json.LEAF_ESTIMATE_CAP_MINUTES = 60
raise SystemExit(lhc_plan_json.main())
