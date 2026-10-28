# Codex live service tier — подготовка приёмки

## До сигнала Root

- Browser session/namespace `ft28`, viewport 1440×1000; использовались только указанные `--auto-connect false --headed false --idle-timeout 300000`.
- Открыл read-only URL `http://127.0.0.1:18787/#/session/codex%3A01a1754f-0228-7553-bea6-cc89e40b5187`.
- UI разрешился в сессию «Собрать правки Agent Herder ↔ ZCode» (Codex), где видимая модель `gpt-6.1-sol`. Это не совпадает с предоставленным target `Codex 01a1754f-0228-7553-bea6-cc89e40b5187`; в этой сессии видны посторонние файлы/переписка, поэтому я их дальше не просматривал и ничего не нажимал.
- Снимок несоответствия в том же браузере: `target-mismatch.png`.
- Не трогал панель/переключатель tier, composer, prompt, stop/resume, model, effort или permissions. Никаких изменений не сделал.
- Закрыл только свою сессию Agent Browser `ft28`.

## Блокер и следующий шаг

Путь для target не установлен: заданный ID в URL открыл другую Codex-сессию. До корректного однозначного URL exact target безопасно провести Fast → Normal → Fast нельзя. Нужен точный target route/URL; после его получения сначала сверю title/session identity read-only и продолжу только после отдельного сигнала Root.

## Установленный UI bdb3ef2 — native tier UNKNOWN

- После отдельного сигнала Root открыл установленный UI по cache marker `bdb3ef2`, в exact confirmed Codex session. Экран показал тот же title, model `gpt-6.1-sol`, и disclosure `Скорость Codex` со статусом `Скорость: не подтверждена`.
- `Скорость Codex` отсутствовала в trimmed interactive snapshot; видна в full accessibility tree как DisclosureTriangle и на screenshot. Раскрыл disclosure визуальным click; кнопки Fast/Normal изначально были disabled, шёл read возможностей. Через штатную кнопку «Обновить скорость» запросил read-only refresh; кнопки стали доступны.
- Мой Fast был нажат ОДИН раз через ref `Fast`. После короткого ожидания native UI показал: `Codex tier update outcome is unknown: no matching native settings confirmation; do not replay. Исход не подтверждён; автоматического повтора нет.` В snapshot кнопки вновь disabled, статус остался «Скорость: не подтверждена».
- Снимок UNKNOWN: `fast-unknown.png`. До него снимки baseline и двух UI ошибок/загрузки сохранены (`baseline-bdb3ef2.png`, `speed-disclosure-error.png`, `speed-coordinate-error.png`, `tier-fetch-error.png`).
- Повтор Fast не делал. Normal и финальный Fast не выполнял: UNKNOWN блокирует безопасное продолжение последовательности без риска replay. Отправил Root точный статус; позднее Root сообщил, что его отдельная собственная попытка Fast также вернула UNKNOWN. Это отдельная операция Root, не подменяет мой клик.
- Ни composer, ни Stop/Resume, ни model/effort/permissions не менял. Закрыл только `ft28` browser. Не заявляю успешного переключения.

## Итог Root — установленное исправление c224c7a

Первоначальный вывод о другом target неверен: title исторический, exact ID соответствует Root. После исправления loaded-only attach прежний исход прочитан как native priority=Fast без новой записи. Через настоящий MCP Root выполнил новые разные изменения Normal/default и Fast/priority; оба вернули ok=true и подтверждение нативной среды. Итоговый GET — fast/priority. Собственный браузер Root `tr28` показал «Скорость: Fast», модель gpt-6.1-sol; `final-fast.png` сохранён и осмотрен. Это Root-приёмка, не успешная последовательность кликов tester. Глобальный config.toml побайтно сохранён. Root browser закрыт. Подробная квитанция — installed.json и RESULT.md.
