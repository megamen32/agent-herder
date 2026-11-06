# V003: real Codex CLI wire gate

Run `python3 crates/herder/probes/v003/run.py` from any directory with `codex` and Python 3 on PATH. It creates separate temporary Codex profiles, uses a dummy credential and an unreachable loopback model endpoint, starts only the recording stdio server, and records both sides of the wire. Each run ends by timeout because there is no model service. The client output files contain that expected failure and are not a model or consumer acceptance proof.

`strict` rejects legacy methods to represent the no-downgrade baseline. `legacy` permits a legacy initialize response and advertises Tasks, Skills and resource subscriptions. `future` uses a deliberately mismatched legacy initialize response claiming the future revision: its subsequent legacy requests show that merely echoing a new revision does not demonstrate the new protocol. The fixtures are not a conforming production server or a substitute for the V002 rmcp probe.

The trace captures startup and discovery, not a model-driven tool call, skill use, Task operations, reconnect, authenticated gateway, or unique native session binding. See `acceptance/contracts/primary-client.json` for the gate and scoped conclusions.
