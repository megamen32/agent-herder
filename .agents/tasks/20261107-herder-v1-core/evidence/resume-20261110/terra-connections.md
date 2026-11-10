# Terra: UserIO shared connection core (2026-11-10)

Owned paths: extension 0lib/connections.js0, 0lib/userio.js0, 0lib/oauth.js0, 0lib/agent.js0, and 0tests/connections.test.mjs0.

## API contract to Lead/Turing

- 0UserIOConnections.list/get/save/remove/accounts/observeAccount/updateBindings/subscriptions0 persist records under 0userioConnections0; legacy endpoint/global OAuth migrates once to 0legacy-default0 and remains retained.
- Account binding key is 0provider:userId:workspaceId0 (accountId is accepted as workspace component; 0account_scope0 is retained as native ChatGPT identity). ChatGPT bindings start empty for new identities; VK without proven native identity stays on 0legacy-default0.
- 0UserIOOAuth.accessToken/connect/status/disconnect(connectionId)0 uses per-connection storage keys and refresh locks. Same endpoint records cannot read one another's tokens. Legacy no-ID calls remain supported.
- 0UserIO.settings(connectionId)0 and 0UserIO.call(method,path,body,connectionId)0 carry explicit context. 0publishChatSnapshot(snapshot)0 selects by ChatGPT 0account_scope0, fans out independently, and returns per-destination failures.
- Agent poll query and result payload carry 0connection_id0 and 0agent_instance_id0; mismatched command context is rejected.

## Required Turing integration

Load 0lib/connections.js0 before 0lib/oauth.js0. Forward 0connectionId0 through RPC actions 0userioConnect0, 0userioStatus0, 0userioDisconnect0, 0gptConnectionStatus0, register and disconnect. ChatGPT core calls 0UserIO.publishChatSnapshot(snapshot)0 with native IDs/account_scope and must not recapture or broadcast credentials. Background/UI paths are Turing-owned and were not edited.

## Verification

RED: initial connections test failed because 0lib/connections.js0 was absent. GREEN: 0node --test tests/connections.test.mjs tests/oauth.test.mjs tests/agent-identity.test.mjs0 => 9 passing. Covers legacy migration idempotence, explicit A/B bindings, fresh account no implicit sharing, logout persistence, OAuth PKCE/readback, and stable agent identities. No live providers, models, prompts, phones, or notifications used.

## Architecture review revision

Reviewed against the owner reminder before merge. Added pure 0validateConnection0, 0transitionConnections0 and 0validateReceipt0 helpers. The transition does not mutate its input and returns an explicit 0storage.set0 effect descriptor; browser storage remains in the adapter functions. Explicit connection settings now resolve the selected connection record and reject unknown IDs. Explicit legacy-default OAuth uses the legacy key namespace, while a named connection never falls back to the global token. Focused suite is now 11 passing. This revision is still unmerged and requires Lead review of the remaining adapter integration with Turing's background loader.
## Fresh fixes before acceptance

- UserIOConnections now applies a serialized reducer over copied connection and binding state. Reducer input is validated before effects; endpoint policy accepts HTTPS or loopback HTTP only, connection IDs are validated, and binding updates reject unknown IDs. Storage remains an adapter effect.
- Explicit OAuth IDs reject unknown connections before endpoint resolution. Refresh captures a per-connection revision and rechecks it before requesting and before persisting; disconnect advances the fence and removes credentials, so an in-flight refresh cannot restore them.
- Agent polling runs an independent bounded loop per enabled connection. Command admission requires exact connection, principal and agent instance context; provider/account scope must be subscribed except for metadata identity discovery. Durable receipts are keyed by connection, principal, instance and command ID and block replay after worker restart. Arbitrary eval is rejected by the admission path.
- ChatGPT publication uses the verified existing POST /v1/messages route. Each native message uses route_id chatgpt, source chatgpt:<account_scope>, and <chat_ref>:<native_id>. No invented snapshot route is used. VK forwarding retains the original route_id plus message wrapper and fans out only selected subscriptions.
- A loopback HTTP fixture exercised the actual bridge runtime: two ChatGPT destinations received /v1/messages; a work failure did not block personal; VK received the original envelope. Focused runtime suite is 15 passing. No live providers, models, prompts, phones or notifications used.
