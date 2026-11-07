# Native test model fixture

`test-model-server.py` is a byte-for-byte copy of the local, uncommitted
`/home/roomhacker/agents-projects/agent-herder/scripts/test-model-server.py`
read for V051A on 2026-11-07. Source SHA256:
`42415b4ad6a027a750da8d0f1179c120c7971adc2ea9d9ceffb419b7feefdef6`.
The source is another owner's work in progress; this copy is independently owned.

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
