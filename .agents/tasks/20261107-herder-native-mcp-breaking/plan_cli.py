"""Canonical LHC writer for this plan; the standard 15-minute limit applies."""
from pathlib import Path
import sys

PLAN = Path(__file__).resolve().parent
TOOLS = Path('/home/roomhacker/.codex/plugins/cache/megamen32-plugins/last-human-commit/1.15.1/tools')

if len(sys.argv) < 3 or Path(sys.argv[2]).resolve() != PLAN:
    raise SystemExit(f'Usage: python3 {__file__} <canonical-command> {PLAN} [arguments]; other plans are refused')
sys.path.insert(0, str(TOOLS))
import lhc_plan_json

# Latest direct owner correction 2026-11-07: use the installed 15-minute limit.
# No installed file or global setting is changed.
raise SystemExit(lhc_plan_json.main())
