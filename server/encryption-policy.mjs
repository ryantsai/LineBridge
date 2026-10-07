import {InternalError} from '@evex/linejs/base';

// Resume, reads, monitoring and message preparation use existing keys only.
// The SDK's NOT_FOUND fallback may otherwise register a replacement group key.
// QR setup retains its separate explicit enrollment path on the original SDK.
export function existingKeyE2EE(client){
  const view=Object.create(client.e2ee);
  view.tryRegisterE2EEGroupKey=()=>{throw new InternalError('RequestError','An existing group encryption key is required.',{code:'NOT_FOUND'});};
  view.registerE2EEKeyPair=()=>{throw new InternalError('NoE2EEKey','An existing encryption key is required.');};
  return view;
}
