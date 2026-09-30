export class HubError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
// Only use when preparation failed before dispatch or LINE explicitly rejected the RPC.
export class SendRejectedError extends HubError {}
export const fail = (status, code, message) => { throw new HubError(status, code, message); };
export function publicError(error) {
  return error instanceof HubError
    ? { status: error.status, code: error.code, message: error.message }
    : { status: 502, code: 'upstream_unavailable', message: 'The operation could not be completed. Check the account status and retry reads. Do not automatically retry sends.' };
}
