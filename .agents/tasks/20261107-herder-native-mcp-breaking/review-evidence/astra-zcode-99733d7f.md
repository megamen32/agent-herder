# ZCode source integration 99733d7f

SUPPORTED by independent Nietzsche review (01a1b453-5507-7b81-ae21-6853827cef0e), delivered by Astra on 2026-11-07.

Connection uses only selected server_root status/token, ready loopback status, disabled proxy/redirects, no process start/profile fallback. RPC request IDs match; foreign IDs are ignored, success201 accepted,202/203 errors; timeout/disconnect after possible write yields Unknown without replay. Reader checks selected instance, exact requested/returned sessionID and existing-only policy; keeps native message refs without inventing turn refs. create_on_instance binds the selected connection and receipt instance. create_once is a trusted transport seam, invokes create_session once, never sends specification as prompt; invalid input/initialize failure => DefinitelyNotSent before create, ambiguous result after create or missing ID => Unknown.

DefinitelyNotSent here means no createSession effect; capability/initialize RPC may already have occurred.

Independent command in herder-v1-fixture, source matching99733d7f:

```text
cargo test --offline --locked --manifest-path crates/herder/Cargo.toml --lib adapters::zcode::
6 passed; 0 failed
```

Six tests cover validation/normalization/fake create boundary. Full RPC wire matching is source-reviewed, not proven by those six tests. No live/native sends, no replay of V072D, no reviewer source changes. Actual public consumer acceptance remains separate.
