# Native child completion -> parent wake

Installed core manifest d4add78186ef6d679915cc823e542329e365221c6e6e8d2db769d61090bcedb7. Server44 Codex0.167 native hooks initially untrusted. Owner explicitly approved headless confirmation; native `/hooks` TUI trusted only Herder Stop and SubagentStop; native hooks/list confirmed trusted/enabled with original hashes. No bypass flags or trust-ledger edits.

Actual second defect: native canary mapping omitted parent_ref required by the installed hook. Original no-wake receipts retained. Corrected producer mapping and fixture: Python3tests PASS, hook10tests PASS (prior fixture8FAIL reproduced). The corrected mapping was used for a new distinct child event in the same owned sessions. Native child turn01a1bca6-6763-73f3-b00c-42833cd1a75b -> deferred hook receipt19:33:09Z -> parent turn01a1bca6-79a5-7191-8e14-aa9e01e864fb, one exact parent reply. No manual parent send/reconcile. Initial readonly transcript probe failed transiently; later shared consumer reads confirmed both answers.

Four own native test sessions archived with confirmed receipts. Original failed runs preserved, never relabeled. Public wire test separately proves duplicate/restart/HumanStop suppression. Evidence native-wake-confirmed.json and protected retained live directory.
