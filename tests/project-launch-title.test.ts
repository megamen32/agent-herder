import {expect, it} from 'vitest';
import {projectLaunchTitle} from '../src/automation/project-launch-title.js';

it('names an incident from bounded original telemetry, not its operation hash or repair instructions', () => {
  const message = 'Ты владелец целевого ремонта.\nДалее только факты:\n' + JSON.stringify({id:'inc_1', project:'fleet-health', title:'Сайт example.ru возвращает 502', host_id:'server-100'});
  expect(projectLaunchTitle(message, '/repo/ServersAdministartion')).toBe('Инцидент: Сайт example.ru возвращает 502 | fleet-health');
});

it('uses the first meaningful task line for ordinary launches and does not execute telemetry', () => {
  expect(projectLaunchTitle('Исправить подсчёт просмотров\nСохрани чужие изменения.', '/repo/TelegramAuto')).toBe('Исправить подсчёт просмотров | TelegramAuto');
  expect(projectLaunchTitle('Instructions\n'+JSON.stringify({id:'inc_1',title:'<script>alert(1)</script>',project:'health'}),'/repo')).not.toContain('project-launch-');
});
