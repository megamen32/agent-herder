# Переключение на Rust Herder, 8 ноября 2026

Владелец явно разрешил выключить старый Herder сейчас, восстановить его отсутствующие функции потом.

Старые службы100/44/88/MacMini/MacM1 остановлены, автозапуски отключены. На100 обнаружен внешний повторный старт после disable; unit остановлен и masked с защищённой резервной копией. Stand и fleet tunnels выключены. Удалён временный тестовый GPTAdmin ref; прежние remote AgentHerder refs и88HarnessMesh disabled.

Рабочий общий маршрут: https://mcp.bezrabotnyi.com/server/shell-roomhacker-server-100-agentherder/mcp → server100 AgentHerder stdio под roomhacker → installed compat → Rust core → существующий Codex AHAP. Один постоянно живущий core, без отдельных Herder daemon на клиентах.

Исправлен первый вызов compat без tools/list, source c52b44fe, интеграция eeba9ccf. Derived artifact herder-v1-d08a68ae-compat-c52b44fe сохраняет точные bytes core/adapters от d08a68ae; только compat новый. Manifest f0995dd347fe7d856281a8e60b39319ffbd5013e9b3ecaea04a0555a2211c49e. Профиль сохранил authority DB/gate/generation.

Проверены два cold installed запуска, первый discover до tools/list; публичный HTTP initialize/discover/toolslist/projects; 15 tools. /proc подтверждает exact core hash e82a8353 и один рабочий core. Модельных отправок в этой приёмке нет.

Настроен один backend codex-local. Пустой список projects имеет явную неполную coverage; полнота native sessions и пять установленных адаптеров здесь НЕ доказаны. Remote HTTP доступность не равна наличию remote harness backend. Межхостовое управление, wake, NoticePlace launch/repair, legacy UI и hooks отложены владельцем; новые расписания не ставились, секреты не ротировались. Состояние native sessions и прежние артефакты сохранены.

Подробности клиентов: server100-config-migration.md. Remote shutdown/readback: fleet-herder-remote-stop-receipt.md. Точные parent receipts: fleet-cutover-parent.json, installed-v1-cold-startup.json, installed-v1-http-cutover.json.

Конфигурации clients проверены:100 Codex/OpenCode/Claude/Hermes;44,88,MacM1 Codex/OpenCode;MacMini Codex. На каждом remotehost authenticated initialize/toolslist/discoverPASS,15tools,1instance. Новая native harness сессия для reload отдельно не запускалась.

Причина повторного старта100 найдена: zcode-session-resume-watchdog.timer каждые10мин запускает service с Wants=agent-herder.service. Timer отключён; disabled/inactive подтверждены. Legacy NoticePlace autofinish timer уже disabled/inactive. Agent-workspace — отдельный UserIOconsumer, active; его legacy loopback-only transport/API не мигрированы, принадлежат отдельному отложенному workflow. Он не является старым Herder daemon; чужойruntime не остановлен. Требуется отдельное восстановление потребителя вместе с legacy функциональностью.

Plugin legacy HTTP hooks отключены вsource и фактически активированных caches; LHC/AgentMemory сохранены. Автовозобновление от завершения children сейчас НЕ работает и не заявляется; его восстановление остаётся отдельным пунктом.
