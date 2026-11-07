import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('codex_receipt', Path(__file__).with_name('codex_receipt.py'))
receipt = importlib.util.module_from_spec(spec)
spec.loader.exec_module(receipt)


class CodexReceiptTest(unittest.TestCase):
    def test_requires_two_distinct_sessions_and_their_exact_readbacks(self):
        rows = [{'native_thread_id':'t1','native_turn_id':'a','input':'m1'},
                {'native_thread_id':'t2','native_turn_id':'b','input':'m2'}]
        readbacks = {'t1': {'id':'t1','turns':[{'id':'a','text':'m1 HERDER_TEST_MODEL_OK'}]},
                     't2': {'id':'t2','turns':[{'id':'b','text':'m2 HERDER_TEST_MODEL_OK'}]}}
        self.assertTrue(receipt.validate_receipts(rows, readbacks))
        self.assertFalse(receipt.validate_receipts([rows[0], dict(rows[1], native_thread_id='t1')], readbacks))
        self.assertFalse(receipt.validate_receipts(rows, {'t1':readbacks['t1']}))
        self.assertFalse(receipt.validate_receipts(rows, dict(readbacks, t2={'id':'t2','turns':[]})))


if __name__ == '__main__':
    unittest.main()
