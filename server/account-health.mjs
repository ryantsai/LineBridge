import {HubError} from './errors.mjs';

export const ACCOUNT_CHECK_TIMEOUT_MS=30000;
export const ACCOUNT_CHECK_INTERVAL_MS=60000;
// Four quick retries, then one background probe per minute until recovery.
export const accountRetryDelay=failures=>Math.min(ACCOUNT_CHECK_INTERVAL_MS,5000*2**Math.min(Math.max(0,failures-1),4));
const names=new Set(['Error','TimeoutError','AbortError','TypeError','RequestError','ClientClosed']);
const networkCodes=new Set(['ECONNRESET','ECONNREFUSED','ETIMEDOUT','ENOTFOUND','EAI_AGAIN','UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT','UND_ERR_SOCKET']);
const authCodes=new Set(['AUTHENTICATION_FAILED','NOT_AUTHORIZED_DEVICE','NOT_AUTHORIZED_SESSION','NOT_AUTHENTICATED']);
const protocolCodes=new Set([...authCodes,'NOT_AVAILABLE_SESSION','FORBIDDEN','NOT_FOUND','INTERNAL_ERROR','SYSTEM_ERROR','INVALID_PARAMETER','MUST_REFRESH_V3_TOKEN','EXCESSIVE_ACCESS','NOT_IMPLEMENTED','SERVER_BUSY','SHOULD_RETRY','MAINTENANCE_ERROR','UNKNOWN']);
// Numeric values are interpreted only as TalkException codes from getProfile.
const talkCodes=new Map([[1,'AUTHENTICATION_FAILED'],[8,'NOT_AUTHORIZED_DEVICE'],[14,'NOT_AUTHORIZED_SESSION'],[17,'NOT_AUTHENTICATED']]);

export function safeAccountDiagnostic(value={}) {
  const errorName=names.has(value?.errorName)?value.errorName:'UnknownError';
  const code=networkCodes.has(value?.code)||protocolCodes.has(value?.code)?value.code:undefined;
  const kind=errorName==='RequestError'&&authCodes.has(code)?'auth':errorName==='TimeoutError'?'timeout':networkCodes.has(code)?'network':errorName==='AbortError'||errorName==='ClientClosed'?'cancelled':errorName==='RequestError'?'protocol':'unknown';
  return {kind,errorName,...(code?{code}:{})};
}
export function accountDiagnostic(error) {
  if(error?.accountDiagnostic)return safeAccountDiagnostic(error.accountDiagnostic);
  const upstream=error?.data?.code??error?.data?.errorCode;
  const code=error?.name==='RequestError'?(talkCodes.get(upstream)??upstream):(error?.code??error?.cause?.code);
  return safeAccountDiagnostic({errorName:error?.name,code});
}
export function accountCheckError(error) {
  const diagnostic=accountDiagnostic(error),auth=diagnostic.kind==='auth';
  const safe=new HubError(auth?409:502,auth?'login_required':'health_check_failed',auth?'LINE requires a new QR login.':'Account verification failed; a background retry is scheduled.');
  // Messages, stacks, headers, URLs and SDK payloads never cross the worker pipe.
  safe.accountDiagnostic=diagnostic;return safe;
}
