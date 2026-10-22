# Проверки восстановления квот — 22.10.2026

Прямое согласование владельца передано основной сессией: реализация, scoped main publication, build/restart Herder и собственные benign native OpenCode/ZCode consumer canaries разрешены. Рабочий OmniRoute сохраняется ради общего logging/context. Никаких core forks, платного fallback или скрытой смены provider.

Канонический checkout: `/home/roomhacker/agents-projects/agent-herder`; runtime: user systemd `agent-herder.service`, существующий immutable release path из ExecStart. GET управления: `http://127.0.0.1:18787`; native OpenCode endpoint из существующей конфигурации сервиса. Защищённый env reference: `~/.config/agent-herder/herder.env`; значения не выводить/не копировать в артефакты.

Fixture owner: `/root/herder_core`, отдельные session/input IDs и собственный `.tmp/` путь. Исторические cohort receipts, accepted/pending/unknown/held и HumanStop не возобновлять и не повторять. Перед каждым canary readback exact native identity и receipt. UI browser: собственные короткие session/namespace, auto-connect=false, headed=false; screenshot при ошибке до retry; close только своего browser.

Тесты Vitest используют `tests/vitest-isolation.setup.ts`, который до import изолирует durable state-dir и singleton ledgers. Проверка источника не означает публикацию/installed/consumer acceptance. Реальное восстановление GLM pending до внешнего quota reset; fake PASS запрещён.
