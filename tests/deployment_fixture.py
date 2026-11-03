"""Synthetic deployment fixtures. Never used as runtime configuration."""
import json
from pathlib import Path
from deployment_config import validate_node, descriptor_digest
EXAMPLE = Path(__file__).resolve().parents[1]/"deploy/fleet/deployment.example.json"
TOPOLOGY = json.loads(EXAMPLE.read_text())
TOPOLOGY["nodes"] = [validate_node(n) for n in TOPOLOGY["nodes"]]
DARWIN_NODE = TOPOLOGY["nodes"][2]
DARWIN_HOME = DARWIN_NODE["home"]
DARWIN_UNIT = DARWIN_NODE["unit"]
DARWIN_AUTHORITY = DARWIN_NODE["authorityTarget"]
LINUX_NODE = TOPOLOGY["nodes"][0]
