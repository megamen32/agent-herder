---
created: 2026-10-13
title: Synchronize Herder pins with native harness pins
area: ui
files:
  - src/web-ui/session-pins.ts
---

## Problem

Пользователь хочет, чтобы закрепления Herder совпадали с закреплениями в нативных Codex/ZCode и других поддерживающих их средах. Это следующий шаг после текущего UI майлстоуна.

## Solution

Сначала проверить официальные существующие pin/read/write capabilities каждого harness; затем двусторонняя синхронизация точного host+harness+native SID, с сохранением независимых аккаунтов и понятным разрешением конфликтов. Не редактировать private native базы или installed core, не запускать сессию ради pin. Текущая задача остаётся браузерными закреплениями; native sync не реализуется сейчас.
