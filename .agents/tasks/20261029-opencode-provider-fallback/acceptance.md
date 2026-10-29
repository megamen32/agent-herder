# OpenCode: автоматическое переключение при отказе провайдера

## Реальный результат 29.10.2026

Указанная владельцем сессия `ses_e7c7f9007ffeZgr4F03k3dax0M` (`atv-stale-closer-fix`) автоматически продолжена установленным Herder в **04:03:58 МСК** после `Provider zcode circuit breaker is open`.

- Новый маршрут: `omniroute/glm-5.3-flash-minimax-m3.1`.
- Состояние: `accepted`, `attempts=1`.
- Dispatch: `herder-quota:8270165f-3b9f-40a9-8a7e-68f62cee4f5f`.
- Native input: `msg_1852f64b3001y7qMmF0O7tbWFw`.
- Исходный отказ: `msg_1838070cb001H0naz32tAM46Ot`; исходный пользовательский ввод: `msg_183807074001Hb9UuwX1w5415l`.
- Независимый native readback подтвердил running, выбранный combo, новые text/tool_call/shell события и полезную работу с тестами/состоянием Git. Повторное чтение сохранённой квитанции подтвердило тот же dispatch и attempts=1.
- Ручного resume/send в эту сессию не было. Не заявляется завершение самой ATV-задачи или конкретная внутренняя ветка combo.

## Исправление и проверки

Отказ circuit breaker теперь отдельно классифицируется `provider_unavailable`, с существующими разрешениями, приоритетом моделей, ограничением свежести 24 часа и защитой от повторения accepted/UNKNOWN. Учтены обычный UI-ввод без Herder inputId и первая смена модели без previous. Неверный присутствующий previous по-прежнему отвергается.

TDD: classifier 15 PASS; focused launcher 15 PASS; финальная независимая native protocol проверка 2 PASS / 29 skipped. TypeScript/build PASS; artifact 14/14. Это отдельные проверки, не полная suite. Логи: `.tmp/provider-fallback-ui-final-tests.log`, `.tmp/provider-fallback-ui-final-build.log`.

Изолированные dummy fixtures не получили terminal failure за отведённое время из-за native retries. Они не доказали положительный fallback и не помечены PASS; положительная приёмка — указанная владельцем реальная сессия. Собственные fixture-процессы остановлены, собственная временная DB с credential copy удалена. OpenCode/OmniRoute core не изменялись.

## Установленный срез

Runtime commit: `28fcd27c1779cb2b04ebc8de04d689f3ecd9d0e9`; включает пользовательский `ebd2fe865e8ae6ddb76fc3afd596c3e7d4f982a2`.

| Узел | PID | Старт, 29.10 МСК | Результат |
| --- | --- | --- | --- |
| 100 | 194291 | 04:00:32 | 28fcd27, hardpinned ExecStart |
| 44 | 1000858 | 04:04:45 | 28fcd27, installer + независимый readback |
| 88 | 3326323 | 04:04:54 | 28fcd27, installer + независимый readback |
| Mini | 53935 | 29.10 04:10 UTC (время процесса) | 28fcd27, installer и независимый readback |

Логи установки: `.tmp/provider-fallback-28fcd27-install.log`, `.tmp/provider-28fcd27-44-final.log`, `.tmp/provider-28fcd27-88-final.log`. Transport artifact fingerprint: `eec961cf1a5b142a6e8d14bae455c40914783d80ac65c553bee3395a9a1c0c29`.

Пауза индексирования, STOP и действующие приоритеты проекта сохранены. Mini доступен по Tailscale: SSH host key совпал с закреплённым. При первой попытке watchdog отказал из-за изменившегося hostname; installer вернул f020a4b. Штатное имя mac-mini-2012.lan закреплено через scutil, после чего установлен 28fcd27; installer подтвердил readiness и 200 для sessions, policy, MCP. Независимый readback подтвердил hostname, sourceSha, current и процесс PID 53935. Это не отдельный OpenCode canary Mini.
