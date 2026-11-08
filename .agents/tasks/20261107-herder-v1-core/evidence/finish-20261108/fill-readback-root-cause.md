# Fill acknowledgement recovery

Native54f Z.ai single diagnostic returned Cannot fill new-chat composer; no click attempted.
Exact page5 remained root with the exact supplied text visible; local draft pending.
Transport fill error is not proof that text was not inserted. Root retained at
/home/roomhacker/herder-artifacts/ci-runs/zai-54f-native-diagnostic-1840.
No original model request was repeated.

Fix reads composer after fill success/error, proceeds to a single send only on
exact text, and obtains a fresh snapshot for each bounded unapplied fill attempt.
Click result handling unchanged. No close of foreign pages. Tests applied-error
and stale-uid both providers RED4fail→GREEN119tests2suites; TypeScript PASS.
Two old tests falsely returned wrong composer but success click; corrected fake
readback to match their stated successful write. Exhausted write now never clicks.
