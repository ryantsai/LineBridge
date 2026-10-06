import {PreparationFailure} from './send-preparation.mjs';

export const OA_NOTICE='Official Account messages are transport-encrypted, not Letter Sealed. This acknowledgment applies only to this message and recipient.';

// Only authenticated Buddy metadata for this exact recipient can establish OA
// identity. A missing key, MID prefix, display name or specVersion alone cannot.
export async function officialAccountCapability(client,chat){
  if(chat.kind!=='direct')return {officialAccount:false};
  let negotiation;
  try{negotiation=await client.talk.negotiateE2EEPublicKey({mid:chat.id});}
  catch(error){throw new PreparationFailure('RECIPIENT_KEY_NEGOTIATION',error);}
  if(negotiation?.specVersion!==-1)return {officialAccount:false,negotiation};
  if(negotiation.publicKey!=null)return {officialAccount:false,negotiation};
  // Pinned lineclientbot 0.1.3 ships BuddyService but does not attach it to
  // BaseClient. Match its getBuddyDetail_args field 4 and /BUDDY4 contract.
  let buddy;
  try{buddy=await client.request.request([[11,4,chat.id]],'getBuddyDetail',4,true,'/BUDDY4');}
  catch(error){throw new PreparationFailure('BUDDY_LOOKUP',error);}
  // LINE@ migrated into Official Accounts in 2019. Authenticated LINE_AT (3)
  // is positive identity evidence even when the separate businessAccount flag
  // is false. Require an actual boolean; do not infer LINE_AT_0 or unknown types.
  const lineAt=buddy?.botType===3||buddy?.botType==='LINE_AT';
  const businessType=[1,2,3,'OFFICIAL','LINE_AT_0','LINE_AT'].includes(buddy?.botType);
  const officialAccount=buddy?.mid===chat.id&&(buddy.businessAccount===true&&businessType||buddy.businessAccount===false&&lineAt);
  return {officialAccount,negotiation};
}
