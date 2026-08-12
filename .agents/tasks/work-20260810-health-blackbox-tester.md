# Black-box tester task: Health incident user flow

Test only the user-facing computer-use surface. You have no source-code or
architecture context and must not inspect repositories, APIs, terminals, or
internal service state.

Scenario: a Health incident should appear in the user's Telegram Health topic,
show exactly three remediation plans, allow selecting one, and show progress
until a final resolved receipt with elapsed time and trace IDs.

Use only the supported real-user computer-use surface. If it is unavailable,
record `STOP_MISSING_REAL_SURFACE` with the exact transport evidence. Do not
send Telegram messages or mutate external state.

## Tester evidence (2026-08-10, fresh black-box pass)

- Selected mode: `only-new` / health incident user flow.
- Required real surface: supported user-facing computer-use surface for the Telegram Health topic; no Telegram send or external mutation permitted.
- Selected transport: Touchpoint desktop computer-use surface.
- Attempted orientation: `touchpoint/screenshot`.
- Exact result: `OSError: X connection failed: error 5`.
- Recovery/availability checks through the same supported surface: `touchpoint/diagnostics` failed with `Transport closed`; parallel `touchpoint/apps` and `touchpoint/windows` calls both failed with `Transport closed`.
- No UI became available, so the Health topic could not be opened and the incident flow could not be attempted. No Telegram message was sent and no external state was mutated.

### Verdict

`STOP_MISSING_REAL_SURFACE`

Reason: the only available supported computer-use transport could not establish an X connection and then reported a closed transport. Per Tester boundary, this is not replaceable with shell, source, HTTP/API, or synthetic checks.
