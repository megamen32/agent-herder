/** Keep native sessions in their existing executor. Peers attach to that
 * executor; closing a UI/RPC connection disposes subscriptions, never turns.
 * Dependencies are supplied by the native host; no additional daemon/process. */
export function shareZcodeSessionService({service, role, socketPath, peerPath, net, fs, createScope, randomUUID, activate = true}) {
  if (!['herder', 'desktop'].includes(role)) throw Error('Unknown native session owner');
  const raw = Object.fromEntries(Object.keys(service).map(key => [key,
    typeof service[key] === 'function' ? service[key].bind(service) : service[key]]));
  const maxBytes = 32 * 1024 * 1024, maxPending = 128;
  const owners = new Map(), subscriptions = new Set(), peers = new Set();
  const active = value => Boolean(value?.runtime?.activeTurnId);
  const missing = error => ['ZCODE_AGENT_RUNTIME_UNAVAILABLE', 'proto.sessionNotFound'].includes(error?.code)
    || /\bSession (?:is not active|not found):|^ZCode Agent runtime is not running\.$/.test(error?.message || '');
  const target = params => ({workspacePath: params.workspacePath,
    ...(params.workspaceIdentity ? {workspaceIdentity: params.workspaceIdentity} : {}),
    ...(params.workspaceKey ? {workspaceKey: params.workspaceKey} : {}), sessionId: params.sessionId || params.envelope?.sessionId});
  const keyFor = params => JSON.stringify([params.workspaceIdentity || params.workspacePath, params.sessionId || params.envelope?.sessionId]);
  const errorValue = error => ({message: error?.message || String(error), code: error?.code, data: error?.data});
  const decodeError = data => Object.assign(Error(data?.message || 'Native peer failed'), data);
  const write = (socket, message) => {
    const line = JSON.stringify(message, (_key, value) => value instanceof Uint8Array
      ? {__herderNativeBytes:Buffer.from(value).toString('base64')}
      : value?.type === 'Buffer' && Array.isArray(value.data)
        ? {__herderNativeBytes:Buffer.from(value.data).toString('base64')} : value) + '\n';
    if (Buffer.byteLength(line) > maxBytes || socket.writableLength + Buffer.byteLength(line) > maxBytes) {
      socket.destroy(Error('Native session bridge capacity exceeded')); return false;
    }
    socket.write(line); return true;
  };
  const read = (socket, receive) => {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', chunk => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > maxBytes) { socket.destroy(Error('Native session bridge frame too large')); return; }
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        try { receive(JSON.parse(line, (_key, value) => value && typeof value === 'object'
          && Object.keys(value).length === 1 && typeof value.__herderNativeBytes === 'string'
          ? Buffer.from(value.__herderNativeBytes, 'base64') : value)); } catch (error) { socket.destroy(error); return; }
      }
    });
  };
  const observe = async params => {
    try { return {present: true, snapshot: await raw.readSession({...target(params), runtimePolicy: 'existing-only', messageLimit: 1})}; }
    catch (error) { if (missing(error)) return {present: false}; throw error; }
  };

  // The endpoint exposes the original service only. Routed services must never
  // call each other recursively or infer ownership from historical DB rows.
  const server = net.createServer(socket => {
    if (peers.size >= 8) { socket.destroy(); return; }
    peers.add(socket);
    const scope = createScope(raw, {connectionId: `herder-shared-${randomUUID()}`,
      clientMode: 'desktop-continuous', role: 'trusted-host-relay'});
    const bound = scope.service, listening = new Map();
    let inFlight = 0;
    read(socket, message => {
      if (message.type === 'unlisten') { listening.get(message.id)?.dispose(); listening.delete(message.id); return; }
      if (inFlight >= maxPending || listening.size >= maxPending) { socket.destroy(Error('Native session bridge request limit')); return; }
      if (message.type === 'listen') {
        try {
          if (!/^on[A-Z]/.test(message.method) || typeof bound[message.method] !== 'function') throw Error('Unknown native event');
          const event = message.method.startsWith('onDynamic') ? bound[message.method](message.arg) : bound[message.method];
          listening.set(message.id, event(value => write(socket, {type:'event', id:message.id, value})));
          write(socket, {id:message.id, ok:true});
        } catch (error) { write(socket, {id:message.id, error:errorValue(error)}); }
        return;
      }
      if (message.type !== 'call') { socket.destroy(Error('Unknown native session bridge message')); return; }
      inFlight++;
      void (async () => {
        try {
          let value;
          if (message.method === '__observe') value = await observe(message.args?.[0] || {});
          else {
            if (/^(?:dispose|on[A-Z]|__)/.test(message.method) || typeof bound[message.method] !== 'function') throw Error('Native lifecycle belongs to its host');
            value = await bound[message.method](...(message.args || []));
          }
          if (!socket.destroyed) write(socket, {id:message.id, value});
        } catch (error) { if (!socket.destroyed) write(socket, {id:message.id, error:errorValue(error)}); }
        finally { inFlight--; }
      })();
    });
    socket.on('error', () => {});
    socket.once('close', () => {
      peers.delete(socket);
      for (const disposable of listening.values()) disposable.dispose();
      listening.clear();
      // Native scope disposal releases only this connection's subscriptions.
      void scope.dispose().catch(() => {});
    });
  });
  // Never unlink a live/foreign endpoint. Deployment reconciles stale endpoints
  // explicitly after checking the owning process generation.
  server.on('error', error => { endpointError = error; });
  let endpointError;
  server.listen(socketPath, () => fs.chmodSync(socketPath, 0o600));
  server.unref();

  let socket, connecting, nextId = 1;
  const pending = new Map(), events = new Map();
  const connect = async () => {
    if (socket && !socket.destroyed) return socket;
    if (connecting) return connecting;
    connecting = new Promise((resolve, reject) => {
      const current = net.createConnection(peerPath), timer = setTimeout(() => current.destroy(Error('Native owner unavailable')), 3000);
      current.once('connect', () => {clearTimeout(timer); socket = current; resolve(current);});
      read(current, message => {
        if (message.type === 'event') { events.get(message.id)?.listener(message.value); return; }
        const request = pending.get(message.id); if (!request) return;
        pending.delete(message.id); clearTimeout(request.timer);
        if (message.error) request.reject(decodeError(message.error)); else request.resolve(message.value);
      });
      current.on('error', error => {clearTimeout(timer); reject(error);});
      current.once('close', () => {
        clearTimeout(timer); if (socket === current) socket = undefined;
        for (const [id, request] of pending) if (request.connection === current) {
          clearTimeout(request.timer); request.reject(Error('Native owner connection lost; do not replay input')); pending.delete(id);
        }
        for (const [id, event] of events) if (event.connection === current) events.delete(id);
      });
    }).finally(() => {connecting = undefined;});
    return connecting;
  };
  const request = async message => {
    const connection = await connect();
    if (pending.size >= maxPending) throw Error('Native session bridge request limit');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {pending.delete(message.id); reject(Error('Native owner response unknown; do not replay input'));}, 30000);
      pending.set(message.id, {resolve, reject, timer, connection});
      if (message.type === 'listen' && events.has(message.id)) events.get(message.id).connection = connection;
      if (!write(connection, message)) {clearTimeout(timer); pending.delete(message.id); reject(Error('Native owner admission unknown; do not replay input'));}
    });
  };
  const remoteCall = (method, args) => request({type:'call', id:nextId++, method, args});
  const remoteListen = (method, arg, listener) => {
    const id = nextId++; let disposed = false;
    if (events.size >= maxPending) throw Error('Native session bridge subscription limit');
    events.set(id, {listener});
    const ready = request({type:'listen', id, method, arg}).then(() => {
      if (disposed && socket && !socket.destroyed) write(socket, {type:'unlisten',id});
    }).catch(error => {events.delete(id); throw error;});
    return {ready, dispose() {disposed = true; events.delete(id); if (socket && !socket.destroyed) write(socket, {type:'unlisten', id});}};
  };
  const choose = async params => {
    const key = keyFor(params);
    if (owners.has(key)) return owners.get(key);
    const deciding = (async () => {
      const local = await observe(params);
      // The original Herder runtime remains authoritative for its loaded IDs.
      // All new Desktop sessions go there; pre-existing Desktop-only tasks stay
      // in Desktop until naturally finished, with both consumers routed to it.
      if (role === 'herder' && local.present) return 'local';
      let other;
      try {other = await remoteCall('__observe', [target(params)]);}
      catch (error) {if (local.present) return 'local'; throw error;}
      if (other.present) return 'remote';
      if (local.present) return 'local';
      return role === 'herder' ? 'local' : 'remote';
    })();
    if (owners.size >= 2048) throw Error('Native session ownership capacity exceeded');
    owners.set(key, deciding);
    try {return await deciding;} catch (error) {owners.delete(key); throw error;}
  };
  const disposeSubscriptions = new Set();
  const listen = (method, params, listener) => {
    let disposed = false, parts = [];
    const ready = (async () => {
      const sid = params?.sessionId || params?.envelope?.sessionId;
      const owner = sid ? await choose(params) : null;
      if (disposed) return;
      if (owner !== 'remote') parts.push(method.startsWith('onDynamic') ? raw[method](params)(listener) : raw[method](listener));
      if (owner !== 'local') {
        const remote = remoteListen(method, params, listener); parts.push(remote);
        await remote.ready;
      }
    })();
    subscriptions.add(ready); void ready.catch(() => {}).finally(() => subscriptions.delete(ready));
    const result = {dispose() {disposed = true; for (const part of parts) part.dispose(); parts = []; disposeSubscriptions.delete(result);}};
    disposeSubscriptions.add(result); return result;
  };
  let enabled = false;
  const enable = () => {
  if (enabled) return;
  enabled = true;
  for (const method of Object.keys(raw)) {
    if (typeof raw[method] !== 'function') continue;
    if (method.startsWith('onDynamic')) service[method] = params => listener => listen(method, params, listener);
    else if (/^on[A-Z]/.test(method)) service[method] = listener => listen(method, undefined, listener);
    else if (method === 'disposeWorkspace') service[method] = async () => {}; // consumers do not own executors
    else if (/^disposeAll/.test(method)) service[method] = (...args) => {
      for (const item of disposeSubscriptions) item.dispose();
      socket?.destroy(); server.close(); for (const peer of peers) peer.destroy();
      return raw[method](...args);
    };
    else if (raw[method].constructor.name === 'AsyncFunction') service[method] = async (...args) => {
      if (endpointError) throw endpointError;
      const params = args[0], sid = params?.sessionId || params?.envelope?.sessionId;
      const creating = method === 'createSession' || params?.envelope?.type === 'createSession';
      const owner = creating ? (role === 'herder' ? 'local' : 'remote') : sid ? await choose(params) :
        (/^(?:(?:subscribe|resync|unsubscribe)(?:SessionsIndex|WorkspaceConfig)V4|initialize|getWorkspaceRuntimeIdentity)$/.test(method) ? (role === 'herder' ? 'local' : 'remote') : 'local');
      // Establish event transport before a native subscription can emit its
      // initial frame. No submitted command is retried on any transport error.
      if (/^subscribe.*V4$/.test(method)) await Promise.all([...subscriptions]);
      return owner === 'remote' ? remoteCall(method, args) : raw[method](...args);
    };
  }
  };
  if (activate) enable();
  return {raw, role, observe, owners, server, service, active, enable};
}
