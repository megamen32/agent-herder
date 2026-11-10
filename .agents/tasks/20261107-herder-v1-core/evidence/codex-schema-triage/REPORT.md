# Codex create: read-only schema triage

Attempt: astra-v1-codex-schema-20261107T2055. Executor Archimedes; Lead Astra.

**Вывод: несовпадение JSON schema не обнаружено. serviceTier="default" не доказан как причина UNKNOWN.**

## Проверенный источник

Native binary из canonical CI/codex-v1-result.md: `/home/roomhacker/.npm-global/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex`.
Версия: `codex-cli 0.167.0`. SHA256: `cdcb45aaa01d0f14e298985e09465aebccd47f64ecd298aea44814af7b62bbda`.
Исходный retained JSON не содержит hash native CLI: подтверждены текущие bytes по указанному пути, идентичность этих bytes во время старой попытки отдельно не доказана.

Выполнены только --version, app-server --help, app-server generate-json-schema --help, app-server generate-json-schema --out DIR (обычная и --experimental). Все команды имели отдельные HOME/CODEX_HOME/XDG_CONFIG_HOME/TMPDIR, cwd внутри этого .tmp и минимальный environment без credentials. App-server не стартовал, socket не подключался, thread/start и model sends не выполнялись; UNKNOWN create не повторялся.

## Поля

Current source src/adapters/codex-app-server.ts:1135-1142 и сохранённый candidate ahap-codex-runner.mjs одинаково формируют thread/start: cwd; optional model; serviceTier fast либо default; fullAccess добавляет approvalPolicy=never и sandbox=danger-full-access. Candidate runner принудительно fullAccess=false, core передаёт только name/cwd, projectRuntimePolicy не задаётся. Реконструированный params для указанной fixture: `{"cwd":"/herder-owner-home/work","serviceTier":"default"}`. Это реконструкция source path, не сохранённый wire request.

ThreadStartParams.json в обеих схемах: cwd/model/serviceTier имеют type [string,null]; serviceTier не enum. Общих required fields нет. approvalPolicy допускает never; sandbox допускает danger-full-access. JSON schema, следовательно, не отвергает эти поля/значения.

Offline Ajv: 20 проверок по ThreadStartParams и полной ClientRequest в обычной/experimental схемах. Candidate/default, fast и optional model/fullAccess shapes проходят (12 positive); неверный serviceTier type=42 и неверный approval enum отвергаются (8 negative). Ajv игнорировал custom integer formats в других полях схемы; это не меняет проверенные string types и enums; request id использован integer 1. Подробности validation.json.

## Предел вывода и следующий шаг

Schema-valid не означает runtime-admitted: семантические проверки config/provider/quota и transport остаются непроверенными. В source request() есть quota guard до отправки thread/start; отсутствие native rows само по себе не доказывает, что thread/start достиг native handler. Read-only evidence не содержит исходного native JSON-RPC error/code/stage, достаточного для точного root cause.

По результату этого разбора **нет обоснованной правки serviceTier или другого request field**. Минимальный дальнейший диагностический шаг владельцу existing adapter: найти сохранённый error stage/code для первоначального create (quota preflight против thread/start response), не отправляя create снова. Если error не сохранён, отдельно добавить redacted stage/code diagnostics в существующем adapter/runner; это рекомендация наблюдаемости, не доказанный functional fix. src/adapters/** и остальные исходники не изменялись.
