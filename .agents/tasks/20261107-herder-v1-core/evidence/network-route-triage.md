# NETDIAG — ChatGPT page8: маршрут и адресный handoff

Статус: READONLY triage завершён. Найден конкретный локальный обход действующей LAN failover policy: `/etc/hosts` Mac Mini закрепляет `chatgpt.com` за VUSA. Причина HTTP/2 PING failure на конкретном соединении пока не доказана. Восстановление не выполнялось и не заявляется.

## CI receipts и запрет повторов

- Исходный CI receipt `chatgpt-page8-bootstrap-network-20261108.json`, 2026-11-07 21:40:09 UTC: document200, 22 failed JavaScript requests на **том же hostname chatgpt.com**, включая manifest, `net::ERR_HTTP2_PING_FAILED`; complete DOM, pending-home-input, profileLoading, auth_timeout. Это не доказательство разлогина или ошибки Herder.
- Новый `chatgpt-page8-single-reload-20261108.json`: один reload, job `0d5ee93cdb74ba2f270a77b2bf2a79dd`, completed/exit1/socket_timeout35s. Одно последующее DOM/auth чтение, job `843128ae615398073b044dd03cd03586`, completed/exit1/socket_timeout25s. **Эффект reload и текущее состояние page8 UNKNOWN. Бюджет reload исчерпан; повторять нельзя.** QA claim отсутствует.
- В NETDIAG не было browser tools, newpage, navigate/reload, evaluate, auth HTTP requests, model create/send, чтения cookie/profile/login или изменений инфраструктуры. Original saved model UNKNOWN не трогался. Singer sole owner DISARM/secret rotation100/44/88; NETDIAG не читает secrets config и не меняет lease/config/runtime.

## Наблюдавшийся путь

Безопасные SSH read-only проверки выполнены через канонические LAN endpoints. Время наблюдений приблизительно 21:43–21:48 UTC 07.11 (00:43–00:48 MSK 08.11).

1. `roomhacker@192.168.2.4` подтвердил hostname `mac-mini-2012.lan`. Обычный Chrome PID23535 слушает loopback9222; его NetworkService PID23564 имеет ESTABLISHED sockets на VUSA185.240.120.152:443 и отдельно на LAN fake-IP203.0.113.1:443. У этих Chrome процессов не найдено proxy/host-resolver command-line flags. `scutil --proxy` не содержит включенных HTTP/HTTPS/SOCKS/PAC параметров; только ExceptionsList/FTPPassive. Это не аудит расширений Chrome.
2. `/etc/hosts:91` содержит **`185.240.120.152 chatgpt.com`**, строка92 — www.chatgpt.com. Это блок строк87–111 с marker `# >>> bez vpn2 sni hosts >>>` и комментарием `# OpenAI/Claude via vusa Xray SNI edge`. Файл mtime2026-11-05T07:11:51-0800, size5037. Есть также другие старые OpenAI/Claude pins; их менять пакетно не предлагается. Canonical generator этого конкретного блока в узко проверенных scripts/templates не найден.
3. Дважды `dscacheutil -q host -a name chatgpt.com` вернул185.240.120.152. Прямые DNS query к192.168.2.1 и100.100.100.100 вернули203.0.113.1; повтор Tailscale DNS answer TTL16. Различие объясняется hosts pin, а не доказанным stale DNS cache. macOS DNS показывает Tailscale supplemental resolver100.100.100.100 наutun0 и LAN192.168.2.1 наen0.
4. Mac `route -n get 185.240.120.152` → gateway192.168.2.1/en0. Router `ip route get` → WAN gateway95.165.160.1, source95.165.165.65. **Conntrack** подтверждает Mac TCP443 flows к185.240.120.152 с обратным destination95.165.165.65, mark0: например sport54158/63395/53199/50224/54167 совпадают с Chrome NetworkService sockets. Таким образом эти соединения идут к публичному VUSA через WAN SNAT, а не через LAN HAOS selector.
5. Каноническая карточка VUSA:185.240.120.152 — US VPN/Smart Proxy, nginx stream443 и SNI edge/upstreams; product owner VPN Panel. Последующий VUSA→ChatGPT origin участок в этой сессии **не проверен live**. Нет capture/remote-IP поля, привязанного именно к failed request ID page8. Совпадающие hostname hosts resolution и browser sockets дают подтверждённый текущий configured path и очень сильную связь, но не заменяют per-request attribution для 21:40.

