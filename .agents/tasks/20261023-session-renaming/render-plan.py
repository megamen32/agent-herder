#!/usr/bin/env python3
"""Собирает plan.pdf и plan.png из одного plan.graph.json.

Один источник: граф плана. Артефакты PDF и PNG рендерятся из одного HTML,
поэтому картинка и документ не могут разойтись с отчётом.
"""
from __future__ import annotations

import json
import pathlib
import subprocess
import sys

HERE = pathlib.Path(__file__).resolve().parent
GRAPH = HERE / "plan.graph.json"
HTML = HERE / "plan.artifact.html"
PDF = HERE / "plan.pdf"
PNG = HERE / "plan.png"

STATUS = {
    "done": ("✅", "Готово", "done"),
    "running": ("🔄", "В работе", "running"),
    "blocked": ("⛔", "Блокер", "blocked"),
    "waiting": ("⌛", "Ждём ответа", "waiting"),
    "deferred": ("⏸", "Отложено", "deferred"),
    "queued": ("⏳", "В очереди", "queued"),
}

PURPOSE = {
    "L01": "Установленный codex-cli 0.162.1 отдаёт TS-схему протокола: найдены thread/name/set "
           "(ThreadSetNameParams = { threadId, name }) и thread/read. Это и есть нативный API "
           "переименования существующего диалога.",
    "L02": "Метод renameSession в адаптере Codex: native thread/name/set, затем нативный readback. "
           "Ни thread/start, ни turn/* — новый диалог не создаётся, модель не запускается, активный ход не прерывается.",
    "L03": "Три поля владельца (постоянный проект, текущая бизнес-цель, текущий этап плана) в существующих "
           "метаданных Herder; название собирается как «Проект | цель | этап» без обрезания содержательных полей.",
    "L04": "MCP-инструмент rename_session: точный host + harness + sessionId, локальный и удалённый хост, "
           "явный unsupported для харнессов без нативного API. Модельная квота не затрагивается.",
    "L05": "Живой canary против настоящего Codex app-server 0.162.1: кириллица принята, thread id тот же, "
           "ходов 0 (модель не запускалась), след в нативном индексе 0. Плюс readback через Herder в тестах.",
    "L06": "Зелёная ветка для интегратора: коммит с тестами и описанием, база mavis/herder-harness-20261023 "
           "(включает e729320). Публикацию, сборку релиза, drop-in и рестарт ведёт интегратор: живой контур общий с флотом.",
    "L07": "Применение к шести сессиям владельца только через опубликованный инструмент; цели и ход сессий не меняются. "
           "Блокер: ждёт интеграции ветки в следующий кандидат.",
}


def escape(text: str) -> str:
    return (text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))


def leaf_card(task: dict) -> str:
    icon, label, css = STATUS.get(task.get("status", "queued"), STATUS["queued"])
    estimate = task.get("estimate_minutes", {})
    est = f"{int(estimate.get('minimum', 0))}–{int(estimate.get('maximum', 0))} мин"
    actual = task.get("actual_minutes")
    actual_text = f"факт {int(actual)} мин" if actual else "факт не измерено"
    times = []
    if task.get("started_at"):
        times.append(f"начата {task['started_at']}")
    if task.get("finished_at"):
        times.append(f"закончена {task['finished_at']}")
    depends = task.get("depends_on") or []
    depends_text = f"· ждёт: {', '.join(depends)}" if depends else "· без зависимостей"
    paths = task.get("write_paths") or []
    paths_html = ""
    if paths:
        paths_html = "<div class='paths'>файлы: " + ", ".join(f"<code>{escape(p)}</code>" for p in paths) + "</div>"
    purpose = PURPOSE.get(task.get("id", ""), "")
    return f"""
    <section class="leaf {css}">
      <div class="leaf-head">
        <span class="badge">{icon} {escape(task.get('id', ''))}</span>
        <span class="state">{label}</span>
      </div>
      <h3>{escape(task.get('label', ''))}</h3>
      <div class="meta">{escape(' · '.join(times))} · оценка {est} · {actual_text} · {escape(depends_text)}</div>
      <p>{escape(purpose)}</p>
      {paths_html}
    </section>"""


