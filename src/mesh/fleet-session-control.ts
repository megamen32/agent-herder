import {z} from 'zod';
export const fleetSessionControlSchema=z.object({
  operation:z.enum(['details','message-status','message','stop','resume','set-target']),
  inputId:z.string().trim().min(1).max(512).optional(),
  message:z.string().min(1).max(262144).optional(),
  mode:z.enum(['queue','steer']).optional(),
  /** Work machine of an existing session. */
  hostId:z.string().trim().min(1).max(512).optional(),
  /** Work directory of an existing session on that machine. */
  cwd:z.string().trim().min(1).max(4096).optional(),
}).strict().superRefine((value,context)=>{
  if(['message','message-status','resume'].includes(value.operation)&&!value.inputId)context.addIssue({code:'custom',message:'Stable inputId required'});
  if(value.operation==='message'&&!value.message?.trim())context.addIssue({code:'custom',message:'Message required'});
  if(value.operation==='set-target'&&!value.hostId&&!value.cwd)context.addIssue({code:'custom',message:'hostId or cwd required'});
});
export type FleetSessionControl=z.infer<typeof fleetSessionControlSchema>;
export type FleetSessionResponse={hostId:string;status:number;body:unknown};
