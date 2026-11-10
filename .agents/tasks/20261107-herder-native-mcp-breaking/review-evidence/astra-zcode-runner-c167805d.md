# ZCode offline runner delta c167805d

SUPPORTED for the observed timeout cleanup bug and supplied-path symlink rejection. Astra reviewed the diff and independently ran the existing offline suite in herder-zcode-native on 2026-11-07:

```text
python3 -m unittest discover -s acceptance/native/zcode -p test_runner.py -v
Ran 3 tests in 2.006s
OK
```

The timeout now sends SIGKILL to its original isolated process group even when its leader already exited after SIGTERM, fixing the reproduced surviving-grandchild heartbeat. run and explicit cleanup reject the supplied symlink before resolve. Tests preserve evidence/profile and target only test-created PIDs/groups; native ZCode, model calls and old UNKNOWN V072D were not replayed.

This proves the offline runner, not ZCode create/deliver/read or recovery of the previous unknown action. Earlier source a79ed7f8 plus delta c167805d are integration inputs; application/create module wiring remains separate.