Текущий configured path для системного разрешения ChatGPT:

`Chrome / Mac192.168.2.4 → /etc/hosts185.240.120.152 → en0 → router192.168.2.1 → WAN/SNAT95.165.165.65 → VUSA185.240.120.152:443 → [canonical SNI relay → ChatGPT; last leg not live verified]`.

## Рабочая LAN policy, которую hosts pin обходит

- Router DNS upstreams live:192.168.2.101 и192.168.2.5#2053. nft rule: `ip daddr203.0.113.1 tcp dport443 dnat to192.168.2.101:443`.
- `smart-edge-failover --status` сначала вернул `active=transition` — недостаточно для вывода о поломке; повторное bounded чтение вернуло `active=primary`, оба DNS, table route via192.168.2.101. NAT rule наHAOS сохранена.
- HAOS container `app_27579e22_bezrabotnyi_transparent_smart_edge`, `/data/openai-route-health-state.json`: `available=true`, `selection_verified=true`, `chosen=fi-cdn`, `country=FI`, `fallback=true`, `preference=US-first`, `all_fail_rounds=0`. US lanes ok_streak0/err_streak37–83; несколько FI/DE lanes имеют успешные streaks. File mtime00:44:54MSK; проверен в00:46:46MSK. Это существующий health-worker receipt, **не новый наш HTTP canary** и не гарантия полноценной загрузки ChatGPT UI.
- LAN path по runbook:203.0.113.1:443 → router DNAT → HAOS Smart Edge → bundled sing-box/openai-us-route → healthy FI/DE fallback. Нельзя делать вывод, что page8 использовала этот selector, лишь из его здорового статуса: hosts pin выбирает другой маршрут.

## Дополнительная readonly проверка gateway после UNKNOWN reload

В21:48:29UTC GET `http://127.0.0.1:50260/healthz` непосредственно наMini успешно ответил:

```
gateway_pid=30224 child_pid=30229 paused=false browser_used=true
pause_reason=null connection_attempted=true child_exit_code=null
last_tool_error="Error: Cannot read properties of null (reading 'innerText')"
```

`lsof` подтвердил Python30224 LISTEN50260 и Google Chrome23535 LISTEN9222. Это доказывает читаемость локального gateway health и наличие listener Chrome, **не** успешность полного GPTAdmin→MCP→DOM пути и **не** текущую identity/page mapping. Последняя tool error без timestamp/request ID не атрибутирована к reload или auth observation. Паузы нет, поэтому оснований для operator/resume по runbook не получено. Gateway/browser не перезапускались. Причину socket_timeout по этому health нельзя выбрать между очередью/зависшей операцией/transport/DOM.

## Существующий владелец и один handoff

- Product/resource owner: `/home/roomhacker/apps/vpn-panel`, VUSA/SNI edge + Mac client routing; physical inventory owner `/home/roomhacker/ServersAdministartion`.
- Точный зарегистрированный network repair owner: **codex / roomhacker-server-100 / `01a1ac29-5ead-7307-a5fe-00c3e1ebe005`**. Coordination note `2f3b4fcb-4eeb-43ad-9702-9a7bdb91f31b`, updated2026-11-07T21:03:26Z, paths`.agents/tasks/20261107-us-route-repair/`. Его durable resource: `/home/roomhacker/apps/vpn-panel/.agents/tasks/20261107-us-route-repair/REPAIR.md`.
- Note/report честно говорят US connectivity NOT repaired, FI/DE alternatives available; root cause US provider/network unproven. Это исторический receipt владельца, не новая проверка его всех endpoints. В snapshot active sessions21:44UTC эта Codex session не присутствовала; не утверждается, что она сейчас выполняет turn. Новый owner/worker не создан, завершённая сессия не пробуждалась.
- Отдельно active наблюдалась opencode incident session `ses_e4874822effeg4nh3g5qVkoJ37`, title «Сервер vusa отвечает, но проверка входа на него не проходит | fleet-health». Это существующий доступ/incident resource, не доказательство передачи ей VPN Panel ownership. Не слать одно назначение обоим.
- Результат передаётся только Astra для **одного** handoff product owner. CI остаётся единственным browser operator, resource`mcp:shell:mac-mini-2012.lan:ChromeMacMiniCDP`, current page8; gateway resource`com.bezrabotnyi.chrome-devtools-personal` наMini. Нельзя заменять это другой страницей или новым профилем.

