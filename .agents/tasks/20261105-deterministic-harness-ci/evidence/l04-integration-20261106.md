# L04: интеграция сред и preflight

Собранный из текущего дерева backend candidate, payload SHA `24323e9cce67ad0f208c96717a2a55d8e6bb850520b73d427cc3020e68b07a4c`, повторён на server-44 в изоляции. Hermes и Fast Agent: по две сессии и по две страницы transcript. Квитанция: `hermes-fast-candidate-20261106.json`. Общий результат FAIL: Hermes search partial; Fast Agent report не доказывает отсутствие partial; другие среды и установленный процесс не подтверждены.

TypeScript Hermes SHA `bd3265a6f0d03cb1c4db54aa8f28c6ff3abf36ee0cadd5684681304644f1ea97`, результат сборки JavaScript SHA `3aa2febed9f9445df2720921abda4b53009c61bd434bf483b37993dd895f9666`; это разные файлы. B2dc639f71c29494e81a0 и Bbd29cc3debc64bfc8177 закрыты с proof.

Runner интегрирует Hermes, Fast Agent, Qoder и отдельную Browser Chat fixture; Qoder требует тот же payload SHA, его поиск in-memory MCP; L17 receipt не привязан к candidate и content search partial. ChatGPT и Z AI требуют независимых readback реальных сервисов вместо fixture. До отсутствующего collector внешний fleet rollout отказывает до очистки/распаковки; L19 запрос на сверку отправлен deferred. Node-side validators передаются рядом с runner.

Тесты интеграции и no-mutation GREEN. Общий тест `tests/test_native_release_gate.py` содержит прежние synthetic PASS fixtures и теперь имеет 1 fail и 1 error. L04 progress CLI отказал в обновлении из-за ограничения на истекшую оценку; лист не закрыт и общий PASS не заявлен.
