import { expect, it } from "vitest";
import { recoveryModelQuotaFromProvider } from "../src/model-quota.js";
const now=Date.parse("2026-10-22T20:40:00Z");
it("uses fresh provider quota for native GLM refs without treating reset as recovery", () => {
 const quota={provider:"glm" as const,state:"quota_exhausted" as const,checkedAt:new Date(now).toISOString(),details:{limits:[{type:"TOKENS_LIMIT",nextResetTime:now-1000}]}};
 expect(recoveryModelQuotaFromProvider("account:zai-individual-coding-plan/GLM-5.3-Flash$high",quota,now)).toMatchObject({state:"exhausted",source:"glm:official-usage-api"});
 expect(recoveryModelQuotaFromProvider("omniroute/glm/GLM-5.3",{...quota,state:"reported"},now)).toMatchObject({state:"available"});
});
it("unknown mismatched stale or ambiguous route never means available", () => {
 const quota={provider:"minimax" as const,state:"reported" as const,checkedAt:new Date(now).toISOString()};
 expect(recoveryModelQuotaFromProvider("omniroute/minimax-combo-m3.1",quota,now).state).toBe("unknown");
 expect(recoveryModelQuotaFromProvider("account:zai-individual-coding-plan/GLM-5.3-Flash",quota,now).state).toBe("unknown");
 expect(recoveryModelQuotaFromProvider("minimax-coding-plan/MiniMax-M3.1-Flash",{...quota,checkedAt:new Date(now-301000).toISOString()},now).state).toBe("unknown");
 expect(recoveryModelQuotaFromProvider("minimax-coding-plan/MiniMax-M3.1-Flash",{...quota,state:"unknown"},now).state).toBe("unknown");
});
