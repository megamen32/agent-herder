# Соседний OpenCode модуль

Во время узкой consumer-починки worker дополнительно запустил `tests/opencode-v2-protocol.test.ts`: 25/30. Это не зелёный результат всего модуля. Baseline отдельно не проверен; установленная регрессия не доказана.

Падения:

- `reads the selected V2 session mode and only its exact pending requests`: pendingRequests пуст вместо perm_selected.
- `reads v2 permission requests as pending session input`: needsPermission=false вместо true.
- `resolves the exact OpenCode combo ID into its complete configured OmniRoute provider leaves`: null.
- `recursively resolves nested configured OmniRoute combos and fails closed on incomplete trees`: null.
- `keeps a combo route verifiable when another enabled mapping serves the same combo under an unrelated name`: null.

Текущий узкий diff меняет нормализацию wildcard mode и обработку raw empty history; resolver модели и чтение pending requests не изменены. Проверка точных QA-сессий после установки 33f2405 подтверждает fullAuto и complete empty history. Эти наблюдения не используются как доказательство исправности перечисленных пяти контрактов. Ближайшая отдельная проверка — воспроизвести на неизменённой исходной версии с теми же stubs; не подменять этим полную пользовательскую приёмку цели.
