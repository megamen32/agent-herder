# Z.AI autopilot for existing ChatGPT sessions

This worker uses Z.AI to decide whether an idle ChatGPT session should continue, finish, or wait for its owner. Each target is an exact, enrolled V1 session in a protected owner profile. Two Chrome profiles are separate V1 instances even when both use the ChatGPT harness.

The browser transport uses the existing authenticated browser connection and dedicated judge tabs. The API transport is optional and needs its own usable Z.AI API resource package. A web subscription is not treated as evidence that an API key can make requests.

## Behavior

- The judge tries GLM-5.3, GLM-5.2, and GLM-5.3-Flash in that order. It repeats the cycle on a proven transient busy/overload refusal. Backoff yields between attempts and respects provider cooldowns.
- A busy target or judge slot does not hold the other ChatGPT sessions in a global queue.
- The latest real user request and the final assistant response are mandatory. A final channel label alone is not enough: the native completion flag/status must positively confirm completion. Older whole messages fit around this pair in a 128 KiB default context budget. This is a serialized-byte budget, not a claim about a model's token window.
- The mandatory pair is never silently shortened. It may exceed the soft context budget; an input exceeding the hard bound pauses that turn with an error. The browser additionally bounds the complete system and user prompt at 512 KiB.
- Generated autopilot instructions are recognized using the worker's durable records, native input/message identity, and the existing HumanStop generated-prompt ledger. They are not learned as new human instructions.
- A new human message, HumanStop, a running or permission-blocked ChatGPT turn, or a changed native revision prevents the proposed continuation from being delivered.
- An interrupted browser judgment is held for verification after a restart; an unconfirmed Z.AI click is not repeated automatically. A new completed ChatGPT turn can still be assessed.
- A continuation is recorded before dispatch. Accepted or uncertain sends are reconciled by the original task receipt or by a unique exact new native user message after the saved assistant anchor. They are never blindly sent again on restart.
- Authentication, access, security verification, invalid output, and exhausted billing/quota are terminal for the current observation. Z.AI API code 1113 is a resource-package refusal, not a transient 429.
- A completed task stays completed; the judge must not invent a new task simply to keep the chat active.

The worker does not change the NoticePlace incident workflow or its selected model.

## 1. Establish the browser bindings

Use the normal browser connection and its owner approval flow. Obtain a verified account scope and a specific owned browser page for each ChatGPT profile. An account scope is the SHA-256 account identifier reported by the adapter; a display name or a directory name is not sufficient identity proof.

The Z.AI browser judge also needs its own verified account scope. It opens its own judge tabs through the existing Chrome transport. A denied tab, an unavailable gateway, a sign-in wall, or a security check must be resolved through the owner connection. Never enable automatic consent clicking to get around these checks.

The existing browser runtime polling settings still apply. Preserve intentional pauses until the owner has authorized this automation and the exact bindings are verified.

### ChatGPT through Vibe

For a V1 AHAP ChatGPT owner, use `AHAP_BROWSER_TRANSPORT=vibe-mcp` and set
`AHAP_BROWSER_MCP_URL` to the verified Vibe service URL. Set
`AHAP_BROWSER_MCP_PROFILE_FILE` to its protected, owner-owned mode-0600 authorization
profile. Keep `AHAP_BROWSER_ACCOUNT_SCOPE` pinned to the independently verified
ChatGPT account.

The AHAP transport maintains one MCP client for its lifetime and exposes only tabs
created by that client. An existing user tab is not adopted. Permission dialogs
remain blocked for the owner to resolve; reads do not approve them.

Each browser profile must have its own verified connection. A relay that chooses
the first connected extension is not evidence of a specific profile. If a pinned
extension connection is lost or its account changes, establish its identity again
before resuming.

The installed Vibe extension can return an empty object for an asynchronous script.
The compatibility transport starts that script once, then reads the result using a
unique receipt in the same owned page. Losing that receipt never causes the script
or a possible Send action to execute again.

## 2. Enroll existing chats explicitly

A protected V1 owner profile can grant existing ChatGPT sessions using this field inside its owner object:

~~~json
"existing_sessions": [
  {
    "request_key": "owner-enroll-profile-1-chat-1",
    "native_session_id": "EXACT_ID_FROM_THIS_PROFILE_ADAPTER",
    "account_scope": "VERIFIED_64_CHARACTER_ACCOUNT_SCOPE"
  }
]
~~~

Use an account-pinned AHAP ChatGPT owner profile and a regular owner-owned mode-0600 profile file. Then run the protected local owner action:

