import {describe, expect, it, vi} from 'vitest';
import {pinZcodeCreateModel} from '../src/ahap-zcode-runner.js';
const base='4cc673aa-6c6a-418b-8b91-9e601fef99f6/MiniMax-M3.1-Flash';
const selected=base+'$enabled';
function fixture() {
  const createSession=vi.fn(async(options:any)=>({id:'native-created',...options}));
  const listModels=vi.fn(async()=>[base]);
  const catalog={settings:{model:{available:[{ref:{providerId:base.split('/')[0],modelId:base.split('/')[1]},
    reasoning:{levels:[{value:'disabled'},{value:'enabled'}],defaultLevel:'disabled'}}]}}};
  const readCreateModelCatalog=vi.fn(async()=>catalog);
  return {adapter:{createSession,listModels,readCreateModelCatalog},catalog};
}
const options={name:'owned-ci',cwd:'/owned/project',fullAccess:false};
describe('explicit ZCode owner create model pin',()=>{
  it('leaves the original adapter and default create behavior unchanged without a pin',async()=>{
    const {adapter}=fixture(),original=adapter.createSession;
    const pinned=pinZcodeCreateModel(adapter as any,undefined);
    expect(pinned).toBe(adapter);expect(pinned.createSession).toBe(original);
    await pinned.createSession(options);expect(original).toHaveBeenCalledWith(options);
    expect(adapter.listModels).not.toHaveBeenCalled();expect(adapter.readCreateModelCatalog).not.toHaveBeenCalled();
  });
  it('verifies the listed base and actual native reasoning enum before creating with the exact pin',async()=>{
    const {adapter}=fixture(),original=adapter.createSession;
    const pinned=pinZcodeCreateModel(adapter as any,selected);
    const proof=await pinned.verifyPinnedCreateModel!();
    expect(proof).toMatchObject({model:selected,provider_id:base.split('/')[0],reasoning_level:'enabled',source:'zcode-native-create-model-catalog'});
    expect(original).not.toHaveBeenCalled();
    await pinned.createSession(options);expect(original).toHaveBeenCalledWith({...options,model:selected});
  });
  it.each(['missing-base','missing-reasoning','duplicate-provider','missing-catalog','conflicting-model'])('refuses %s before native create',async mutation=>{
    const {adapter,catalog}=fixture(),original=adapter.createSession;
    if(mutation==='missing-base')adapter.listModels.mockResolvedValue([]);
    if(mutation==='missing-reasoning')catalog.settings.model.available[0].reasoning.levels=[{value:'disabled'}];
    if(mutation==='duplicate-provider')catalog.settings.model.available.push(structuredClone(catalog.settings.model.available[0]));
    if(mutation==='missing-catalog')adapter.readCreateModelCatalog.mockRejectedValue(Error('native unavailable'));
    const pinned=pinZcodeCreateModel(adapter as any,selected);
    await expect(pinned.createSession({...options,...(mutation==='conflicting-model'?{model:base+'$disabled'}:{})})).rejects.toThrow();
    expect(original).not.toHaveBeenCalled();
  });
  it.each(['',base,base+'$',selected+' ', 'provider/model$enabled\n'])('refuses an incomplete or ambiguous pin %j',pin=>{
    const {adapter}=fixture();expect(()=>pinZcodeCreateModel(adapter as any,pin)).toThrow();
  });
});
