# Экономное индексирование истории Herder

Поручение владельца 27.10: устранить повторное чтение/переиндексацию и лишние
записи SQLite/WAL, особенно для неизменившихся сессий; сохранить поиск.
Владелец исполнения: Codex 01a1754f-0228-7553-bea6-cc89e40b5187.

## До / после и план

До: user-provided measurement ~111 MiB/5s относится ко всему процессу и не
доказывает конкретный файл. Из source подтверждены обходы каждые60s, UPDATE
scan для неизменившихся сессий и autocommit INSERT каждого chunk/FTS.
После: неизменившаяся история не переписывается и не перечитывается без
необходимости; изменившаяся индексируется экономными ограниченными пачками.

1. Root: read-only замер process/thread I/O, точного release и SQLite/WAL.
2. Worker project_switch_backend: только session-search store/scanner/worker;
   минимальная починка доказанной write/read amplification. Без live mutation.
3. Root: обзор diff и совместимости, scoped publication в canonical main,
   полная сборка точного immutable release, установка своего Herder.
4. Root: после установки сравнить несколько периодов I/O и подтвердить поиск
   по существующей истории и актуальность changed-сессии безопасным read-only
   потребительским запросом. Записать точные результаты, не путать счётчики
   процесса с атрибуцией файлов.

## Границы

Canonical main, никаких worktree/веток/копий. Чужой untracked WIP сохранён.
Ранее принятые model-switching настройки и NoticePlace combo не менять.
Не менять GrepMesh, native DB, retention, живые сессии, providers или телефоны.
Не выключать поиск ради снижения записи. Не делать VACUUM/rebuild массово.
Тесты не добавлять и не запускать: действующее developer-ограничение разрешает
их только по запросу пользователя; здесь приёмка через измерение работающей
службы и поиск. Это ограничивает утверждения о регрессионном покрытии.

## Исходное состояние

AgentMemory recall выполнен в scope Herder; вернул старые нерелевантные записи,
поэтому причина проверяется исходником и live. GSD planning прочитан: старые
Mac задачи не расширяются, текущая доработка относится к поиску AUTO-кабинета.
Runtime source468542b7 PID2999650 start16:05:39 МСК. Открытая Herder SQLite
~6.0GB; WAL~30MB в одном чтении. Это размеры, не скорость записи.

Замер 75.214s: процесс450.87MiB write_bytes; search worker TID3000368
353476608bytes (~337MiB), main TID2999650 116527104bytes (~111MiB).
Прочитано через syscalls8544MiB (это rchar, не физическое чтение SSD).
Индекс содержал24487 sessions/~510k chunks. В начале scan complete, в конце
следующий running; корпус не создавался заново ради измерения.

Read-only strace worker6s: fd53=index WAL 37,212,096bytes/18,072pwrite64,
fd50=index DB 8,695,808bytes/2,123calls. Это атрибуция syscall bytes,
не физические write_bytes; трасса замедляет поток и замер отдельно от75s.
Main6s: events.json.tmp два полных snapshot,8,317,531bytes, два rename.
Причина main source — HerderEventBus.persist, полная history+revision map
при debounce1s. Отдельный worker model_switch_design владеет только
src/herder-events.ts: append/редкий checkpoint с legacy restore и bounded
replay. Не изменяет семантику уведомлений/receipts.

Эти два leaf выполняются параллельно; Root затем один раз интегрирует и
устанавливает общий срез. Ориентир критического пути~30мин; длительность
реального замера после установки отдельно от активной работы.

## Решение

- Неизменившиеся session rows не пишутся; факт присутствия хранится в RAM
  текущего полного обхода. Удаление только после complete и только missing IDs.
- Прогресс в SQLite не чаще1раз/секунду плюс точные start/final.
- Новые/изменённые chunks вставляются транзакциями до128 элементов; await
  только вне transaction. Ошибочный source оставляет last-good generation.
- JSONL metadata memo bounded50k путями: exact dev/inode/size/mtime/ctime и
  catalog id/title/cwd; ленивый content stream создаётся заново. Никаких новых
  revisions, массового FTS rebuild или миграции transcript-поколений.
- Для count-метаданных source добавлен один компактный covering partial index
  chunks_nonempty_session(harness,native_id) WHERE length(text)>0. Он один раз
  читает старые строки для построения; потом count не читает тексты всего
  архива дважды за цикл. Сам архив/chunks/FTS не переписывается.
- Events: legacy v1 snapshot читается; новые события append/fsync в защищённый
  sidecar events.json.journal. После8MiB snapshot checkpoint fsync+rename+dir
  fsync, затем truncate tail; covered sequences не replay. Debounce1s сохранён,
  не заменён минутной задержкой. Неперсистентные bus не копят pending buffer.

Важное для будущего rollback на старый binary: он не читает sidecar. Сначала
нужно checkpoint snapshot кодом нового release; не откатывать binary молча
поверх несвёрнутого журнала. Пока task не выполняет rollback или чужой restart.
