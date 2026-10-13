import type {SessionMessageView} from '../types/index.js';
import type {OutboxEntry} from './composer-delivery.js';

const textOf = (message: SessionMessageView) =>
  (message.text ?? message.parts.filter(part => part.type === 'text').map(part => part.text ?? '').join('\n')).trim();
const imagesOf = (message: SessionMessageView) => message.parts
  .filter(part => part.type === 'image').map(part => part.imageUrl ?? '').sort();

/** Presentation reconciliation only: never sends, changes admission, or deletes receipts. */
export function projectDeliveredChat(messages: SessionMessageView[], entries: OutboxEntry[], sessionKey: string, imageMatches: ReadonlyMap<string, ReadonlySet<string>> = new Map()) {
  if (!sessionKey) return {messages,pending:[]};
  const own = entries.filter(entry => entry.sessionKey === sessionKey);
  const delivered = own.filter(entry => entry.status === 'delivered').sort((a,b) => a.createdAt-b.createdAt);
  const pending = own.filter(entry => entry.status !== 'delivered');
  const result = [...messages];
  const matched = new Set<string>();
  for (const entry of delivered) {
    const imageUrls = (entry.images ?? []).map(image => image.url).sort();
    const counterpart = messages.find(message => {
      if (message.role !== 'user' || matched.has(message.id) || textOf(message) !== entry.text.trim()) return false;
      // Native transcript IDs are authoritative when they preserve the submitted input ID.
      if (message.id === entry.inputId) return true;
      const timestamp = Date.parse(message.timestamp ?? '');
      if (!Number.isFinite(timestamp) || timestamp < entry.createdAt) return false;
      const sameImages = JSON.stringify(imagesOf(message)) === JSON.stringify(imageUrls)
        || imageMatches.get(message.id)?.has(entry.inputId) === true;
      if (!sameImages) return false;
      if (entry.nativeTurnId && message.turnId) return entry.nativeTurnId === message.turnId;
      // An identical earlier task must not swallow a new clarification. Missing native
      // timestamps remain unmatched; admission alone does not invent native history.
      // Legacy transcripts omit input/turn IDs. Only merge an equal body near the
      // observed admission, never an unrelated identical task many minutes later.
      const deliveredAt = entry.deliveredAt ?? entry.createdAt;
      return Number.isFinite(timestamp) && timestamp >= entry.createdAt && Math.abs(timestamp-deliveredAt) <= 10_000;
    });
    if (counterpart) { matched.add(counterpart.id); continue; }
    const date = new Date(entry.createdAt);
    const message: SessionMessageView = {
      id:`herder-delivered:${entry.inputId}`, role:'user', timestamp:Number.isFinite(date.getTime()) ? date.toISOString() : undefined, text:entry.text,
      parts:[{type:'text',text:entry.text},...(entry.images ?? []).map(image => ({type:'image' as const,imageUrl:image.url,fileName:image.fileName}))],
    };
    const after = result.findIndex(native => Date.parse(native.timestamp ?? '') > entry.createdAt);
    if (after === -1) result.push(message); else result.splice(after,0,message);
  }
  return {messages:result,pending};
}

/** Compare the actual upload identity, not its HTTP URL versus a native data URL.
 * Same SHA-256 namespace as SessionImageStore: harness, session, original filename, bytes.
 * WebCrypto is asynchronous so large images do not block React rendering.
 */
export async function resolveDeliveredImages(messages: SessionMessageView[], entries: OutboxEntry[], sessionKey: string): Promise<Map<string, Set<string>>> {
  const own = entries.filter(entry => entry.sessionKey === sessionKey && entry.status === 'delivered' && entry.images?.length);
  const result = new Map<string, Set<string>>();
  if (!own.length) return result;
  const separator = sessionKey.indexOf(':');
  const harness = sessionKey.slice(0,separator), id = sessionKey.slice(separator+1);
  for (const entry of own) {
    for (const message of messages) {
      const timestamp = Date.parse(message.timestamp ?? '');
      if (message.role !== 'user' || textOf(message) !== entry.text.trim() || !Number.isFinite(timestamp) || timestamp < entry.createdAt) continue;
      if (entry.nativeTurnId && message.turnId ? entry.nativeTurnId !== message.turnId : Math.abs(timestamp-(entry.deliveredAt ?? entry.createdAt)) > 10_000) continue;
      const urls = imagesOf(message);
      if (urls.length !== entry.images!.length) continue;
      const used = new Set<number>();
      let equal = true;
      for (const image of entry.images!) {
        let matched = -1;
        for (let n=0;n<urls.length;n++) {
          if (used.has(n)) continue;
          if (urls[n] === image.url) {matched=n;break;}
          const data = /^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(urls[n]);
          if (!data || data[1].length > 7 * 1024 * 1024) continue;
          try {
            const bytes = Uint8Array.from(atob(data[1]),char=>char.charCodeAt(0));
            const prefix = new TextEncoder().encode(`${harness}\0${id}\0${image.fileName}\0`);
            const full = new Uint8Array(prefix.length+bytes.length);full.set(prefix);full.set(bytes,prefix.length);
            const digest = new Uint8Array(await crypto.subtle.digest('SHA-256',full));
            if (Array.from(digest,byte=>byte.toString(16).padStart(2,'0')).join('') === image.id) {matched=n;break;}
          } catch { /* Unsupported or malformed bytes remain unproven, not an image match. */ }
        }
        if (matched === -1) {equal=false;break;}
        used.add(matched);
      }
      if (equal) {const inputs=result.get(message.id) ?? new Set<string>();inputs.add(entry.inputId);result.set(message.id,inputs);}
    }
  }
  return result;
}
