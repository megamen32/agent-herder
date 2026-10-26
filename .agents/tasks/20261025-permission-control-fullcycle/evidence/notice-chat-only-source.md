# NoticePlace QA chat-only route source proof

## Scope and ownership

Owned NoticePlace paths (six):

1. `notification_center/http_api.py`
2. `notification_center/admin.py`
3. `notification_center/admin_http.py`
4. `docs/telegram-project-topics.md`
5. `tests/test_human_requests.py`
6. `tests/test_admin_topic_routes.py`

No NoticePlace runtime config was changed. The QA route must be configured separately for the isolated QA project (`noticeplace-qa-stop-20261023b` or a dedicated `qa-herder` project), never by redirecting production `agent-herder` to the QA chat. Any producer canary configuration must live in a separate isolated file, not the live global producer config.

Notice `NotificationCenter.create_human_request()` authorizes `request.project`
against the producer token at `notification_center/core.py:793-814`. A QA
project therefore needs its own QA-scoped credential (or an already scoped
wildcard credential); do not reuse a production token by changing its project.

## Change summary

- HumanRequest Telegram sender checks the separate `human_request_telegram_routes_json` project map first, then the exact project's legacy forum topic in `telegram_topics_json`, and only then the global default.
- An explicit HumanRequest route is accepted only when it has a numeric `chat_id` and either:
  - the existing strict topic form (`message_thread_id` is an integer greater than zero), or
  - explicit `chat_only: true` with no `message_thread_id`.
- Conflicting `chat_only: true` plus a topic ID is rejected before send. The ordinary project route still rejects absent/invalid topic IDs and does not fall back to the default chat.
- Bad or disabled explicit HumanRequest routes fail closed; they do not fall back to a legacy topic or default chat.
- `AdminConfigStore.save_human_request_route` persists destinations in `human_request_telegram_routes_json`; chat-only mode is independent of `telegram_topics_json` and never creates or mutates event topics. The existing forum topic admin remains unchanged.
- Notice admin UI has a separate HumanRequest destinations panel and preserves exact-project legacy forum topic fallback. Event routes and health cards remain on the unchanged `telegram_topics_json` topic path.
- Documentation records the opt-in setting and producer destination boundary.
- Herder receipt compatibility was reviewed separately: its exact Telegram receipt requires sent status, chat ID, and positive message ID; it does not require `message_thread_id`. No Herder source change is needed.

## Verification

RED before the sender change:

```text
PYTHONPATH=. python tests/test_human_requests.py HumanRequestTests.test_explicit_chat_only_project_route_omits_forum_topic
```

Failed as expected with `RuntimeError: Telegram HumanRequest project route has an invalid message_thread_id`.

Focused GREEN commands:

```text
PYTHONPATH=. python tests/test_human_requests.py HumanRequestTests.test_project_topic_routes_human_request_without_changing_other_projects HumanRequestTests.test_explicit_chat_only_project_route_omits_forum_topic HumanRequestTests.test_chat_only_project_route_rejects_a_topic_id
Ran 3 tests ... OK

PYTHONPATH=. python tests/test_admin_topic_routes.py
Ran 4 tests ... OK

PYTHONPATH=. python tests/test_admin_console.py AdminConsoleTests.test_resolved_telegram_cleanup_is_explicit_project_opt_in_without_restart
Ran 1 test ... OK

git diff --check -- notification_center/http_api.py notification_center/admin.py notification_center/admin_http.py docs/telegram-project-topics.md tests/test_human_requests.py tests/test_admin_topic_routes.py
clean
```

Broader checks and unrelated failures:

- `PYTHONPATH=. python -m unittest discover -s tests -p 'test_human_requests.py'`: 21/22 passed; the unrelated failure at `tests/test_human_requests.py:628` expected the first discovered MCP tool to be `ask_human`, but the already modified `mcp/notify_mcp.py` exposed `noticeplace` first.
- `PYTHONPATH=. python tests/test_admin_console.py`: one unrelated request timed out at its 2-second client timeout and logged a `BrokenPipeError`; the specific affected dashboard test passed separately as shown above.

## Release and live boundary

`deploy/README.md` identifies `deploy/noticeplace upgrade` as the immutable-release lifecycle; it deploys committed `HEAD` and atomically switches `/opt/noticeplace`. After source review/commit and canonical install, the explicit QA route can be saved through the admin UI; runtime route settings apply live. No install, restart, route save, Telegram invite, card send, or answer was performed by this worker.

Current scoped uncommitted diff checksum (six owned source/test/doc paths only):
`c1e9744b1ab5f57b727e4b5d2326f6cfd78b53d031a4180d834c5cacfc440b71`.
This is a diff checksum, not a source commit SHA or install receipt.

## Live acceptance dependencies

- The user's Telegram QA group was resolved from the UserIO conversation
  `conv_8824981e77ad14f6d7c4150c` to the original basic-group peer `-4832374378`.
  The stored migration service events identify the current destination as a
  supergroup; its exact current Bot API ID is `-1004308060380` and its UserIO
  conversation projection is `conv_470a1ac2d40fb1a82528a1c0`.
- The Notice bot identity was read with `getMe` as `@MySecretNotifyBot`.
  After the user's invite, read-only Bot API `getChat(-1004308060380)` returned
  `qa deusexcode`, type `supergroup`, and the same ID. `getChatMember` for bot
  `8612415098` returned `administrator`. The earlier `chat_not_found` result
  used the pre-migration basic-group ID, not the current supergroup.
- The existing UserIO admin proposal attempt used request ID
  `noticeqa-herder-permission-bot-invite-20261026-01` and returned the literal
  sanitized parser error `Expecting value: line 1 column 1 (char 0)`. The error
  happened during `/admin/prepare`; source order puts proposal persistence after
  successful preflight. No proposal/action was persisted and `/admin/execute`
  was not called. The request was not retried. Source evidence narrows the
  response to non-empty non-JSON from the connector's HTTP-success path; the
  installed endpoint/proxy/build root cause remains unknown.
- After source review and canonical install, save only a chat-only HumanRequest
  route for isolated project `noticeplace-qa-stop-20261023b` (or a dedicated
  `qa-herder` project with its own scoped credential) and use a separate
  canary producer config. Production `agent-herder` settings and global
  producer config must remain unchanged. Do not replay an accepted or unknown
  card request.
