# Fast/Normal существующей Codex-сессии — установлено

Backend `c224c7aab317aebcc17f266bff575cb075b78909`, PID672679,
28.10.2026 16:58:46 МСК. Публичный frontend bdb3ef2 побайтно совпадает
с frontend окончательной сборки; ingress62e0a5d9 установлен.

## Доступное управление

- MCP `get_service_tier` и `set_service_tier`: exact sessionId, harness=codex,
  hostId; serviceTier=fast/normal. Удалённый вызов идёт существующим peer transport
  на владельца сессии и требует версии Herder с этой возможностью на том узле.
- HTTP GET/POST `/api/sessions/codex/:id/service-tier`, точный локальный hostId.
- В чате рядом с выбором модели раскрывается «Скорость: Fast/Normal».
- Режим применяется следующим ходам; модель, reasoning и текущий ход не меняются.
  Незагруженные сессии автоматически не запускаются.

## Реальная приёмка

Точная собственная сессия `01a1754f-0228-7553-bea6-cc89e40b5187`
сохранила `gpt-6.1-sol`, status=running. Через настоящий MCP:

1. GET подтвердил Fast/priority, разрешив прежний неизвестный исход.
2. SET Normal вернул ok=true, normal/default.
3. SET Fast вернул ok=true, fast/priority.
4. GET подтвердил fast/priority в 17:02:11 МСК.
5. Реальный браузер показал «Скорость: Fast»; `final-fast.png`.

SHA глобального config.toml до и после совпал:
`b4208c9974383ae38bcaf2f728fe8a280af44a9bddb94ed9eb4f8ff6847b0d24`.
Нового сообщения/turn, новой native-сессии, смены модели или остановки работы не было.

## Исправленные находки

Первая реализация ошибочно ожидала settings-уведомление без подписки.
Tester и Root успели по одному разу нажать Fast, оба результата UNKNOWN сохранены;
это ошибка координации, не два успешных теста. Они разрешены чтением snapshot,
без третьего Fast-повтора. Далее Normal/Fast — новые разные изменения после
подтверждённого исходного состояния.

Штатный loaded-only `thread/resume({threadId,excludeTurns:true})` без overrides
возвращает настройки и подписывает клиента атомарно, не создавая turn.
Native `priority` распознаётся как Fast, default/null — как Normal;
пустой RPC ack сам по себе не выдаётся за применение.

23 focused native/permission checks, 3 API/MCP checks, TypeScript и полный build
прошли. Полная suite и массовое переключение чужих исполнителей не заявляются.
Первоначальные выводы тестировщика о неправильном заголовке были ошибочны:
исторический title относится к точному указанному ID; финальную приёмку завершил Root.
