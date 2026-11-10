# Z.ai source lifecycle result

Herder main b28849e162684b9ab74031c4c95ca3f3130d65e8; UserIO main d208ac64447789e81417a89d1745ab54c68e95a5. Source only, not installed.

Verification: UserIO node tests zai.test.mjs and zai-lifecycle.test.mjs: 21 passed; Herder vitest tests/zai-userio.test.ts: 16 passed; TypeScript tsc --noEmit passed; git diff --check passed. Only isolated mocks: browser execution, provider, production identity, and real UI were not exercised. First-click test mocks the scripting call, so DOM semantics require separate integration validation.

Account: verified native auth.id is registered via existing observeAccount with sha256(raw user id) and empty new subscriptions. Existing binding survives subsequent observations. Test exercises deny before explicit binding and wrong scope.

Raw: returns a JSON envelope of UTF-8 decoded, unmodified native detail and batch response bodies; no display normalization. complete=false: consistent snapshot, original wire encoding, attachment bytes and full export are unproven. 200,000 UTF-8 bytes bound; exceeding it fails explicitly. Projects remain unsupported.

Required shared integration delta (Lead/Lovelace owns these files):
1. background.js importScripts includes lib/zai-lifecycle.js before lib/agent.js, and extension packaging must include that file.
2. agent.js allowed action-to-provider map: zai_raw, zai_first_send, zai_archive map to zai, applying existing subscriptionsForScope check; dispatcher maps zai_raw -> UserIOZai.raw(args), zai_archive -> UserIOZai.archive(args), zai_first_send -> UserIOZaiLifecycle.firstSend(args). Keep zai_scope as metadata and preserve command-result persistence.
3. shared browser runner forwards getRawTranscript for ZaiUserIoDriver as already planned; its existing wrapper must not set complete=true or serialize normalized messages as raw.

First-send durable draft uses shared BrowserChatDraftStore and UserIoAgentChannel command IDs; UNKNOWN is reconciled only using the original command receipt and matching input digest, without another send. Native input and chat IDs are validated. Alias persists for subsequent read/send and restart. Extension marks uncertain before calling click; newly created tab remains open after success or uncertain outcome. Direct UI behavior has not been browser tested and must be validated in an isolated fixture before release. The page helper supports textual native content exact equality only; other native representations fail closed to UNKNOWN.

Scope exclusions: no production provider action, browser, Mac, release/version/ZIP/install, projects, calls, or general plan changes.
