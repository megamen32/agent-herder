# Native test model fixture

`test-model-server.py` is a byte-for-byte copy of the local, uncommitted
`/home/roomhacker/agents-projects/agent-herder/scripts/test-model-server.py`
read for V051A on 2026-11-07. Source SHA256:
`42415b4ad6a027a750da8d0f1179c120c7971adc2ea9d9ceffb419b7feefdef6`.
The source is another owner's work in progress and is left unchanged; this copy
is maintained with the native test fixture.

Run `python3 tests/native/launch.py -- COMMAND [ARGS...]`. The command receives
a fresh temporary HOME, XDG directories, TMPDIR, a minimal PATH and
`HERDER_TEST_MODEL_BASE_URL=http://127.0.0.1:<ephemeral-port>/v1`. The model
supports `/models`, `/responses` and `/chat/completions` including streaming;
`/_stats` is at the server root. The server and profile are removed on exit.
Use an absolute executable path if it is outside the minimal PATH; explicitly
configure each test client to use the provided endpoint. No credentials or
existing profiles are inherited. This launcher is not a network sandbox: only
run test commands configured to avoid real services and messages.

Run the fixture smoke with `python3 tests/native/smoke.py`. E001/E002 are not
executed by this fixture.

For a direct native Codex receipt check, run:

```sh
python3 tests/native/launch.py -- /usr/bin/python3 "$PWD/tests/native/codex_receipt.py" /absolute/path/to/codex
```

The check starts a real Codex app-server in the temporary profile, configured
only with the loopback test-model provider. It creates one native thread and
two turns with distinct input markers, then correlates each returned native
turn ID to its input and fixture answer via `thread/read`. It checks the model
request counter and reports the executable version and digest. A missing or
uncertain receipt fails without resubmission. Input markers are test data,
not native idempotency keys. This direct check does not exercise Herder MCP,
its adapter, or E001/E002. The launcher is not a network sandbox.
