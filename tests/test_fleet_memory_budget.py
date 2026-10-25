"""Fleet node memory budget must stay above the measured working set.

L44: a fleet node bounded at MemoryHigh=384M throttled against its own limit
(memory.events high counter grew 15138 -> 39807 in two minutes), the reclaim
activity made systemd-oomd kill the unit with SIGKILL 9, and the node flapped.
The bound must therefore cover the measured peak and must be consistent between
the unit template and its drop-in.

Expected 1s. Pure file parsing, no service, no database.
"""
import json
import re
import unittest
from pathlib import Path

DEPLOY = Path(__file__).parents[1] / 'deploy/fleet'

# Measured on node 88 (2026-10-24) with a 1G/2G budget in place.
MEASURED_PEAK_BYTES = 433020928
MIN_HIGH_BYTES = 512 * 1024 * 1024
MIN_MAX_BYTES = 1024 * 1024 * 1024

SCALE = {None: 1, 'K': 1024, 'M': 1024 ** 2, 'G': 1024 ** 3}


def _memory_bytes(text):
    """Parse the first MemoryHigh=/MemoryMax= pair of a systemd unit fragment."""
    high = re.search(r'^MemoryHigh=(\d+)([MGK])?$', text, re.M)
    maximum = re.search(r'^MemoryMax=(\d+)([MGK])?$', text, re.M)
    if not high or not maximum:
        raise AssertionError('MemoryHigh/MemoryMax not found in unit fragment')
    return (int(high.group(1)) * SCALE[high.group(2)],
            int(maximum.group(1)) * SCALE[maximum.group(2)])


class FleetMemoryBudgetTest(unittest.TestCase):
    def test_unit_template_covers_measured_working_set(self):
        high, maximum = _memory_bytes((DEPLOY / 'linux-node.service').read_text())
        self.assertGreaterEqual(
            high, MIN_HIGH_BYTES,
            'fleet node MemoryHigh must not throttle below the measured working set')
        self.assertGreaterEqual(maximum, MIN_MAX_BYTES)

    def test_memory_dropin_matches_unit_template(self):
        high, maximum = _memory_bytes((DEPLOY / '30-memory.conf').read_text())
        template_high, template_maximum = _memory_bytes((DEPLOY / 'linux-node.service').read_text())
        self.assertEqual(high, template_high, 'drop-in and unit template disagree on MemoryHigh')
        self.assertEqual(maximum, template_maximum, 'drop-in and unit template disagree on MemoryMax')

    def test_memory_dropin_exists_and_is_shipped(self):
        self.assertTrue((DEPLOY / '30-memory.conf').is_file())


class FleetMemoryBudgetCoverageTest(unittest.TestCase):
    """L64: node 44 carries the budget of node 88 from one and the same source.

    The budget is a drop-in of the fleet unit, so it survives a reinstall only
    when its bytes live in the repository. One file serves every fleet node
    that carries it; a per-node copy would be a second truth.
    """

    def test_shared_dropin_source_names_both_fleet_nodes(self):
        text = (DEPLOY / '30-memory.conf').read_text()
        for node in ('44', '88'):
            self.assertRegex(text, r'(?m)^#.*\b' + node + r'\b',
                             'the shared memory drop-in must name node ' + node)

    def test_fleet_nodes_44_and_88_share_one_unit(self):
        topology = json.loads((DEPLOY / 'nodes.json').read_text())
        fleet = {node['id']: node for node in topology['nodes'] if node.get('kind') == 'fleet'}
        self.assertEqual(sorted(fleet), ['44', '88'])
        self.assertEqual({node['unit'] for node in fleet.values()},
                         {'agent-herder-fleet.service'})


if __name__ == '__main__':
    unittest.main()