def build_html(graph: dict) -> str:
    tasks = graph.get("tasks", [])
    done = [t for t in tasks if t.get("status") == "done"]
    running = [t for t in tasks if t.get("status") == "running"]
    queued = [t for t in tasks if t.get("status") in ("queued", "blocked", "waiting", "deferred")]
    waves = 7
    cards = "".join(leaf_card(t) for t in tasks)
    progress = graph.get("current_progress") or "—"
    return f"""<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><title>План: переименование сессий Agent Herder</title>
<style>
  @page {{ size: A4; margin: 12mm; }}
  * {{ box-sizing: border-box; }}
  body {{ font-family: "DejaVu Sans", "Segoe UI", sans-serif; color: #16202c; margin: 0; padding: 26px 30px;
         background: #f6f8fb; font-size: 13px; line-height: 1.45; }}
  .sheet {{ background: #fff; border-radius: 14px; padding: 26px 30px; box-shadow: 0 2px 14px rgba(20,40,80,.10); }}
  h1 {{ font-size: 21px; margin: 0 0 4px; }}
  .sub {{ color: #5a6b80; font-size: 12px; margin-bottom: 16px; }}
  .headline {{ display: grid; gap: 7px; margin-bottom: 16px; }}
  .row {{ display: grid; grid-template-columns: 150px 1fr; gap: 10px; background: #eef3fa; border-radius: 9px; padding: 8px 12px; }}
  .row b {{ color: #23406b; }}
  .cols {{ display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-bottom: 16px; }}
  .stat {{ background: #f0f6f2; border-left: 4px solid #2f855a; border-radius: 8px; padding: 8px 12px; }}
  .stat .n {{ font-size: 19px; font-weight: 700; }}
  .stat .t {{ font-size: 11px; color: #4b5c70; }}
  h2 {{ font-size: 14px; margin: 16px 0 8px; text-transform: uppercase; letter-spacing: .04em; color: #23406b; }}
  .leaf {{ border: 1px solid #dbe3ee; border-left-width: 5px; border-radius: 9px; padding: 9px 13px; margin-bottom: 8px; background: #fbfcfe; }}
  .leaf.done {{ border-left-color: #2f855a; }}
  .leaf.running {{ border-left-color: #2b6cb0; background: #f2f7fd; }}
  .leaf.queued {{ border-left-color: #a0aec0; }}
  .leaf.blocked {{ border-left-color: #c53030; }}
  .leaf-head {{ display: flex; gap: 8px; align-items: center; }}
  .badge {{ font-weight: 700; }}
  .state {{ font-size: 10px; text-transform: uppercase; letter-spacing: .06em; color: #4b5c70; border: 1px solid #cbd6e4;
            border-radius: 999px; padding: 1px 8px; }}
  .leaf h3 {{ font-size: 13.5px; margin: 4px 0 2px; }}
  .meta {{ font-size: 11px; color: #5a6b80; }}
  .leaf p {{ margin: 4px 0 0; font-size: 12px; color: #33414f; }}
  .paths {{ margin-top: 4px; font-size: 11px; color: #5a6b80; }}
  code {{ background: #edf1f7; border-radius: 4px; padding: 0 4px; }}
  .bounds {{ background: #fff8f0; border: 1px solid #f0d3a8; border-radius: 9px; padding: 10px 13px; font-size: 12px; }}
  .bounds ul {{ margin: 6px 0 0; padding-left: 18px; }}
  footer {{ margin-top: 14px; font-size: 10.5px; color: #6b7a8d; border-top: 1px solid #e2e8f0; padding-top: 8px; }}
</style></head>
<body><div class="sheet">
  <h1>Настоящее переименование существующих сессий в Agent Herder</h1>
  <div class="sub">Codex · нативный thread/name/set · MCP-операция rename_session · задача 20261023-session-renaming</div>
  <div class="headline">
    <div class="row"><b>Цель</b><span>Переименовать уже существующие Codex-сессии по host+harness+sessionId:
      меняется native title того же диалога — новый диалог не создаётся, модель не запускается, активный ход не прерывается.</span></div>
    <div class="row"><b>Бизнес-результат</b><span>Владелец видит у своих сессий читаемые названия
      «Проект | цель | этап» вместо технических заголовков; название меняется нативно и подтверждается readback'ом.</span></div>
    <div class="row"><b>Декомпозиция</b><span>{len(tasks)} листьев · 1 параллельно · {waves} волн · слотов: 1</span></div>
  </div>
  <div class="cols">
    <div class="stat"><div class="n">{len(done)}</div><div class="t">готово</div></div>
    <div class="stat"><div class="n">{len(running)}</div><div class="t">в работе</div></div>
    <div class="stat"><div class="n">{len(queued)}</div><div class="t">в очереди</div></div>
  </div>
  <h2>Этапы</h2>
  {cards}
  <h2>Границы, которые держим</h2>
  <div class="bounds"><ul>
    <li>«Бизнес-цель» — описательные метаданные. <code>thread/goal/set</code> не вызывается, native execution goal чужих сессий не меняется.</li>
    <li>Кодекс-сессии владельца не будим и не запускаем ради проверки названий; проверка — на собственной нативной сессии и на unit-уровне протокола.</li>
    <li>Никаких периодических LLM-запусков, daemon'ов и cron'ов ради заголовков: только ручное переименование или однократное обновление при смене задачи.</li>
    <li>Живой контур общий с флотом: публикацию релиза и переключение current ведёт интегратор, исполнитель отдаёт готовый зелёный SHA.</li>
    <li>Кандидат строится поверх e729320, чтобы работа владельца не разошлась с общим релизом.</li>
    <li>Защита запуска и продолжения моделей не меняется; переименование не потребляет модельную квоту.</li>
  </ul></div>
  <footer>Текущий прогресс: {escape(progress)} · источник: plan.graph.json · сгенерировано render-plan.py</footer>
</div></body></html>"""


def render() -> int:
    graph = json.loads(GRAPH.read_text(encoding="utf-8"))
    HTML.write_text(build_html(graph), encoding="utf-8")
    common = ["--headless", "--no-sandbox", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1.6"]
    subprocess.run(
        ["google-chrome", *common, f"--print-to-pdf={PDF}", "--no-pdf-header-footer", f"file://{HTML}"],
        check=True, capture_output=True, timeout=180,
    )
    subprocess.run(
        ["google-chrome", *common, "--window-size=1240,2100", f"--screenshot={PNG}", f"file://{HTML}"],
        check=True, capture_output=True, timeout=180,
    )
    subprocess.run(["convert", str(PNG), "-trim", "+repage", str(PNG)], check=False)
    for path in (PDF, PNG):
        print(f"{path} {path.stat().st_size} bytes")
    return 0


if __name__ == "__main__":
    sys.exit(render())
