// Default, minimum and maximum for deployment-managed limits.
const bounds = {
  request_timeout_ms: [25000, 1000, 600000],
  headers_timeout_ms: [10000, 1000, 600000],
  socket_timeout_ms: [30000, 1000, 600000],
  max_connections: [128, 1, 4096],
  json_body_bytes: [16384, 1024, 1048576],
  max_pending_uploads: [6, 1, 64],
  chat_storage_mib: [128, 1, 16384],
  chat_messages_per_minute: [45, 1, 3000],
  chat_message_chars: [4000, 1, 16384],
  chat_page_size: [80, 1, 500],
  user_requests_per_minute: [240, 1, 6000],
  login_requests_per_ip_per_minute: [20, 1, 300],
  login_requests_per_username_per_minute: [10, 1, 300],
  password_changes_per_minute: [10, 1, 300],
  session_minutes: [720, 1, 43200],
  password_min_length: [1, 1, 256],
  lifecycle_confirmation_seconds: [60, 1, 600],
  debug_request_entries: [40, 1, 1000],
  audit_entries: [100, 1, 1000],
  config_history_entries: [50, 1, 500],
  config_confirmation_seconds: [60, 1, 600],
  openf1_timeout_ms: [12000, 500, 120000],
  openf1_max_response_mib: [4, 1, 32],
  openf1_cache_entries: [64, 1, 256],
  openf1_archive_catalog_cache_ms: [300000, 1000, 3600000],
  openf1_archive_samples_cache_ms: [600000, 1000, 3600000],
  openf1_live_session_cache_ms: [30000, 1000, 300000],
  openf1_live_drivers_cache_ms: [60000, 1000, 300000],
  openf1_live_samples_cache_ms: [5000, 1000, 60000],
  openf1_live_sample_window_ms: [30000, 1000, 120000],
  openf1_live_sample_max_age_ms: [35000, 1000, 180000],
  openf1_archive_requests_per_second: [3, 1, 3],
  openf1_archive_requests_per_minute: [30, 1, 30],
  openf1_live_requests_per_second: [6, 1, 6],
  openf1_live_requests_per_minute: [60, 1, 60],
  historical_window_ms: [300000, 1000, 1800000],
  historical_all_window_ms: [120000, 1000, 1800000]
};

export const runtimeDefaults = Object.freeze(Object.fromEntries(
  Object.entries(bounds).map(([name, [value]]) => [name, value])
));

export function validateRuntimeLimits(partial = {}) {
  for (const [key, value] of Object.entries(partial)) {
    if (!Object.hasOwn(bounds, key)) throw new Error('Unknown setting limits.' + key + '.');
    const [, min, max] = bounds[key];
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new Error('limits.' + key + ' must be an integer between ' + min + ' and ' + max + '.');
    }
  }
  return { ...partial };
}

export function resolveRuntimeLimits(partial) {
  const limits = { ...runtimeDefaults, ...validateRuntimeLimits(partial) };
  if (limits.headers_timeout_ms > limits.request_timeout_ms) {
    throw new Error('limits.headers_timeout_ms must not exceed limits.request_timeout_ms.');
  }
  return limits;
}
