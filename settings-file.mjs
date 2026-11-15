import { readFileSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { dirname, extname, resolve } from 'node:path';
import { runtimeDefaults, validateRuntimeLimits } from './runtime-limits.mjs';

const text = value => typeof value === 'string' && Boolean(value.trim()) && !/[\x00-\x1f\x7f]/.test(value);
const boolean = value => typeof value === 'boolean';
const range = (min, max) => value => Number.isInteger(value) && value >= min && value <= max;
const port = range(1, 65535);
const oneOf = (...values) => value => values.includes(value);
const transport = oneOf('inherit', 'https');
const envName = value => typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
const interval = range(250, 900000);
const schema = {
  server: {
    transport: oneOf('local', 'tls', 'proxy'), host: text, port, public_origin: text,
    data_directory: text, tls_cert: text, tls_key: text
  },
  lan: { address: value => typeof value === 'string' && isIP(value) === 4, port, backend_port: port,
    caddy_path: text, caddy_data_directory: text },
  dashboard: {
    title: value => text(value) && value.length <= 64, historical: boolean,
    live: oneOf('mock', 'openf1', 'off'), chat: boolean,
    max_file_mib: range(1, 16), test_seconds: range(1, 120),
    historical_transport: transport, live_transport: transport, chat_transport: transport
  },
  openf1: { username_env: envName, password_env: envName },
  ui: {
    default_theme: oneOf('dark', 'light', 'system'), default_speed_units: oneOf('kmh', 'mph'),
    default_playback_speed: oneOf(0.5, 1, 2, 4), default_chat_sound: boolean,
    settings_poll_ms: interval, chat_poll_ms: interval, chat_contacts_poll_count: range(1, 100),
    live_mock_poll_ms: interval, live_poll_ms: interval, live_error_poll_ms: interval,
    live_mock_info_ms: interval, live_info_ms: interval, debug_poll_ms: interval,
    trace_max_points: range(50, 10000), sample_hold_ms: interval, replay_full_sample_ms: interval,
    telemetry_retry_ms: interval
  },
  limits: Object.fromEntries(Object.keys(runtimeDefaults).map(key => [key, Number.isInteger]))
};

export const defaultLan = Object.freeze({ address: '192.168.100.63', port: 8765, backend_port: 8766 });
const scalar = /^("(?:[^"\\]|\\.)*"|'[^']*'|true|false|[+-]?(?:0|[1-9][0-9]*(?:_[0-9]+)*))\s*(?:#.*)?$/;

function readScalar(token) {
  if (token.startsWith('"')) return JSON.parse(token);
  if (token.startsWith("'")) return token.slice(1, -1);
  if (token === 'true' || token === 'false') return token === 'true';
  return Number(token.replaceAll('_', ''));
}

