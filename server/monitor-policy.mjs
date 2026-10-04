// Talk sync is a long poll. Its transport deadline is independent of the
// freshness required to report a healthy receiver; waiting never renews success.
export const TALK_POLL_TIMEOUT_MS=180000;
export const MONITOR_STALE_AFTER_MS=60000;
export const DEFAULT_REFRESH_INTERVAL_SECONDS=60;
export const MIN_REFRESH_INTERVAL_SECONDS=3;
export const MAX_REFRESH_INTERVAL_SECONDS=3600;

export function refreshIntervalSeconds(store){
  const value=store.setting('messageRefreshIntervalSeconds',DEFAULT_REFRESH_INTERVAL_SECONDS);
  return Number.isInteger(value)&&value>=MIN_REFRESH_INTERVAL_SECONDS&&value<=MAX_REFRESH_INTERVAL_SECONDS?value:DEFAULT_REFRESH_INTERVAL_SECONDS;
}
