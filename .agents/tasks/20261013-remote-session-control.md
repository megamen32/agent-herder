# Управление удалённой сессией из центрального чата

Статус: выполнено и проверено на сайте 13.10.2026. Исполнитель: Root 01a12740.

Из общего списка Herder открывается обычная переписка удалённой нативной сессии. Отправка, остановка и продолжение выполняются на выбранной машине через существующие owner HTTP API, без перехода на другой сайт, создания заменяющей сессии или повторной отправки при неизвестном исходе. Полный адрес включает host+harness+nativeSID; исходный профиль, cookie/TLS, проверка пользователя/сессии, журнал создания и разделение outbox сохранены. Ссылка на отдельный кабинет остаётся дополнительной.

Реальная канарейка на server-44: одна Codex-сессия 01a1368c-72ab-7752-94ea-fff8c9357bb8; центральный origin agent.bezrabotnyi.com; три POST message/stop/resume получили 202/200/200. Native turn interrupted после остановки, новый ход в прежнем SID completed после продолжения. Driver once/wait/finish вызваны каждый ровно один раз, итог REMOTE_CONTROL_DONE. После проверки архивирована только эта собственная завершённая сессия; история и эффекты сохранены. Канарейка всех остальных сред/машин здесь не заявляется.

Дополнительные выявленные дефекты исправлены: публичный POST100 ошибочно выбирал Hub без capability управления (4 meaningful RED→GREEN); служебные инструкции удалённого чата раскрывались как обычный текст; мобильный общий CSS скрывал Продолжить/Обновить. Аутентифицированные desktop и390px site read приняли исправления: обычная переписка, инструкции в закрытых disclosure, нет overflow, все три мобильные кнопки44px и доступны.

Проверки: 60 initial + strict build/Vite39.214s; public routing72 checks + build39.652s; renderer89 checks + build35.982s; CSS bounded Vite. Все завершившиеся source runs внутри собственных sealed budgets, swap/OOM0. Новое правило expected/emergency10x применяется к будущим cases; прежние бюджеты не переписывались.

Установка: canonical dist и публичный статический release265f882e4692c8fcdaeedd294494bccb253bd335. Живой fleetApiHandler подключён через существующие WebDependencies, остальные handlers/guard сохранены. Herder1072026 и SDK1072381 не перезапускались; девять исходных accepted ZCode queue rows точно сохранены. Старые артефакты/релизы и чужие untracked OpenCode releaseJS сохранены.

Ошибки сохранены отдельно: неподходящий wall, старый Node, первоначальный storage typecheck, private/relative case setup refusals, initial public POSTunknown (cf94f9b2) не replay. Браузерный scope второй попытки уничтожен systemd-oomd18:49Z; его missing native finish/metrics не выданы за GREEN. Три успешные site commands ДОkill независимо подтверждены R38; mailbox не являлся полным CDP census. Последующие readonly actors ограничены полезным телом150s, завершены и очищены; foreign browsers/processes0.

Evidence: .tmp/remote-session-control-20261013/public-site-acceptance.json, public-site-final-desktop.png, public-site-mobile-fixed-loaded.png; original failures and native receipts adjacent. Browser onlyserver44, native fixture inputs never repeated.
