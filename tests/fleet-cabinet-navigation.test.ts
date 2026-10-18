import {describe,it,expect,vi} from 'vitest';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {fleetSessionStatus} from '../src/web-ui/fleet/session-labels.js';
import {FleetCabinet} from '../src/web-ui/fleet/FleetCabinet.js';

describe('Fleet cabinet navigation (fast unit; expected 1s/max 10s; no native sessions)',()=>{
 it('offers both section jumps in the browsing header before the machine cards',()=>{
  const client={hosts:vi.fn(),sessions:vi.fn(),create:vi.fn()} as any;
  const html=renderToStaticMarkup(createElement(FleetCabinet,{client,defaultHostId:'roomhacker-server-100'}));
  const header=html.slice(html.indexOf('<header>'),html.indexOf('</header>'));
  expect(header).toContain('aria-label="Переходы по кабинету"');
  expect(header).toMatch(/type="button"[^>]*>К сессиям<\/button>/);
  expect(header).toMatch(/type="button"[^>]*>Новая сессия<\/button>/);
  expect(html).toContain('aria-label="Список сессий"');
  expect(html).toContain('aria-label="Новая сессия"');
  expect(client.create).not.toHaveBeenCalled();
 });
 it('shows the fleet catalog while the scoped machine check is still pending and keeps creation disabled',()=>{
  const client={hosts:()=>new Promise(()=>{}),sessions:vi.fn(),create:vi.fn()} as any;
  const html=renderToStaticMarkup(createElement(FleetCabinet,{client,defaultHostId:'roomhacker-server-100'}));
  for(const host of ['roomhacker-server-100','server-44','roomhacker-server-88','mac-mini-2012.lan','MacBook-Pro-User.local'])expect(html).toContain(`value="${host}"`);
  expect(html).toContain('Получаю список машин…');
  expect(html).toMatch(/<button disabled[^>]*>Создать на выбранной машине<\/button>/);
 });
 it('translates every native session state and keeps unknown diagnostics out of the label',()=>{
  for(const [state,label] of Object.entries({running:'Выполняет задачу',idle:'Ожидает задачи',needs_input:'Ждёт ответа',stopped:'Остановлена',error:'Ошибка сессии'})){
   expect(fleetSessionStatus(state)).toBe(label);
  }
  for(const unknown of ['private_diagnostic_payload','__proto__',''])expect(fleetSessionStatus(unknown)).toBe('Статус не подтверждён');
 });
 it('retains compact creation mode without browsing navigation',()=>{
  const html=renderToStaticMarkup(createElement(FleetCabinet,{creationMode:true,defaultHostId:'roomhacker-server-100'}));
  expect(html).toContain('fleet-cabinet-creating');
  expect(html).not.toContain('Переходы по кабинету');
  expect(html).toContain('Сервер 100 · Нужна проверка');
  expect(html).toMatch(/<button disabled[^>]*>Создать на выбранной машине<\/button>/);
 });
});
