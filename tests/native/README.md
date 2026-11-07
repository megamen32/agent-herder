# Native test model fixture

`test-model-server.py` is a byte-for-byte copy of the local, uncommitted
`/home/roomhacker/agents-projects/agent-herder/scripts/test-model-server.py`
read for V051A on 2026-11-07. Source SHA256:
`42415b4ad6a027a750da8d0f1179c120c7971adc2ea9d9ceffb419b7feefdef6`.
The source is another owner's work in progress and is left unchanged; this copy
is maintained with the native test fixture.

Run `python3 tests/native/launch.py -- COMMAND [ARGS...]`. The command receives
a fresh temporary HOME, XDG directories, TMPDIR, a minimal PATH and
`HERDER_TEST_MODEL_BASE_URL=http://127.0.0.1:<ephemeral-port>/v1`. The launcher
first creates a Linux user and network namespace, checks that it has no
external interfaces or routes, and brings up its isolated loopback. Both the
model and client run inside it; failure to establish isolation aborts the run.
Each process also runs in a bubblewrap filesystem namespace: system runtime,
this fixture directory, the exact installed Node package of a named executable,
and its disposable scratch directory are visible; the user's home directory
and unrelated `/tmp` files are not mounted. It requires `unshare`, `ip`,
`bwrap`, and permitted unprivileged user namespaces. The model
supports `/models`, `/responses` and `/chat/completions` including streaming;
`/_stats` is at the server root. The server and profile are removed on exit.
For a tool-calling fixture, pass `--scenario tool-call` before `-- COMMAND`.
The first model request returns `herder_test_tool` with call ID `call_test_1`
and arguments `{"value":"fixture"}`; later requests return the normal text.
The client must register that tool. This fixture does not execute the tool.
To exercise that exchange with a real Codex app-server:

```sh
python3 tests/native/launch.py --scenario tool-call -- /usr/bin/python3 "$PWD/tests/native/codex_tool_receipt.py" /absolute/path/to/codex
```

This verifies the tool name, arguments, thread and turn IDs, the final native
readback and exactly two fixture requests. It does not exercise Herder.

`candidate_driver.py` combines the Herder HTTP journey, paginated transcript
validation and MCP search for Codex and OpenCode. It requires an already
running disposable stand in a private loopback-only network namespace, with
an isolated project, fixture model and candidate process. Arguments are the
absolute candidate dist, project, Herder origin, model origin, Codex binary and
OpenCode binary; `HERDER_CI_TOKEN` supplies the stand's test-only MCP token.
It checks the network's interfaces and routes, but the caller must also create
and verify filesystem and network isolation before starting the stand. The
result is always `INCOMPLETE`: it does not prove the installed process or the
remaining required environments. The receipt verifies the source SHA and complete
release file/link fingerprint against the bundle manifest before and after the
journey; dependency symlink targets, not the shared store bytes, are hashed. To create the stand and run this driver:

```sh
python3 tests/native/launch.py --candidate /absolute/fleet/releases/RELEASE -- /usr/bin/python3 "$PWD/tests/native/candidate_stand.py" /absolute/fleet/releases/RELEASE /absolute/path/to/codex /absolute/path/to/opencode
```

The launcher exposes the named release and its detected shared dependency
store read-only, creates a synthetic user and temporary HOME, and removes its
own processes and state afterward. The stand checks isolation before writing
any configuration. Its quota and fleet-admission overrides apply only inside
that disposable environment. Release-gate integration remains separate work.
An `INCOMPLETE` result exits with status 2, so a CI caller cannot treat
candidate-only checks as successful acceptance.
Use an absolute executable path if it is outside the minimal PATH; explicitly
configure each test client to use the provided endpoint. No credentials or
existing profiles are inherited through the environment. Arbitrary project
sources and binaries outside the exposed locations are unavailable; add a
reviewed narrowly scoped fixture rather than exposing a whole user profile.

Run the fixture smoke with `python3 tests/native/smoke.py`. E001/E002 are not
executed by this fixture.

For a direct native Codex receipt check, run:

```sh
python3 tests/native/launch.py -- /usr/bin/python3 "$PWD/tests/native/codex_receipt.py" /absolute/path/to/codex
```

The check starts a real Codex app-server in the temporary profile, configured
only with the loopback test-model provider. It creates two distinct native
threads with one turn each and distinct input markers, then correlates each
thread ID and turn ID to its input and fixture answer via `thread/read`. It checks the model
request counter and reports the executable version and digest. A missing or
uncertain receipt fails without resubmission. Input markers are test data,
not native idempotency keys. This direct check does not exercise Herder MCP,
its adapter, or E001/E002. The smoke test checks a host-file sentinel as well
as host loopback; this is a scoped fixture, not a general-purpose sandbox.

For a direct native OpenCode receipt check, run:

```sh
python3 tests/native/launch.py -- /usr/bin/python3 "$PWD/tests/native/opencode_receipt.py" /absolute/path/to/opencode
```

The check starts a disposable OpenCode server, verifies its fixture provider
points to the isolated loopback endpoint, creates two native sessions, and
checks each input followed by a completed assistant answer. It prints the
native session ID before admission so uncertain outcomes are never retried.
Both the `/api/session` interface and the `/provider` + `/session` interface
are supported; the receipt names the detected interface and the binary version.
This does not exercise Herder, prove complete paginated transcripts, or satisfy
the release gate.
