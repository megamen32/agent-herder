#!/usr/bin/env node
// Read-only real-native regression. --original reads the unmodified native
// services retained by the bridge; default reads the routed services used by
// Herder and Desktop. Never creates/loads/resumes/sends an input to a session.
import net from 'node:net';
import assert from 'node:assert/strict';
const args = process.argv.slice(2);
const option = name => args[args.indexOf(name) + 1];
if (!args.includes('--session') || !args.includes('--workspace')) throw Error('Usage: --session OWN_NATIVE_ID --workspace ABSOLUTE_WORKSPACE [--original]');
const sessionId = option('--session'), workspacePath = option('--workspace');
assert.ok(workspacePath.startsWith('/'));
const original = args.includes('--original');
async function read(role) {
  const socket = net.createConnection(`/run/user/${process.getuid()}/agent-herder/zcode-${role}.sock`);
  socket.setTimeout(8000, () => socket.destroy(Error('Native state read timed out')));
  return new Promise((resolve, reject) => {
    let text = '';
    socket.on('error', reject);
    socket.on('connect', () => socket.write(JSON.stringify({type:'call',id:1,
      method:original ? '__observe' : '__viewRead',args:[{workspacePath,workspaceIdentity:workspacePath,sessionId}]})+'\n'));
    socket.on('data', chunk => {
      text += chunk;
      if (text.length > 32*1024*1024) {socket.destroy(Error('Native read too large'));return;}
      if (!text.includes('\n')) return;
      try {
        const result = JSON.parse(text.slice(0,text.indexOf('\n')));
        if (result.error) throw Error(result.error.message);
        const snapshot = original ? result.value.snapshot : result.value;
        resolve(snapshot ? {sessionId:snapshot.session.sessionId,status:snapshot.session.status,
          revision:snapshot.runtime.stateRevision,turnId:snapshot.runtime.activeTurnId || null,
          eventSeq:snapshot.runtime.eventSeq} : null);
      } catch (error) {reject(error);}
      finally {socket.end();}
    });
  });
}
const herder = await read('herder'), desktop = await read('desktop');
assert.ok(herder, 'Herder fixture must already exist; the canary never loads it');
assert.deepEqual(desktop, herder, 'Desktop must see the SAME existing native session state, not a separate runtime');
console.log(JSON.stringify({accepted:true,mode:original?'original-native-services':'shared-native-services',...herder}));
