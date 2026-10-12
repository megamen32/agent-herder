import type {AgentStatus} from '../../types/common.js';

const labels = {
 running: 'Выполняет задачу',
 idle: 'Ожидает задачи',
 needs_input: 'Ждёт ответа',
 stopped: 'Остановлена',
 error: 'Ошибка сессии',
} satisfies Record<AgentStatus,string>;

export function fleetSessionStatus(status:string):string {
 return Object.hasOwn(labels,status) ? labels[status as AgentStatus] : 'Статус не подтверждён';
}
