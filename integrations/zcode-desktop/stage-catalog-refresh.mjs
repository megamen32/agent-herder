import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve,relative} from 'node:path';
import {pathToFileURL} from 'node:url';
import {startHerderCatalogRefresh} from './catalog-refresh.mjs';

export function stageDesktopCatalogRefresh(source, tasksIndexPath, {verify = true} = {}) {
  const begin = source.indexOf('function $8('), end = source.indexOf('i($8,"createWindowHostControllerRuntime")', begin);
  if (begin < 0 || end < begin) throw Error('Unsupported native Desktop controller');
  const native = source.slice(begin,end);
  const digest = createHash('sha256').update(native).digest('hex');
  if (verify && digest !== '916fb649ac95bfc7f0e11ed4d91437cbc4123cc4c85be75d60ada67d815d7f6e') throw Error('Native Desktop controller changed; revalidate before staging');
  const marker = 'p=new Map;function m(';
  if (native.split(marker).length !== 2 || native.split('dispose(){F.dispose();').length !== 2) throw Error('Native insertion points changed');
  const paths = JSON.stringify([tasksIndexPath, tasksIndexPath+'-wal']);
  const readRevision = `()=>${paths}.map(path=>{try{const st=process.getBuiltinModule('node:fs').statSync(path);return st.mtimeMs+':'+st.size}catch(error){if(error.code==='ENOENT')return 'missing';throw error}}).join('|')`;
  const injected = `p=new Map;const __herderCatalogRefresh=startHerderCatalogRefresh({timers:{setInterval,clearInterval},readRevision:${readRevision},listSources:()=>Array.from(n.values()).map(scope=>e.resolveSource(scope)).filter(Boolean),refreshSource:source=>I(source,true),onError:(error,source)=>source&&e.onSourceError?.(source.scope,'external-catalog-refresh',error)});function m(`;
  const patched = native.replace(marker,injected).replace('dispose(){F.dispose();','dispose(){__herderCatalogRefresh.dispose();F.dispose();');
  return source.slice(0,begin)+startHerderCatalogRefresh.toString()+';'+patched+source.slice(end);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [input,output,index] = process.argv.slice(2);
  if (!input || !output || !index) throw Error('Usage: stage-catalog-refresh.mjs extracted-host-index.js .tmp/output.js tasks-index.sqlite');
  const stagingRoot = resolve('.tmp'), target = resolve(output), rel = relative(stagingRoot,target);
  if (!rel || rel.startsWith('..') || resolve(input) === target) throw Error('Only a separate project .tmp candidate may be written');
  writeFileSync(target,stageDesktopCatalogRefresh(readFileSync(input,'utf8'),index),{mode:0o600});
  console.log(JSON.stringify({staged:target,installed:false,nativeRuntimeChanged:false}));
}
