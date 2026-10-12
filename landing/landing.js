const shots = {
  statistics: {src: 'assets/statistics.png', alt: 'Agent Herder: статистика активности, распределение сессий по средам и моделям', caption: 'Статистика по рабочим сессиям. Скриншот из открытого репозитория проекта.', label: 'Увеличить скриншот статистики'},
  sessions: {src: 'assets/sessions.png', alt: 'Agent Herder: список сессий, выбранный агент и панель управления', caption: 'Список сессий и панель управления агентом. Скриншот из открытого репозитория проекта.', label: 'Увеличить скриншот сессий'}
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
expand.addEventListener('click', () => {
  const image = document.getElementById('large-screenshot'); image.src = screenshot.src; image.alt = screenshot.alt;
  dialog.showModal();
});
document.getElementById('close-image').addEventListener('click', () => dialog.close());
dialog.addEventListener('click', event => {if(event.target === dialog) {const box=dialog.getBoundingClientRect(); if(event.clientX<box.left||event.clientX>box.right||event.clientY<box.top||event.clientY>box.bottom) dialog.close();}});
document.getElementById('copy-install').addEventListener('click', async () => {
  const code = document.getElementById('install-code').textContent;
  const status = document.getElementById('copy-status');
  try {await navigator.clipboard.writeText(code); status.textContent = 'Команды скопированы.';}
  catch {status.textContent = 'Выделите и скопируйте команды вручную.'; const range=document.createRange(); range.selectNodeContents(document.getElementById('install-code')); const selection=getSelection(); selection.removeAllRanges(); selection.addRange(range);}
});
