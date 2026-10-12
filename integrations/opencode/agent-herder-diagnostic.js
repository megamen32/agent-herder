// Temporary, opt-in native-loader probe. Delegates the frozen implementation;
// it never sends prompts or changes native configuration/state.
import AgentHerderAutopilot from './agent-herder-autopilot.js?diagnostic=20261012-fetch-v2'
import {appendFile,stat} from 'node:fs/promises'
import {join} from 'node:path'

export default async function AgentHerderDiagnostic(input, options = {}) {
  if (options.diagnostics !== true || typeof options.diagnosticSessionId !== 'string') return AgentHerderAutopilot(input)
  const file = join(input.directory, '.agent-herder-opencode-diagnostic.jsonl')
  let count = 0
  async function record(value) {
    if (count++ >= 128) return
    try {
      const bytes = await stat(file).then(s=>s.size,()=>0)
      if (bytes >= 65536) return
      await appendFile(file, JSON.stringify({at:new Date().toISOString(),...value})+'\n', {mode:0o600})
    } catch {} // Diagnostic failure cannot alter the existing hook's behavior.
  }
  if (options.implementationUrl && (typeof options.implementationUrl !== 'string' || !options.implementationUrl.startsWith('file://'))) throw new TypeError('Diagnostic implementation must use an explicit file URL')
  const implementation = options.implementationUrl ? (await import(options.implementationUrl)).default : AgentHerderAutopilot
  const hooks = await implementation(input, {observeContextFetch: async value=>{
    if (value.sessionId === options.diagnosticSessionId) await record({phase:'fetch',...value})
  }})
  await record({phase:'factory',directory:input.directory,hooks:Object.keys(hooks)})
  const wrapped = {}
  for (const [name,fn] of Object.entries(hooks)) {
    if (typeof fn !== 'function' || !['config','experimental.chat.messages.transform','experimental.chat.system.transform'].includes(name)) { wrapped[name]=fn; continue }
    wrapped[name] = async (...args)=>{
      const user=args[1]?.messages?.findLast(m=>m.info?.role==='user')
      const sessionID=user?.info?.sessionID || args[0]?.sessionID || args[0]?.event?.properties?.sessionID
      if (sessionID && sessionID !== options.diagnosticSessionId) return fn(...args)
      const before=user?.parts?.filter(p=>p.type==='text').map(p=>p.text).join('\n')
      const metadata={hook:name,sessionID,rootUserId:user?.info?.id,hasTextPart:user?.parts?.some(p=>p.type==='text'&&typeof p.text==='string')===true}
      await record({phase:'enter',...metadata})
      try {
        const result=await fn(...args)
        const after=user?.parts?.filter(p=>p.type==='text').map(p=>p.text).join('\n')
        await record({phase:'return',...metadata,textChanged:before!==after})
        return result
      } catch (error) {
        await record({phase:'error',...metadata,errorType:['Error','TypeError','SyntaxError','DOMException'].includes(error?.constructor?.name)?error.constructor.name:'unknown'})
        throw error
      }
    }
  }
  return wrapped
}
