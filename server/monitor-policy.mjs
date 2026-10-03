// Talk sync is a long poll. Its transport deadline is independent of the
// freshness required to report a healthy receiver; waiting never renews success.
export const TALK_POLL_TIMEOUT_MS=180000;
export const MONITOR_STALE_AFTER_MS=60000;
