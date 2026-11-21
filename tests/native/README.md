# Native test model fixture

`test-model-server.py` and `scripts/test-model-server.py` are kept
byte-identical. Both provide the deterministic `text`, `tool-call`, and
`opencode-create` scenarios; the last one chooses the namespaced OpenCode MCP
create tool from the tools actually sent by OpenCode and records that choice in
`/_stats`.

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

For the real OpenCode consumer path, use --scenario opencode-create with
tests/native/opencode_mcp_create_stand.py. Its project config registers the
Rust herder_native_stdio server with codemode:false, so the fake model must
receive and call herder_native_stdio_create. The stand then proves the
durable create receipt, native prompt readback after restarting the owner
process, exact native ses_ session readback, same-key no-replay, and changed-payload conflict. The fake model must
receive the namespaced Herder tool and emit exactly one such call; OpenCode may
make additional harmless model rounds after the tool result, so the stand
requires at least the tool round plus one final model round.
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
journey, and fingerprints the mounted dependency-store file bytes and link text
both times. Nested symlink targets are not separately attested; the store digest
is an observation and is not compared to a signed dependency manifest. To create the stand and run this driver:

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

For the real Agent Herder Codex adapter consumer proof, build the current
checkout first and run:

~~~sh
npm run build
NODE_REAL=$(readlink -f "$(command -v node)")
CODEX_REAL=$(readlink -f "$(command -v codex)")
python3 tests/native/launch.py \
  --ro-bind "$NODE_REAL" \
  --ro-bind "$PWD/dist" \
  --ro-bind "$PWD/package.json" \
  --ro-bind "$PWD/node_modules" \
  --ro-bind "$CODEX_REAL" \
  -- /usr/bin/python3 "$PWD/tests/native/codex_ahap_receipt.py" \
  "$NODE_REAL" "$PWD/dist/ahap-codex-runner.js" "$CODEX_REAL"
~~~

This starts the compiled AHAP consumer over CodexAppServerAdapter, verifies
the advertised readiness methods, reads the session list, creates one
disposable native session, sends one message with a stable inputId, and reads
the exact native session and durable user/assistant messages back. The isolated
fake model must observe exactly one request. An uncertain delivery outcome
terminates the disposable child without replaying the message.

### Native ChatGPT and Z.ai browser smoke

On Linux, use Google Chrome, Node 22+, Python 3.10+ and the OpenSSL CLI.
Run these commands from the checkout. The owner profile requires a build path
with trusted ancestors.

```sh
build=$(mktemp -d "$HOME/herder-browser-build.XXXXXX")
cargo build --locked --target-dir "$build" --manifest-path crates/herder/Cargo.toml --bin herder-browser --bin herder_native_stdio
cargo build --locked --target-dir "$build" --manifest-path deploy/fleet/owner-bootstrap/Cargo.toml
npm install --prefix "$build/fixture" --ignore-scripts --no-audit --no-fund playwright-core@1.61.1
export PLAYWRIGHT_MODULE="$build/fixture/node_modules/playwright-core/index.mjs"
python3 tests/native/browser_adapter_smoke.py --bin-dir "$build/debug" --output "$build/receipts"
```

An existing Playwright Core installation can supply `PLAYWRIGHT_MODULE`.
Use `--harness chatgpt|zai` or `--surface ahap|mcp` for one case. A release
build can supply the same three executables via `--bin-dir`.

Each case starts Chrome with a private home and an incognito context. Chrome
maps the selected provider's HTTPS origin to a loopback server and accepts its
per-run certificate by public key. This serves the very first navigation from
Rust's independent CDP connection. Other HTTP and HTTPS connections go to a
loopback proxy that drops them. The MCP owner launches its compiled executable
as the embedded adapter.

The four default cases check two exact seed histories, two identical prompts
with distinct native user IDs, and the bound history after process restart.
AHAP also checks the reopened draft's `meta.sourceRoute` against the chat ID
recorded by the fixture. Owner MCP checks same-key replay and changed-payload
conflict. Each receipt includes the served document paths, accepted form
submits and account-mismatch results. Read and list timings use three warmups
and 20 measured round trips per operation by default. Set `--iterations N` to
change the sample size. Failed cases save screenshots in the output directory.

Run the lost-receipt cases for both providers in a separate output directory.

```sh
python3 tests/native/browser_adapter_smoke.py --bin-dir "$build/debug" --lost-receipt --output "$build/lost-receipts"
```

The site stores the first submit and returns success to the form, then answers
the adapter's read of that chat's messages with HTTP 503. Owner MCP must report
`outcome_unknown` with `retry=forbidden`. After receipt reads are restored and
the owner restarts, the same create key must return the original task and
outcome. The fixture checks its own submit ledger before restart, after restart
and after replay. Each checkpoint must contain exactly the same one submit.

For the site-specific checks on editor state, attachments, route changes and
account identity, run the following commands with the same Chrome installation.

```sh
node --test crates/herder/src/adapters/chatgpt/native.test.mjs acceptance/native/z-ai/list-scope.test.mjs
cargo test --locked --manifest-path crates/herder/Cargo.toml --lib adapters::zai::chrome_tests -- --ignored
```

### ChatGPT ↔ OpenCode mesh pair on Linux

A passing run delivers a PNG and a binary file from OpenCode to ChatGPT,
compares each original byte for byte with the copy downloaded by a separate
Rust process, and delivers the browser reply read by that process back to the
originating OpenCode session. The existing Node.js `OpenCodeAdapter` serves
OpenCode on this public mesh path, and the stand simulates the ChatGPT site,
model and Fleet relay on private loopback.

Use the Rust binaries and Playwright Core from the browser smoke build above,
Node with `--experimental-transform-types`, and Linux with `unshare`, `nsenter`,
`ip`, `bwrap` and unprivileged namespaces enabled. From the checkout, `npm ci`,
`npm run build:core` and `./node_modules/.bin/tsc -p tsconfig.json` prepare the
JS dependencies and both dist trees. For existing out-of-tree builds, pass
`--router-dist DIR` and `--resume-dist DIR`.

```sh
python3 tests/native/launch_chatgpt_opencode_mesh.py \
  --core "$build/debug/herder_native_stdio" \
  --bootstrap "$build/debug/ahap-owner-bootstrap" \
  --opencode "$(npm root -g)/@opencode/cli/bin/opencode.exe" \
  --playwright-core "$build/fixture/node_modules/playwright-core"
```

You can use `--opencode "$(command -v opencode)"` if it resolves to a
standalone Linux ELF with the v2 `/api/session` API. Append `--check` to mount
the inputs and display the stand's help inside a nested UTS namespace. Each
real run prints the path to its `evidence/proof/receipt.json` under a fresh
private directory in system temp or `--output-parent DIR`. Look for
`"status": "PASS"` in that receipt.