## Минимальный восстановительный шаг для владельца (не выполнен)

Предложить VPN Panel/Mac network owner адресно и с backup/review восстановить для **chatgpt.com** использование канонического LAN DNS, убрав только matching VUSA pin из `/etc/hosts:91`; проверить отсутствие другого exact pin и readback `dscacheutil`→203.0.113.1. Не заменять на новый статический адрес, не чистить весь hosts-блок и не менять proxy/certs/global DNS/HAOS policy. Существующий pin отличается от текущей отказоустойчивой policy; его снятие — минимальный проверяемый кандидат, **не доказанный fix HTTP/2**. Наличие соседних OpenAI pins учесть лишь при конкретной последующей наблюдаемой ошибке.

Старые browser connections могут продолжать использовать VUSA после изменения resolver. Поэтому этот шаг сам по себе не подтверждает UI recovery. После восстановления читаемости CI вправе сначала согласовать UNKNOWN operation с существующей page8 **только readonly**, проверить identity и DOM. Повторный reload запрещён текущим назначением; если для новой загрузки понадобится navigation/reload, это отдельное решение владельца, не автоматический follow-up NETDIAG. До готового composer, matching account и новой exact QA claim native create/send запрещены.

## Канонические инструкции и границы доказательств

Сначала прочитаны ServersAdministartion `AGENTS.md`, `infra/access-topology.md`, `docs/inventory/README.md`; затем exact inventory/runbooks. Canonical checkout HEAD32823a8d от2026-11-08T00:09:39+03:00; указанные inventory paths без локального diff. AgentMemory project recall вернул нерелевантные старые observations — они не использованы для топологии/действий. Применён linux-server-maintenance (SSH/status diagnostics); изменение конфигурации не запрашивалось и не выполнялось.

Primary references:

- `ServersAdministartion/docs/inventory/devices/mac-mini.md`: exact Mac/control/client-owner mapping.
- `ServersAdministartion/docs/inventory/devices/vusa.md`: US IP/SNI edge/product ownership; старые инциденты не принимаются за текущую причину.
- `vpn-panel/docs/15-smartdns.md`: remote Smart Proxy vs LAN Smart Edge, cached/literal-IP limits.
- `vpn-panel/docs/operations/20261103-openai-us-lan-routing.md`: US preference плюс healthy regional fallback, preserving streams.
- `vpn-panel/docs/operations/20261029-smart-edge-dns-stability.md`: dual DNS и policy parity.
- `vpn-panel/docs/operations/20261027-smartedge-failover.md`: existing `--status` diagnostic.
- `ServersAdministartion/templates/mac-chrome-mcp/README.md`: health-only does not connect Chrome; no automatic replay/reconnect; operator resume only for proven recoverable pause.

Не доказаны: точная HTTP/2 failure причина на US/ISP/origin, per-request socket attribution исходной page8, успешность UI через FI, полный gateway DOM readback после reload. Нет основания увеличивать auth timeout или исправлять native adapter по этим receipts.

## Evidence fingerprints

- `/home/roomhacker/agents-projects/agent-herder/.agents/tasks/20261107-portable-native-ci/evidence/chatgpt-page8-bootstrap-network-20261108.json` SHA-256 `530bfcc4b3801e5ac0d09bd00359c468316148dc43d1c7ef6bcf12214a7c1564`
- `/home/roomhacker/agents-projects/agent-herder/.agents/tasks/20261107-portable-native-ci/evidence/chatgpt-page8-single-reload-20261108.json` SHA-256 `016a87f393225121f3e6a5ec9db34c4f6c223c76a0d9f974068a782b16aaf863`

Written UTC: 2026-11-07T21:50:01.057243+00:00
