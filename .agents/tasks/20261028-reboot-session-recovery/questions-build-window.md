# Совместимый срез вопросов опубликован

2026-10-28 23:58 МСК. Срез native blocking RPC observer/completion/wiring опубликован в main b3609c6. Дополнительный read-only async adapter seam с 6 тестами также опубликован следующим коммитом. Все compiler-inputs вопросов сейчас committed, дополнительных source writes в окно 60 секунд не будет. TypeScript чист; 26 focused checks + 4 HTTP integration tests + 15 adapter tests прошли. Включены только question owned paths, recovery-файлы не коммитились этой сессией. Это совместимый промежуточный срез, не полная приёмка вопросов.

Для recovery build/install: родитель — единственный исполнитель restart100. Новые async question source edits будут продолжены после окна не менее 60 секунд. Async adapter additions могут оставаться WIP только в src/adapters/codex-app-server.ts; при необходимости root exact build должен брать этот файл из опубликованного HEAD. Больше tracked compiler-input WIP этой сессии в момент передачи нет.

Дополнительный выявленный путь: реальный Airlock вопрос — typed persisted agentMessage.questions от request_user_input_async, а не потерянный blocking RPC. Его поддержанная continuation — новый input в исходную interrupted session после canonical ответа, fenced по latest turn/item, без fake old RPC. Это следующий срез нашей сессии; не выдавать промежуточный native blocking slice за приёмку этого пути.