~~~sh
herder_native_stdio --enroll-existing-owner-profile /absolute/path/profile-1.json \
  --request-key owner-enroll-profile-1-chat-1
~~~

The command verifies the exact native session by listing and reading it through that profile's adapter. It never creates a replacement chat or sends a message. Its separate enrollment receipt and current allowlist grant establish membership. A fresh create receipt is never fabricated.

To enroll every entry already present in that protected allowlist using one
browser adapter connection, use the mutually exclusive batch option:

~~~sh
herder_native_stdio --enroll-existing-owner-profile /absolute/path/profile-1.json \
  --all-approved
~~~

The batch checks each entry with the same native list/get verification and
authority/HumanStop checks as the single-key action. It flushes a separate receipt
after each success and stops on the first error. Keep the receipts in a private
file; rerunning the same approvals is idempotent. It does not discover or authorize
additional sessions.

Retain the returned opaque session reference. Do not substitute a native conversation ID for a V1 session reference. Repeat for the currently selected recent chats in each verified profile. An enrollment grant alone does not clear HumanStop.

Existing protected profile fields and the native V1 entry must also be configured according to the V1 owner-profile documentation. This enrollment extension is specific to existing ChatGPT sessions; it does not broaden other providers' membership.

## 3. Configure the worker

Copy [the example](../deploy/fleet/v1-browser-autopilot.example.json) outside the release into an owner-owned mode-0600 file. Replace every placeholder with verified values. The example is disabled and has no enrolled targets.

Set:

| Field | Meaning |
| --- | --- |
| profiles[].instanceRef | Exact V1 instance identifier for one ChatGPT browser profile |
| profiles[].nodeRef | Exact node from that instance's native address |
| profiles[].cwd | Exact cwd from the protected owner profile and native session |
| profiles[].sessionRefs | Explicit opaque references returned by enrollment |
| gptadminProfileFile | Protected existing GPTAdmin profile containing authorization for the native MCP service |
| statePath | Dedicated durable state file for this worker |
| pollIntervalMs | Poll interval, at least 30 seconds; default 60 seconds |
| zai.transport | browser for the authenticated web app; api for the separate API |
| zai.accountScope | Required verified Z.AI account scope for browser transport |
| zai.browserMcpUrl | Persistent Vibe MCP connection, validated against the installed GPTAdmin service |
| zai.browserMcpProfileFile | Optional separate protected authorization profile for that browser service |
| zai.sshTarget | Alternative existing Mac Mini Chrome transport; mutually exclusive with browserMcpUrl |
| zai.contextBytes | Default 131072 bytes for the mandatory pair and older context |
| zai.timeoutMs | Attempt deadline, up to 300000 ms |

For API transport, replace the zai object with:

~~~json
{
  "transport": "api",
  "baseUrl": "https://api.z.ai/api/coding/paas/v4",
  "tokenFile": "/absolute/path/to/owner-only-zai-token",
  "contextBytes": 131072,
  "timeoutMs": 90000
}
~~~

Use exactly one of tokenFile or tokenEnv. Credentials are references in the config, never literal keys. Only the official HTTPS Z.AI API route is accepted.

If the previous installation used a nondefault generated-prompt ledger, set AGENT_HERDER_HUMAN_STOP_STORE to that same absolute path in the worker environment. The default is ~/.local/state/agent-herder/human-stops.json.

## 4. Check and launch

Build the source using the repository's standard build commands. From a verified immutable release, validate without connecting to the browser or sending anything:

~~~sh
node /absolute/release/dist/browser-autopilot-main.js \
  /absolute/path/v1-browser-autopilot.json --check
~~~

Enable the reviewed exact target set by setting enabled to true, then launch:

~~~sh
node /absolute/release/dist/browser-autopilot-main.js \
  /absolute/path/v1-browser-autopilot.json
~~~

An example user systemd unit is provided in [deploy/fleet](../deploy/fleet/agent-herder-browser-autopilot.service.example). Replace its absolute release and configuration paths. Enable the service only after enrollment, connection, and a real browser acceptance check succeed.

A worker holds an exclusive lease for its statePath; a second worker using that file is refused. SIGINT and SIGTERM cancel active judging and settle the worker's durable state. The runtime rereads fresh native state before any ChatGPT delivery. To change the target list or configuration, stop the worker, edit the protected file, and restart it. Removed targets are disabled in persisted worker state.

## Validation scope

Unit/integration tests cover the fallback order, context preservation, native authority boundary, independent profiles, cancellation, generated-input provenance, and restart reconciliation. These checks are not a substitute for a live browser run: actual account scopes, model picker labels, provider availability, and final native delivery still require the owner's working browser connection.
