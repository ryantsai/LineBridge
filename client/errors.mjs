export const EXIT = Object.freeze({ok:0, internal:1, usage:2, credentials:3, denied:4, transport:5, remote:6, unavailable:7, unknown:8});

export class ClientError extends Error {
  constructor(code, message, exitCode, status) {
    super(message);
    Object.assign(this, {code, exitCode, ...(status === undefined ? {} : {status})});
  }
}
export function usage(message) { throw new ClientError('invalid_input', message, EXIT.usage); }
export function credentialError() {
  return new ClientError('credential_store_unavailable', 'Protected credential storage is unavailable or locked. Windows needs current-user DPAPI; macOS needs an unlocked Keychain; Linux needs secret-tool and an unlocked Secret Service session. No plaintext fallback was used. Explicit transient credentials can be supplied through the environment or a private stdin pipe.', EXIT.credentials);
}
export function missingCredentials() {
  return new ClientError('credentials_required', 'Enroll an existing scoped token with auth enroll, or supply transient credentials through the environment or a private stdin pipe.', EXIT.credentials);
}
export function unknownDelivery(status) {
  return new ClientError('delivery_unknown', 'The send outcome is unknown. It was not retried. Inspect the chat before another send; do not automatically create a new idempotency key.', EXIT.unknown, status);
}
