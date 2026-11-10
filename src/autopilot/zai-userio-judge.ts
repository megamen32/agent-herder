import { randomUUID } from "node:crypto";
import { UserIoAgentChannel, type UserIoConfig } from "../adapters/userio-agent-channel.js";
import type { ZaiBrowserJudgeAttempt, ZaiBrowserJudgeOutcome, ZaiBrowserJudgeSlot } from "./zai-browser-judge.js";
import { ZaiBrowserJudgeError } from "./zai-browser-judge.js";

const SCOPE=/^[a-f0-9]{64}$/u;
const REF=/^[a-f0-9-]{12,80}$/iu;

/** One fixed-model judge slot on an explicitly addressed UserIO browser profile.
 * The extension, not Vibe or CDP, opens an isolated owned inference tab.
 */
export class ZaiUserIoJudgeSlot implements ZaiBrowserJudgeSlot {
  private readonly channel:UserIoAgentChannel;
  private readonly scope:string;
  private quarantined=false;
  private inFlight=false;
  constructor(config:UserIoConfig){
    this.channel=new UserIoAgentChannel(config);
    this.scope=config.accountScope;
    if(!SCOPE.test(this.scope))throw new ZaiBrowserJudgeError("zai_userio_scope_invalid");
  }
  isQuarantined(){return this.quarantined;}
  async infer(input:ZaiBrowserJudgeAttempt):Promise<ZaiBrowserJudgeOutcome>{
    if(this.quarantined)throw new ZaiBrowserJudgeError("zai_userio_requires_reconciliation");
    if(this.inFlight)return {kind:"busy"};
    if(input.signal.aborted||input.shouldContinue&&!await input.shouldContinue())
      throw new DOMException("Z.AI judge cancelled","AbortError");
    this.inFlight=true;
    try{
      await this.channel.verifyPrincipal();
      const proof=await this.channel.call("zai_scope",{},85000);
      if(proof.account_scope!==this.scope)throw new ZaiBrowserJudgeError("zai_userio_account_changed");
      if(input.signal.aborted||input.shouldContinue&&!await input.shouldContinue())
        throw new DOMException("Z.AI judge cancelled","AbortError");
      const result=await this.channel.call("zai_judge",{
        request_id:randomUUID(),model:input.model,prompt:input.prompt,
        expected_account_scope:this.scope,
      },350000);
      if(input.signal.aborted||input.shouldContinue&&!await input.shouldContinue())
        throw new DOMException("Z.AI judge cancelled","AbortError");
      if(result.kind==="busy"||result.kind==="model_unavailable"||result.kind==="quota")
        return {kind:result.kind};
      if(result.kind==="answer"&&typeof result.text==="string"&&result.text.trim()
        &&typeof result.userMessageId==="string"&&REF.test(result.userMessageId)
        &&typeof result.assistantMessageId==="string"&&REF.test(result.assistantMessageId)
        &&result.userMessageId!==result.assistantMessageId)
        return {kind:"answer",text:result.text,
          userMessageId:result.userMessageId,assistantMessageId:result.assistantMessageId};
      this.quarantined=true;
      throw new ZaiBrowserJudgeError("zai_userio_result_unconfirmed");
    }catch(error){
      const message=error instanceof Error?error.message:"";
      if(["zai_judge_outcome_unknown","userio_command_outcome_unknown",
          "userio_transport_unavailable","zai_judge_duplicate_attempt_refused"].includes(message)){
        this.quarantined=true;
        throw new ZaiBrowserJudgeError("zai_userio_outcome_unknown");
      }
      throw error;
    }finally{this.inFlight=false;}
  }
  async close():Promise<void>{
    // The extension closes only its own idle, confirmed tab. An uncertain
    // tab remains untouched for native reconciliation.
  }
}