function yamlScalar(raw, fail) {
  if (raw.startsWith('"') || raw.startsWith("'")) {
    const match = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*')(?:[ \t]+#.*)?$/.exec(raw);
    if (!match) fail('Invalid quoted value. Use single quotes around Windows paths.');
    const token = match[1];
    try { return token[0] === "'" ? token.slice(1, -1).replaceAll("''", "'") : JSON.parse(token); }
    catch { fail('Invalid quoted value. Use single quotes around Windows paths.'); }
  }
  const token = raw.replace(/[ \t]+#.*$/, '').trimEnd();
  if (token === 'true' || token === 'false') return token === 'true';
  if (/^[+-]?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(token)) return Number(token);
  if (!token || /^[-?:](?:\s|$)|^[#{}[\],&*!|>@%]/.test(token) ||
      /:\s/.test(token) || /^(?:null|~)$/i.test(token)) {
    fail('Use a string, number, true, or false on one line.');
  }
  return token;
}

function parseSections(contents, path) {
  const toml = extname(path).toLowerCase() === '.toml';
  const sections = {};
  let section;
  let indentation;
  for (const [index, raw] of contents.replace(/^\uFEFF/, '').split(/\r?\n/).entries()) {
    const line = raw.trim();
    const fail = message => { throw new Error(path + ':' + (index + 1) + ': ' + message); };
    if (!line || line.startsWith('#')) continue;
    const heading = toml ? /^\[([a-z_0-9]+)\]\s*(?:#.*)?$/.exec(line)
      : /^([a-z_0-9]+):(?:[ \t]+(?:\{\}[ \t]*)?(?:#.*)?)?$/.exec(raw.trimEnd());
    if (heading) {
      section = heading[1];
      if (!Object.hasOwn(schema, section)) fail('Unknown configuration section ' + section + '.');
      if (Object.hasOwn(sections, section)) fail('Duplicate section ' + section + '.');
      sections[section] = {};
      indentation = undefined;
      continue;
    }
    const item = toml ? /^()([a-z_0-9]+)\s*=\s*(.*)$/.exec(line)
      : /^( +)([a-z_0-9]+):[ \t]+(.+)$/.exec(raw.trimEnd());
    if (!section || !item) fail(toml ? 'Expected a setting under a section, such as port = 8765.'
      : 'Expected a section or an indented setting, such as port: 8765.');
    const [, indent, key, rawValue] = item;
    indentation ??= indent.length;
    if (indent.length !== indentation) fail('Use the same indentation for all settings in this section.');
    if (!Object.hasOwn(schema[section], key)) fail('Unknown setting ' + section + '.' + key + '.');
    if (Object.hasOwn(sections[section], key)) fail('Duplicate setting ' + section + '.' + key + '.');
    let value;
    if (toml) {
      const match = scalar.exec(rawValue);
      if (!match) fail('Use a quoted string, decimal integer, true, or false.');
      try { value = readScalar(match[1]); }
      catch { fail('Invalid quoted string. Use single quotes around a Windows path.'); }
    } else {
      value = yamlScalar(rawValue, fail);
    }
    if (!schema[section][key](value)) fail('Invalid value for ' + section + '.' + key + '. See config.example.yaml.');
    sections[section][key] = value;
  }
  return sections;
}

function loadSections(env, cwd) {
  const candidates = env.ADAM_CONFIG ? [env.ADAM_CONFIG] : ['config.yaml', 'dashboard.toml'];
  for (const candidate of candidates) {
    const path = resolve(cwd, candidate);
    let contents;
    try { contents = readFileSync(path, 'utf8'); }
    catch (error) {
      if (error.code === 'ENOENT' && !env.ADAM_CONFIG) continue;
      throw new Error('Cannot read configuration file ' + path + ' (' + error.code + ').');
    }
    const extension = extname(path).toLowerCase();
    if (!['.yaml', '.yml', '.toml'].includes(extension)) throw new Error('Use a .yaml, .yml, or .toml configuration file.');
    return { sections: parseSections(contents, path), directory: dirname(path) };
  }
  return { sections: {}, directory: cwd };
}

export function readSettings(env = process.env, cwd = process.cwd()) {
  const { sections, directory } = loadSections(env, cwd);
  const server = sections.server ?? {};
  for (const key of ['data_directory', 'tls_cert', 'tls_key']) {
    if (server[key]) server[key] = resolve(directory, server[key]);
  }
  const dashboard = Object.fromEntries(Object.entries(sections.dashboard ?? {}).map(([key, value]) =>
    [key === 'max_file_mib' ? 'maxFileMiB' : key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase()), value]));
  const lan = { ...defaultLan, ...sections.lan };
  for (const key of ['caddy_path', 'caddy_data_directory']) {
    if (lan[key]) lan[key] = resolve(directory, lan[key]);
  }
  if (lan.port === lan.backend_port) throw new Error('Use different LAN and backend ports.');
  return { server, lan, dashboard, openf1: sections.openf1 ?? {}, ui: sections.ui ?? {},
    limits: validateRuntimeLimits(sections.limits ?? {}) };
}

export function migrateSettings(cwd = process.cwd()) {
  const source = 'dashboard.toml';
  const { sections } = loadSections({ ADAM_CONFIG: source }, cwd);
  const output = ['# Migrated from dashboard.toml. See config.example.yaml for all settings.'];
  for (const [section, values] of Object.entries(sections)) {
    const entries = Object.entries(values);
    if (!entries.length) continue;
    output.push('', section + ':', ...entries.map(([key, value]) => '  ' + key + ': ' + JSON.stringify(value)));
  }
  writeFileSync(resolve(cwd, 'config.yaml'), output.join('\n') + '\n', { flag: 'wx' });
  return 'config.yaml';
}
