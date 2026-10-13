import {z} from 'zod';
export const fleetSessionControlSchema=z.object({
 operation:z.enum(['details','message-status','message','stop','resume']),
 inputId:z.string().trim().min(1).max(512).optional(),
 message:z.string().min(1).max(262144).optional(),
 mode:z.enum(['queue','steer']).optional(),
}).strict().superRefine((value,context)=>{
 if(['message','message-status','resume'].includes(value.operation)&&!value.inputId)context.addIssue({code:'custom',message:'Stable inputId required'});
 if(value.operation==='message'&&!value.message?.trim())context.addIssue({code:'custom',message:'Message required'});
});
export type FleetSessionControl=z.infer<typeof fleetSessionControlSchema>;
export type FleetSessionResponse={hostId:string;status:number;body:unknown};
