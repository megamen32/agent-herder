import * as React from 'react';
import {createPortal} from 'react-dom';
import {readSessionPinState, sessionPinStorage, toggleSessionPin, pinStorageKey, sidebarContext, type SidebarSession} from './session-pins.js';
import './session-sidebar.css';

/**
 * The machine labels the owner knows. A bare "100" says nothing about which
 * machine it is, so every machine is named in words.
 */
const machineLabels: Record<string, string> = {
  'roomhacker-server-100':'Сервер 100', 'server-100':'Сервер 100',
  'roomhacker-server-44':'Сервер 44', 'server-44':'Сервер 44',
  'roomhacker-server-88':'Сервер 88', 'server-88':'Сервер 88',
  'mac-m1':'Mac M1', 'roomhacker-mac-m1':'Mac M1',
  'mac-mini':'Mac Mini', 'roomhacker-mac-mini':'Mac Mini',
};

/** The machine a session runs on, named the way the owner names it. */
export function machineName(hostId?: string, hostLabel?: string): string {
  if (!hostId) return 'Машина не подтверждена';
  const known = machineLabels[hostId.toLowerCase()];
  if (known) return known;
  return hostLabel || hostId;
}

export function useSessionPins(scope: string) {
  const [state, setState] = React.useState<{scope:string; keys:string[]}>({scope:'', keys:[]});
  const [error, setError] = React.useState('');
  React.useEffect(() => {
    setError('');
    const load = () => {
      const read = readSessionPinState(scope ? sessionPinStorage(() => window.localStorage) : null, scope);
      setState({scope, keys:read.keys});
      if (read.failed) setError('Не удалось прочитать закрепления в этом браузере.');
    };
    load();
    const changed = (event: StorageEvent) => {if (event.key === pinStorageKey(scope) || event.key === null) load();};
    window.addEventListener('storage', changed);
    return () => window.removeEventListener('storage', changed);
  }, [scope]);
  return {pins: state.scope === scope ? state.keys : [], error, toggle: (key: string) => {
    const next = toggleSessionPin(sessionPinStorage(() => window.localStorage), scope, key);
    if (next === null) {setError('Не удалось сохранить закрепление в этом браузере.'); return;}
    setState({scope, keys:next}); setError('');
  }};
}

export function SessionSidebarRow({session, title, selected, pinned, canPin, statusClass, statusOverride, onSelect, onPin}: {
  session:SidebarSession; title:string; selected:boolean; pinned:boolean; canPin:boolean; statusClass:string; statusOverride?:string; onSelect:()=>void; onPin:()=>void;
}) {
  const root = React.useRef<HTMLDivElement>(null), tooltip = React.useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = React.useState<{left:number; top:number; right:number} | null>(null);
  const [position, setPosition] = React.useState({left:0, top:0});
  const id = React.useId();
  const context = sidebarContext(session, statusOverride);
  const machine = machineName(session.hostId, session.hostLabel);
  const subtitle = `${context.harness} · ${machine}`;
  const show = () => {
    if (!window.matchMedia('(hover: hover) and (min-width: 901px)').matches) return;
    const rect = root.current?.getBoundingClientRect();
    if (rect) {setPosition({left:rect.right + 8, top:rect.top}); setAnchor({left:rect.left, right:rect.right, top:rect.top});}
  };
  React.useLayoutEffect(() => {
    if (!anchor || !tooltip.current) return;
    const rect = tooltip.current.getBoundingClientRect();
    const left = anchor.right + 8 + rect.width <= window.innerWidth - 12 ? anchor.right + 8 : Math.max(12, anchor.left - rect.width - 8);
    setPosition({left, top:Math.max(12, Math.min(anchor.top, window.innerHeight - rect.height - 12))});
  }, [anchor, title, context.currentCwd, context.launchCwd]);
  React.useEffect(() => {
    if (!anchor) return;
    const hide = () => setAnchor(null);
    window.addEventListener('scroll', hide, true); window.addEventListener('resize', hide);
    return () => {window.removeEventListener('scroll', hide, true); window.removeEventListener('resize', hide);};
  }, [anchor]);
  return <div className={`session-row-actions${pinned ? ' is-pinned' : ''}`} ref={root}
    onMouseEnter={show} onMouseLeave={() => setAnchor(null)} onFocusCapture={show}
    onBlurCapture={event => {if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setAnchor(null);}}
    onKeyDown={event => {if (event.key === 'Escape') {setAnchor(null); event.stopPropagation();}}}>
    <button className={`session-row ${selected ? 'selected' : ''}`} aria-label={`${title}, ${subtitle}, ${context.status}`}
      aria-describedby={anchor ? id : undefined} onClick={onSelect}>
      <span className={`status-dot status-${statusClass}`} aria-hidden="true" />
      <span className="session-copy"><strong>{title}</strong><small className="session-identity">{subtitle}</small></span>
    </button>
    <button type="button" className="session-pin" aria-pressed={pinned} aria-label={`${pinned ? 'Открепить' : 'Закрепить'} сессию: ${title}`}
      disabled={!canPin} title={!canPin ? 'Данные машины и кабинета ещё загружаются' : pinned ? 'Открепить сессию' : 'Закрепить сессию'} onClick={onPin}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M8 3h8M9 3v5l-3 3v3h12v-3l-3-3V3M12 14v7" /></svg>
    </button>
    {anchor && createPortal(<div ref={tooltip} id={id} role="tooltip" className="session-context-tooltip" style={position}>
      <strong>{title}</strong><dl>
        <dt>Среда</dt><dd>{context.harness}</dd><dt>Машина</dt><dd>{machine}</dd>
        {context.currentCwd ? <><dt>Проект (CWD)</dt><dd>{context.currentCwd}</dd></> : <><dt>Текущий CWD</dt><dd>Не подтверждён</dd></>}
        {context.launchCwd && context.launchCwd !== context.currentCwd && <><dt>Каталог запуска</dt><dd>{context.launchCwd}</dd></>}
        <dt>Модель</dt><dd>{context.model}</dd><dt>Статус</dt><dd>{context.status}</dd><dt>Обновлено</dt><dd>{context.updated}</dd>
      </dl>
    </div>, document.body)}
  </div>;
}
