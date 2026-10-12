export const AUTOCONTINUE_HARNESS_IDS = ['codex','zcode','claude','opencode','hermes','qoder','fast-agent','chatgpt'] as const;
export type AutocontinueHarness = typeof AUTOCONTINUE_HARNESS_IDS[number];
export type WebSessionAutostartHarness = {harness:AutocontinueHarness;enabled:boolean;source:'harness'|'global'|'default';updatedAt?:string};
type ReadSettings = <T>(path:string,init?:RequestInit)=>Promise<T>;

function verified(value:WebSessionAutostartHarness,harness:AutocontinueHarness):WebSessionAutostartHarness {
 if(value?.harness!==harness||typeof value.enabled!=='boolean')throw new Error('Получены настройки другой среды');
 return value;
}
export async function loadAutocontinueHarnesses(read:ReadSettings):Promise<{settings:Partial<Record<AutocontinueHarness,WebSessionAutostartHarness>>;failed:AutocontinueHarness[]}> {
 const results=await Promise.allSettled(AUTOCONTINUE_HARNESS_IDS.map(async harness=>verified(await read<WebSessionAutostartHarness>(`/api/session-autostart/harnesses/${harness}`),harness)));
 const settings:Partial<Record<AutocontinueHarness,WebSessionAutostartHarness>>={},failed:AutocontinueHarness[]=[];
 results.forEach((result,index)=>{const harness=AUTOCONTINUE_HARNESS_IDS[index]!;if(result.status==='fulfilled')settings[harness]=result.value;else failed.push(harness);});
 return {settings,failed};
}
export async function saveAutocontinueHarness(read:ReadSettings,harness:AutocontinueHarness,enabled:boolean):Promise<WebSessionAutostartHarness> {
 return verified(await read<WebSessionAutostartHarness>(`/api/session-autostart/harnesses/${harness}`,{method:'PUT',body:JSON.stringify({enabled})}),harness);
}
