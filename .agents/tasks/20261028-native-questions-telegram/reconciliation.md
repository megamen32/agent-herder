# Восстановление существующей карточки Airlock

Проверено 29.10.2026: исходный producer из защищённого Herder env получал HTTP401 invalid bearer token от canonical writer http://127.0.0.1:8091. Подключённый Notice MCP выбирал проект hermes; его not-found не использовался как доказательство.

Существующий principal source:agent-herder найден в эффективной конфигурации работающего Notice writer. С ним GET /v1/human-requests/bfd790f2-c08d-4bd2-b2ee-c2dd96a792f1 вернул authenticated HTTP404 human request not found. Независимый query-only read канонического quorum-backed mesh:/run/noticeplace-mesh/sql.sock вернул exact request count0.

Источник Notice Place core.py:create_human_request сначала проверяет project token и сохраняет human_requests транзакционно; http_api.py POST/v1/human-requests вызывает send_human_request_telegram только после возврата durable create. DELETE human_requests в source отсутствует; отмена/expiry сохраняют запись. Поэтому для этого точного ID доказано отсутствие admission и отправки, а не просто неизвестный результат HTTP.

Существующий защищённый Herder producer синхронизирован с тем же live project principal, без нового scope, токена, файла секретов, рестарта или Notice mutation. Значения ключей не публиковались. Подтверждённый endpoint и project/recipient сохранены.

29.10.2026 03:19:02 МСК выполнена одна контролируемая доставка того же request_id/dedup_key и byte-equivalent envelope после повторного latest-question/fingerprint и canonical absence readback. Exact201/sent; canonical GET200 pending; provider message8483 в прежнем Telegram-чате, thread6030. UNKNOWN общего observer не снимался и не переоткрывался: receipt-only reconciliation текущего claim сохранил первоначальные claim/fingerprint/времена и записал accepted/reconciledAt. Независимый UserIO read подтвердил текст, исходную сессию Airlock и provider message8483. Ответ за владельца не подставлялся; native resume Airlock не выполнялся. При существующей записи повторный POST guard запрещает.

Evidence: airlock-delivery-receipt.json; operational one-shot guard airlock-repair-admission.json. Source receipt reconciliation6fa2a28 и регрессия HTTP401 metadata опубликованы. Данныеaccepted понимаются уже установленным43fcf5e, рестарт ради конфигурации/сверки не нужен.
