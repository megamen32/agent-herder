import type {FleetHost} from '../../mesh/fleet-contract.js';

export const machineName = (host: Pick<FleetHost,'hostId'|'label'>): string => ({
 'roomhacker-server-100':'Сервер 100',
 'server-44':'Сервер 44',
 'roomhacker-server-88':'Сервер 88',
 'MacBook-Pro-User.local':'MacBook Pro · M1',
 'mac-mini-2012.lan':'Mac mini · 2012',
} as Record<string,string>)[host.hostId] ?? host.label;

export const machineStatus = (host: FleetHost): string => ({ready:'Доступна',metadata_only:'Только просмотр',offline:'Нет связи',unavailable:'Не отвечает',stale:'Нужна проверка'} as const)[host.state];

export const machineReason = (host: FleetHost): string => {
 if(host.state==='ready')return 'Связь с агентом на этой машине подтверждена.';
 const reasons:Record<string,string>={
  local_herder_not_registered:'Агент на этой машине ещё не подключён к кабинету.',
  local_control_not_registered:'История доступна, но управление сессиями не подключено.',
  local_herder_offline:'Служба агента не отвечает. Нажмите «Проверить связь» после восстановления.',
  direct_peer_unavailable:'Не удалось связаться со службой агента. Сама машина может продолжать работать.',
  direct_deadline:'Проверка связи заняла слишком много времени. Попробуйте ещё раз.',
  direct_ssh_connect_timeout:'SSH-соединение не ответило вовремя. Попробуйте проверить связь снова.',
  direct_ssh_refused:'Обратное SSH-соединение сейчас недоступно. Нужна повторная проверка.',
  direct_ssh_host_key_unverified:'Не удалось подтвердить доверенное SSH-соединение.',
  direct_native_listener_unavailable:'SSH работает, но служба агента на машине не отвечает.',
  native_owner_identity_mismatch:'Подключение не подтвердило выбранную машину и её пользователя.',
  metadata_expired:'Истекло подтверждение связи и возможности команд, а не подтверждение исправности машины. Состояние обновится автоматически, пока открыт кабинет; можно также нажать «Проверить связь».',
  registry_read_failed:'Список подключений сейчас недоступен. Попробуйте обновить его.',
  host_offline:'Нет свежего подтверждения связи с этой машиной.',
  host_unavailable:'Подключение к этой машине сейчас не подтверждено.',
 };
 return reasons[host.reason??'']??'Доступность агента пока не подтверждена. Нажмите «Проверить связь».';
};
