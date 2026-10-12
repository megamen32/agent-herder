const shots = {
  sessions: {src: 'assets/live-sessions.png', alt: "Agent Herder: Список рабочих сессий и история диалога с агентом.", caption: "Список рабочих сессий и история диалога с агентом. Снято в работающем Agent Herder 12.10.2026.", label: "Увеличить: Сессии и переписка"},
  controls: {src: 'assets/live-controls.png', alt: "Agent Herder: Модель, рабочая папка, автопродолжение и настройки отправки для выбранной сессии.", caption: "Модель, рабочая папка, автопродолжение и настройки отправки для выбранной сессии. Снято в работающем Agent Herder 12.10.2026.", label: "Увеличить: Управление сессией"},
  statistics: {src: 'assets/live-statistics.png', alt: "Agent Herder: Сводка по реальным сессиям: среды, модели и работа с файлами.", caption: "Сводка по реальным сессиям: среды, модели и работа с файлами. Снято в работающем Agent Herder 12.10.2026.", label: "Увеличить: Статистика"},
  activity: {src: 'assets/live-activity.png', alt: "Agent Herder: Сессии по дням, активные интервалы и возвращения к проектам.", caption: "Сессии по дням, активные интервалы и возвращения к проектам. Снято в работающем Agent Herder 12.10.2026.", label: "Увеличить: Графики активности"},
  tasks: {src: 'assets/live-tasks.png', alt: "Agent Herder: История длительных операций: результаты доставки, прогресс и сохранённый ввод.", caption: "История длительных операций: результаты доставки, прогресс и сохранённый ввод. Снято в работающем Agent Herder 12.10.2026.", label: "Увеличить: Фоновые задачи"}
};
const tabs = [...document.querySelectorAll('[data-shot]')];
const screenshot = document.getElementById('product-screenshot');
const panel = document.getElementById('screenshot-panel');
const expand = document.getElementById('expand-screenshot');
function selectShot(tab) {
  const shot = shots[tab.dataset.shot];
  for (const item of tabs) {item.setAttribute('aria-selected', String(item === tab)); item.tabIndex = item === tab ? 0 : -1;}
  screenshot.src = shot.src; screenshot.alt = shot.alt;
  document.getElementById('screenshot-caption').textContent = shot.caption;
  panel.setAttribute('aria-labelledby', tab.id);
  expand.setAttribute('aria-label', shot.label);
}
for (const tab of tabs) {
  tab.addEventListener('click', () => selectShot(tab));
  tab.addEventListener('keydown', event => {
    let next;
    const index = tabs.indexOf(tab);
    if (event.key === 'ArrowRight') next = tabs[(index + 1) % tabs.length];
    if (event.key === 'ArrowLeft') next = tabs[(index - 1 + tabs.length) % tabs.length];
    if (event.key === 'Home') next = tabs[0];
    if (event.key === 'End') next = tabs.at(-1);
    if (next) {event.preventDefault(); selectShot(next); next.focus();}
  });
}
const dialog = document.getElementById('image-dialog');
function openImage(source) {
  const image = document.getElementById('large-screenshot'); image.src = source.src; image.alt = source.alt;
  dialog.showModal();
}
expand.addEventListener('click', () => openImage(screenshot));
document.getElementById('expand-hero').addEventListener('click', () => openImage(document.querySelector('#expand-hero img')));
document.getElementById('close-image').addEventListener('click', () => dialog.close());
dialog.addEventListener('click', event => {if(event.target === dialog) {const box=dialog.getBoundingClientRect(); if(event.clientX<box.left||event.clientX>box.right||event.clientY<box.top||event.clientY>box.bottom) dialog.close();}});
document.getElementById('copy-install').addEventListener('click', async () => {
  const code = document.getElementById('install-code').textContent;
  const status = document.getElementById('copy-status');
  try {await navigator.clipboard.writeText(code); status.textContent = 'Команды скопированы.';}
  catch {status.textContent = 'Выделите и скопируйте команды вручную.'; const range=document.createRange(); range.selectNodeContents(document.getElementById('install-code')); const selection=getSelection(); selection.removeAllRanges(); selection.addRange(range);}
});
