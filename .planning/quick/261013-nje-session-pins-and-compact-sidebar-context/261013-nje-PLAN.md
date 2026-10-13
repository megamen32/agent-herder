---
phase: quick
plan: "261013-nje"
type: execute
wave: 1
depends_on: []
autonomous: true
requirements: [PIN-01, PIN-02, META-01, META-02, META-03, META-04]
files_modified:
  - src/web-ui/session-pins.ts
  - src/web-ui/session-list.ts
  - src/web-ui/session-row.tsx
  - src/web-ui/fleet/session-directory.ts
  - src/web-ui/main.tsx
  - src/web-ui/styles.css
  - tests/session-pins.test.ts
  - tests/session-list-settings.test.ts
  - tests/session-row-context.test.ts
must_haves:
  truths:
    - Browser-personal pins persist per directory scope and exact host/harness/native session tuple.
    - Filtered pinned sessions appear first, including collapsed children exactly once.
    - Compact rows expose truthful full context on desktop hover and keyboard focus.
    - Existing session selection, choices, folding and delivered chat remain intact.
---

<objective>
Личные закрепления, одна небольшая строка «Codex · 100» и desktop hover/focus подсказка с подтверждёнными сведениями. Root выполняет production edits и настоящую приёмку; этот документ — единственный quick plan. Работать в canonical main, сохранять чужой WIP, без новых branches/worktrees/agents и backend/native рестартов.
</objective>

<context>
@.planning/milestones/session-pins.md
@.planning/STATE.md
@src/web-ui/session-list.ts
@src/web-ui/main.tsx
@src/mesh/protocol.ts
@src/web-ui/fleet/session-directory.ts

Project detector: complete; original GSD root /home/roomhacker/.codex/plugins/cache/megamen32-public/gsd/1.42.3, quick planner contract — один план, 1–3 tasks. Использовать существующий registered ordinary build budget; неизвестный исход внешних действий не повторять.
</context>

<tasks>
<task type="auto">
  <name>1. Сохранить личные pins и точный project context</name>
  <files>src/web-ui/session-pins.ts, src/web-ui/session-list.ts, src/web-ui/fleet/session-directory.ts, tests/session-pins.test.ts, tests/session-list-settings.test.ts, tests/session-row-context.test.ts</files>
  <action>
  Хранить Set native tuple JSON.stringify([hostId,harness,nativeId]) в localStorage key agent-herder.session-pins:&lt;directory.scope&gt;; это личное предпочтение, не runtime pinActiveSessions. Local nativeId — meta.nativeSessionId при наличии, иначе session.id; remote — InventorySession.address.nativeSessionId. До известного scope/host tuple pin disabled. При смене scope немедленно перестать применять старый Set и запрещать запись старого состояния под новым scope; write failure сообщить, не изображать сохранённое закрепление.
  В directorySession сохранить exact project observation launchCwd/currentCwd/source, не подменять currentCwd launchCwd. Для local context переиспользовать projectObservation: meta.activeCwd + meta.projectSource дают текущий путь; иначе cwd/meta.launchCwd подписать «Каталог запуска (текущий не подтверждён)». Model/status/lastActivity брать только из native данных; неизвестное назвать явно.
  Существующие фильтры и поиск применить до promotion. Из отфильтрованных sessions отдельно вывести pinned в существующей сортировке, затем обычную иерархию с общим visited: pinned child под collapsed parent остаётся сверху один раз; одинаковые SID на разных host не смешиваются. Не обходить host/harness/project/showAll/search фильтры и не менять selection keys.
  </action>
  <verify>Fast unit RED→GREEN: scope A→B без утечки/записи A, неизвестный host/scope, storage failure, local/remote same SID different hosts, reload, search/filter, collapsed pinned child once, current versus launch/unknown paths. Expected 5s, maximum 20s.</verify>
  <done>PIN-01/02 и META-03 выполнены; pins и metadata не запускают и не продолжают native сессию.</done>
</task>

<task type="auto">
  <name>2. Подключить компактный SessionRow и доступную подсказку</name>
  <files>src/web-ui/session-row.tsx, src/web-ui/main.tsx, src/web-ui/styles.css, tests/session-row-context.test.ts</files>
  <action>
  В displaySessions/SessionList передать scope-bound pins/context, вынести SessionRow без смены обработчика onSelect и существующих choice/fold controls. Title остаётся главным, под ним одна приглушённая компактная строка harness · server; машинные short names выводить из точного host/имеющихся labels, без угадывания по CWD. Отдельная pin button рядом с selection button, без вложенных buttons; aria-pressed и русское «Закрепить/Открепить», min 44px mobile target.
  Desktop tooltip через React portal в document.body, вне clipped/sidebar scroll: полное title, harness, machine, подтверждённый current либо подписанный launch CWD, model, status, последнее валидное обновление. Наведение и keyboard focus дают одинаковый context, role=tooltip/aria-describedby; Escape закрывает до следующего входа focus/hover, blur/unmount/session смена тоже закрывают. Подсказка noninteractive, не закрывает pin action и помещается в viewport; не оставлять конкурирующий native title tooltip. Существующие delivery UI и compact sidebar ширину сохранить.
  </action>
  <verify>Focused unit/integration проверки row context, unknown metadata и safe controls; tsc --noEmit и существующий frontend build в ordinary release, combined hard deadline 180s. Expected release 60s, maximum 120s; timeout/incomplete не GREEN.</verify>
  <done>META-01/02; hover/focus доступен, pin не выбирает чат, выбор и folding работают.</done>
</task>

<task type="auto">
  <name>3. Доставить frontend и принять на настоящем сайте</name>
  <files>.planning/milestones/session-pins.md, .planning/quick/261013-nje-session-pins-and-compact-sidebar-context/261013-nje-SUMMARY.md, .planning/STATE.md, .tmp/session-pins-20261013/</files>
  <action>
  Root после source review и полного GREEN публикует только owned paths и frontend через существующий immutable release/SSO ingress; backend/native остаются действующими. На managed server44 или88 под своим конечным browser budget открыть настоящий HTTPS кабинет через normal SSO. Desktop: закрепить local+remote существующие rows, reload, unpin, проверить порядок/поиск/фильтры/свёрнутого child без дублей; открыть существующую сессию. Hover и Tab/focus/Escape проверить у краёв sidebar, включая различие launch/current. Mobile390px: subtitle читается, pin target ≥44px, нет horizontal overflow/крупной карточки. Фиксировать secret-safe screenshot до retry любой ошибки. Никаких новых native/model сообщений для приёмки.
  </action>
  <verify>Focused real-site acceptance, expected 90s/max180s на scenario; перед mutation UI взять native input/admission baseline, после readback подтвердить отсутствие новых native inputs от pin/tooltip действий. Сохранить screenshots и честные ограничения partial inventory.</verify>
  <done>PIN-01/02, META-01–04 подтверждены на настоящем desktop/mobile сайте; SUMMARY/STATE содержат результат, milestone checklist отмечен только по фактическим proofs.</done>
</task>
</tasks>

<success_criteria>
Все три tasks выполнены, личные pins переживают reload, каждый filtered native tuple отображается один раз, tooltip не выдаёт launch за current, frontend consumer принят без native inputs. Unit/build GREEN сами по себе не означают закрытие задачи.
</success_criteria>
