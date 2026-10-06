// A finite vocabulary: never echo arbitrary SDK messages, names, codes or keys.
export const preparationStages=['MESSAGE_PREPARATION','SELF_KEY_LOOKUP','RECIPIENT_KEY_NEGOTIATION','GROUP_KEY_LOOKUP','BUDDY_LOOKUP','ENCRYPTION'];
export const preparationCauses=['SELF_KEY_MISSING','RECIPIENT_KEY_MISSING','E2EE_UNSUPPORTED','SDK_TYPE_ERROR','SDK_ERROR','TIMEOUT','CANCELLED','LINE_REJECTED','NOT_FOUND','E2EE_KEY_EXCHANGE_FAILED','E2EE_INVALID_PROTOCOL','AUTHENTICATION_FAILED','NOT_AUTHORIZED_DEVICE','NOT_AUTHORIZED_SESSION','NOT_AUTHENTICATED','MUST_REFRESH_V3_TOKEN','FORBIDDEN'];
const diagnostics=new Set(preparationStages.flatMap(stage=>preparationCauses.map(cause=>`${stage}_${cause}`)));
export function preparationDiagnostic(message){
  const value=typeof message==='string'?message.match(/^Message preparation failed \(([A-Z0-9_]+)\)\. No message was sent\./)?.[1]:null;
  return diagnostics.has(value)?value:null;
}
