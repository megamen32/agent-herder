import { createHash } from 'node:crypto';

type Input = { target: string; sender?: string; inputId?: string; message: string };
/** One bounded budget for automatic exchanges. Rejections are never queued.
 * Native durable input receipts remain authoritative across service restarts. */
export class CoordinationDeliveryBudget {
  private attempts = new Map<string, { fingerprint: string; at: number; result: Promise<string> }>();
  private windows = new Map<string, number[]>();
  constructor(private readonly now: () => number = Date.now) {}
  async run(input: Input, send: () => Promise<string>): Promise<string> {
    const now = this.now();
    for (const [key, attempt] of this.attempts) if (now - attempt.at > 24 * 60 * 60 * 1000) this.attempts.delete(key);
    for (const [key, times] of this.windows) {
      const recent = times.filter(time => now - time < 60_000);
      if (recent.length) this.windows.set(key, recent); else this.windows.delete(key);
    }
    const fingerprint = createHash('sha256').update(input.message).digest('hex');
    const pair = `${input.sender || 'unknown'}>${input.target}`;
    const key = `${pair}:${input.inputId || fingerprint}`;
    const previous = this.attempts.get(key);
    if (previous) return previous.fingerprint === fingerprint ? previous.result
      : JSON.stringify({ok:false,delivery:'input_id_conflict',activated:false});
    const limits: Array<[string, number]> = [[`pair:${pair}`,6],[`target:${input.target}`,12]];
    for (const [scope, limit] of limits) {
      const times = this.windows.get(scope) || [];
      if (times.length >= limit) return JSON.stringify({ok:false,delivery:'rate_limited',activated:false,retryAfterMs:Math.max(1,60_000 - (now - times[0]!))});
    }
    if (this.attempts.size >= 4096) return JSON.stringify({ok:false,delivery:'coordination_capacity',activated:false,retryAfterMs:60_000});
    for (const [scope] of limits) this.windows.set(scope,[...(this.windows.get(scope)||[]),now]);
    const result = Promise.resolve().then(send).then(value => {
      let delivery: string | undefined;
      try {delivery = JSON.parse(value).delivery;} catch { /* legacy textual receipt */ }
      if (delivery && ["skipped_inactive", "not_found", "not_attempted"].includes(delivery)) {
        this.attempts.delete(key);
        for (const [scope] of limits) {
          const times = this.windows.get(scope) || [];
          const index = times.indexOf(now);
          if (index >= 0) times.splice(index, 1);
        }
      }
      return value;
    }).catch(error => JSON.stringify({ok:false,delivery:'admission_unknown',activated:false,nonRetryable:true,error:error instanceof Error?error.message:String(error)}));
    this.attempts.set(key,{fingerprint,at:now,result});
    return result;
  }
}
const budgets = new WeakMap<object, CoordinationDeliveryBudget>();
export function deliveryBudgetFor(owner: object): CoordinationDeliveryBudget {
  let budget = budgets.get(owner);
  if (!budget) {budget = new CoordinationDeliveryBudget(); budgets.set(owner, budget);}
  return budget;
}
