import {z} from 'zod';
import {fail} from './errors.mjs';

const text=z.string().min(1).max(2000);
const action=z.discriminatedUnion('type',[
  z.object({type:z.literal('message'),label:z.string().min(1).max(20),text:z.string().min(1).max(300)}).strict(),
  z.object({type:z.literal('uri'),label:z.string().min(1).max(20),uri:z.string().max(2000).refine(v=>{try{const u=new URL(v);return u.protocol==='https:'&&!u.username&&!u.password;}catch{return false;}})}).strict()
]);
// Deliberately small typed Flex subset; no arbitrary JSON/protocol metadata.
const leaf=z.discriminatedUnion('type',[
  z.object({type:z.literal('text'),text,wrap:z.boolean().optional(),weight:z.enum(['regular','bold']).optional(),size:z.enum(['xs','sm','md','lg','xl','xxl']).optional()}).strict(),
  z.object({type:z.literal('button'),action,style:z.enum(['link','primary','secondary']).optional()}).strict(),
  z.object({type:z.literal('separator')}).strict()
]);
const box=z.object({type:z.literal('box'),layout:z.enum(['vertical','horizontal']),contents:z.array(leaf).min(1).max(20),spacing:z.enum(['none','xs','sm','md','lg','xl','xxl']).optional()}).strict();
const bubble=z.object({type:z.literal('bubble'),header:box.optional(),body:box,footer:box.optional()}).strict();
export const flexInput=z.object({altText:z.string().trim().min(1).max(400),contents:z.union([bubble,z.object({type:z.literal('carousel'),contents:z.array(bubble).min(1).max(10)}).strict()]),acknowledgeTransportSecurity:z.literal(true)}).strict();
export function validateFlex(value){const result=flexInput.safeParse(value);if(!result.success||Buffer.byteLength(JSON.stringify(value))>30000)fail(400,'invalid_flex','Supply altText, a supported Flex bubble/carousel, and acknowledgeTransportSecurity:true (30 KB maximum). Flex is not Letter Sealed.');return result.data;}
export function assertFlexTransport(chat){if(chat.kind==='openchat')fail(409,'flex_transport_unsupported','OpenChat Flex is blocked: the Square wire format and server support are unverified. No Talk or LIFF fallback is used.');}
