import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { dirname, resolve } from 'node:path';

const text = value => typeof value === 'string' && Boolean(value.trim()) && !/[\x00-\x1f\x7f]/.test(value);
const boolean = value => typeof value === 'boolean';
const range = (min, max) => value => Number.isInteger(value) && value >= min && value <= max;
const port = range(1, 65535);
const oneOf = (...values) => value => values.includes(value);
const transport = oneOf('inherit', 'https');
const envName = value => typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
const schema = {
  server: {
    transport: oneOf('local', 'tls', 'proxy'), host: text, port, public_origin: text,
    data_directory: text, tls_cert: text, tls_key: text
  },
  lan: { address: value => typeof value === 'string' && isIP(value) === 4, port, backend_port: port },
  dashboard: {
    title: value => text(value) && value.length <= 64, historical: boolean,
    live: oneOf('mock', 'openf1', 'off'), chat: boolean,
    max_file_mib: range(1, 16), test_seconds: range(1, 120),
    historical_transport: transport, live_transport: transport, chat_transport: transport
  },
  openf1: { username_env: envName, password_env: envName }
};

export const defaultLan = Object.freeze({ address: '192.168.100.63', port: 8765, backend_port: 8766 });
const scalar = /^("(?:[^"\\]|\\.)*"|'[^']*'|true|false|[+-]?(?:0|[1-9][0-9]*(?:_[0-9]+)*))\s*(?:#.*)?$/;

function readScalar(token) {
  if (token.startsWith('"')) return JSON.parse(token);
  if (token.startsWith("'")) return token.slice(1, -1);
  if (token === 'true' || token === 'false') return token === 'true';
  return Number(token.replaceAll('_', ''));
}

export function readSettings(env = process.env, cwd = process.cwd()) {
  const path = resolve(cwd, env.ADAM_CONFIG || 'dashboard.toml');
  let contents;
  try {
    contents = readFileSync(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT' && !env.ADAM_CONFIG) return { server: {}, lan: defaultLan, dashboard: {}, openf1: {} };
    throw new Error('Cannot read configuration file ' + path + ' (' + error.code + ').');
  }
  const sections = {};
  let section;
  for (const [index, raw] of contents.replace(/^\uFEFF/, '').split(/\r?\n/).entries()) {
    const line = raw.trim();
    const fail = message => { throw new Error(path + ':' + (index + 1) + ': ' + message); };
    if (!line || line.startsWith('#')) continue;
    const heading = /^\[([a-z_0-9]+)\]\s*(?:#.*)?$/.exec(line);
    if (heading) {
      section = heading[1];
      if (!Object.hasOwn(schema, section)) fail('Unknown configuration section [' + section + '].');
      if (Object.hasOwn(sections, section)) fail('Duplicate section [' + section + '].');
      sections[section] = {};
      continue;
    }
    const item = /^([a-z_0-9]+)\s*=\s*(.*)$/.exec(line);
    if (!section || !item) fail('Expected a setting under a section, such as port = 8765.');
    const [, key, rawValue] = item;
    if (!Object.hasOwn(schema[section], key)) fail('Unknown setting ' + section + '.' + key + '.');
    if (Object.hasOwn(sections[section], key)) fail('Duplicate setting ' + section + '.' + key + '.');
    const match = scalar.exec(rawValue);
    if (!match) fail('Use a quoted string, decimal integer, true, or false.');
    let value;
    try { value = readScalar(match[1]); }
    catch { fail('Invalid quoted string. Use single quotes around a Windows path.'); }
    if (!schema[section][key](value)) fail('Invalid value for ' + section + '.' + key + '. See dashboard.example.toml.');
    sections[section][key] = value;
  }
  const server = sections.server ?? {};
  for (const key of ['data_directory', 'tls_cert', 'tls_key']) {
    if (server[key]) server[key] = resolve(dirname(path), server[key]);
  }
  const dashboard = Object.fromEntries(Object.entries(sections.dashboard ?? {}).map(([key, value]) =>
    [key === 'max_file_mib' ? 'maxFileMiB' : key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase()), value]));
  const lan = { ...defaultLan, ...sections.lan };
  if (lan.port === lan.backend_port) throw new Error(path + ': Use different LAN and backend ports.');
  return { server, lan, dashboard, openf1: sections.openf1 ?? {} };
}
