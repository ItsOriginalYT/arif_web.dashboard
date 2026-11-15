import { createServer as http } from 'node:http';
import { createServer as https } from 'node:https';
import { existsSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { platform, release, arch, hostname, totalmem, freemem, uptime } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { accounts } from './accounts.mjs';
import { configuration, validateFileSettings } from './config.mjs';
import { migrateSettings, readSettings } from './settings-file.mjs';
import { resolveRuntimeLimits } from './runtime-limits.mjs';
import { bootstrap, HttpError, json, now, openStore, parse } from './storage.mjs';
import { integer, telemetry } from './telemetry.mjs';

const publicFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/ui.js', ['ui.js', 'text/javascript; charset=utf-8']],
  ['/timing.js', ['timing.js', 'text/javascript; charset=utf-8']],
  ['/chat.js', ['chat.js', 'text/javascript; charset=utf-8']],
  ['/admin.js', ['admin.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']]
]);

const loopback = address => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address);
const MiB = 1024 * 1024;
const endpoint = /^(\/api\/(?:historical|live)\/)([a-z]+)$/;
const chatPath = /^\/api\/chat\/(?:with\/(\d+)(\/file)?|attachment\/(\d+))$/;
const userPath = /^\/api\/admin\/users(?:\/(\d+))?$/;
const commands = [
  'help', 'system info', 'users list', 'users create <username>', 'users edit <id>', 'users delete <id>',
  'restart', 'restart confirm', 'stop', 'stop confirm', 'debug on|off',
  'system configuration show|save|test|stop|apply|revert|rewind|reset',
  'system configuration default override', 'system configuration profiles list',
  'system configuration profiles create|load <name>'
];
const debugOn = ['enabled', 'enable', 'on', 'true', 'positive'];
const debugOff = ['disabled', 'disable', 'off', 'false', 'negative'];

function debugPath(path) {
  if (/^\/api\/(?:settings|preferences|historical\/(?:sessions|drivers|laps|samples)|live\/(?:info|samples)|chat\/contacts|admin\/(?:console|config|system|users|audit))$/.test(path)) return path;
  if (chatPath.test(path) || userPath.test(path)) return path.replace(/\d+/g, ':id');
  return '/api/(other)';
}

export function environment(env = process.env, file = readSettings(env)) {
  const { server, dashboard, openf1 } = file;
  const limits = resolveRuntimeLimits(file.limits);
  const mode = env.ADAM_TRANSPORT ?? server.transport ?? 'local';
  const host = env.ADAM_HOST ?? server.host ?? '127.0.0.1';
  const port = integer(env.ADAM_PORT ?? server.port ?? 8765, 1, 65535, 'port');
  if (!['local', 'tls', 'proxy'].includes(mode)) throw new Error('ADAM_TRANSPORT must be local, tls or proxy.');
  if (mode !== 'tls' && !loopback(host)) throw new Error('Local and proxy modes must bind to a loopback address.');
  const publicOrigin = env.ADAM_PUBLIC_ORIGIN ?? server.public_origin;
  if (mode !== 'local') {
    const url = new URL(publicOrigin ?? 'https://invalid.local/');
    if (!publicOrigin || url.origin !== publicOrigin || url.protocol !== 'https:') {
      throw new Error('Set ADAM_PUBLIC_ORIGIN to the canonical HTTPS origin without a trailing slash.');
    }
  }
  const username = env[openf1.username_env ?? 'OPENF1_USERNAME'];
  const password = env[openf1.password_env ?? 'OPENF1_PASSWORD'];
  if (Boolean(username) !== Boolean(password)) throw new Error('Set both OpenF1 credentials or leave both unset.');
  const account = username && password ? { username, password } : undefined;
  const tls = mode === 'tls' ? {
    key: readFileSync(env.ADAM_TLS_KEY ?? server.tls_key ?? ''),
    cert: readFileSync(env.ADAM_TLS_CERT ?? server.tls_cert ?? ''),
    minVersion: 'TLSv1.2'
  } : undefined;
  return { mode, host, port, publicOrigin, account, tls, dashboard: validateFileSettings(dashboard, Boolean(account)),
    directory: resolve(env.ADAM_DATA ?? server.data_directory ?? 'data'), limits, ui: file.ui };
}

function limiter() {
  const slots = new Map();
  return (key, max, window) => {
    const now = Date.now();
    if (slots.size >= 4000) {
      for (const [name, slot] of slots) if (slot.until <= now) slots.delete(name);
      if (slots.size >= 4000 && !slots.has(key)) throw new HttpError(429, 'Server busy. Try again shortly.');
    }
    let slot = slots.get(key);
    if (!slot || slot.until <= now) {
      slot = { uses: 0, until: now + window };
      slots.set(key, slot);
    }
    if (++slot.uses > max) throw new HttpError(429, 'Too many requests. Try again shortly.');
  };
}

async function readBody(request, max) {
  if (Number(request.headers['content-length']) > max) throw new HttpError(413, 'Request exceeds the size limit.');
  let size = 0;
  const chunks = [];
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > max) throw new HttpError(413, 'Request exceeds the size limit.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

async function readJson(request, maxBytes) {
  if (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] ?? '')) {
    throw new HttpError(415, 'Use application/json for this request.');
  }
  const raw = await readBody(request, maxBytes);
  try {
    const body = parse(raw.toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body;
  } catch {
    throw new HttpError(400, 'Invalid JSON request.');
  }
}

function securityHeaders(response) {
  response.setHeader('Content-Security-Policy', "default-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  response.setHeader('Cache-Control', 'no-store');
}

function clientOrigin(request, options) {
  const { mode, publicOrigin } = options;
  const host = request.headers.host?.toLowerCase();
  if (mode === 'local') {
    if (!loopback(request.socket.remoteAddress) || !/^(localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/.test(host ?? '')) {
      throw new HttpError(421, 'Open this service using its loopback address.');
    }
    return 'http://' + host;
  }
  if (new URL(publicOrigin).host !== host) throw new HttpError(421, 'Use the configured HTTPS address.');
  if (mode === 'proxy' && (!loopback(request.socket.remoteAddress) || request.headers['x-forwarded-proto'] !== 'https')) {
    throw new HttpError(403, 'Connect through the configured HTTPS reverse proxy.');
  }
  return publicOrigin;
}

function send(response, data, status = 200) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(json(data));
}

function download(response, store, id, user) {
  const item = store.get('SELECT filename,attachment FROM messages WHERE id=? AND (sender=? OR recipient=?)',
    id, user.id, user.id);
  if (!item?.attachment) throw new HttpError(404, 'Attachment not found.');
  const name = encodeURIComponent(item.filename).replace(/['()*]/g, char => '%' + char.charCodeAt(0).toString(16));
  response.writeHead(200, {
    'Content-Type': 'application/octet-stream', 'Content-Length': item.attachment.length,
    'Content-Disposition': "attachment; filename=\"download\"; filename*=UTF-8''" + name
  });
  response.end(item.attachment);
}

function chat(store, request, response, url, context, config, authorize, limit, limits) {
  const user = context.user;
  const { all, get, run, tx } = store;
  const { pathname: path, searchParams } = url;
  const method = request.method;
  if (method === 'GET' && path === '/api/chat/contacts') {
    return all(
      'SELECT u.id,u.username,u.display,' +
      '(SELECT MAX(m.id) FROM messages m WHERE m.sender=u.id AND m.recipient=?) AS latestIncoming ' +
      'FROM users u WHERE u.id<>? AND (u.disabled=0 OR EXISTS (' +
      'SELECT 1 FROM messages m WHERE (m.sender=u.id AND m.recipient=?) OR (m.sender=? AND m.recipient=u.id))) ORDER BY u.display',
      user.id, user.id, user.id, user.id
    );
  }
  const route = chatPath.exec(path);
  if (!route) throw new HttpError(404, 'Unknown chat endpoint.');
  if (method === 'GET' && route[3]) {
    download(response, store, integer(route[3], 1, Number.MAX_SAFE_INTEGER, 'attachment'), user);
    return;
  }
  if (!route[1]) throw new HttpError(405, 'Method not allowed.');
  const other = integer(route[1], 1, Number.MAX_SAFE_INTEGER, 'contact');
  const peer = get('SELECT id,disabled FROM users WHERE id=? AND id<>?', other, user.id);
  if (!peer) throw new HttpError(404, 'Contact not found.');
  if (method === 'GET' && !route[2]) {
    const cursor = searchParams.get('before');
    const before = cursor === null ? Number.MAX_SAFE_INTEGER : integer(cursor, 1, Number.MAX_SAFE_INTEGER, 'message cursor');
    return all('SELECT id,sender,recipient,sent,body,filename FROM messages ' +
      'WHERE id<? AND ((sender=? AND recipient=?) OR (sender=? AND recipient=?)) ORDER BY id DESC LIMIT ?',
      before, user.id, other, other, user.id, limits.chat_page_size).reverse();
  }
  if (method !== 'POST') throw new HttpError(405, 'Method not allowed.');
  if (peer.disabled) throw new HttpError(409, 'This contact is disabled.');
  limit('chat:' + user.id, limits.chat_messages_per_minute, 60_000);
  const save = (body, name = null, bytes = null) => tx(() => {
    const latest = authorize();
    if (latest.user.id !== user.id) throw new HttpError(403, 'Sign in again.');
    if (bytes && bytes.length > latest.config.maxFileMiB * MiB) throw new HttpError(413, 'Attachment exceeds the updated limit.');
    if (!get('SELECT id FROM users WHERE id=? AND disabled=0', other)) throw new HttpError(409, 'This contact is unavailable.');
    if (bytes) {
      const used = get('SELECT COALESCE(SUM(length(attachment)),0) AS size FROM messages WHERE sender=? AND attachment IS NOT NULL', user.id).size;
      if (used + bytes.length > limits.chat_storage_mib * MiB) {
        throw new HttpError(413, 'Your total attachment storage limit is ' + limits.chat_storage_mib + ' MiB.');
      }
    }
    const record = run('INSERT INTO messages(sender,recipient,sent,body,filename,attachment) VALUES(?,?,?,?,?,?)',
      user.id, other, now(), body, name, bytes);
    return { id: Number(record.lastInsertRowid) };
  });
  if (route[2]) {
    if (request.headers['content-type'] !== 'application/octet-stream') throw new HttpError(415, 'Upload binary file data.');
    let name;
    try {
      name = decodeURIComponent(request.headers['x-file-name'] ?? '').trim();
    } catch {
      throw new HttpError(400, 'Invalid attachment name.');
    }
    if (!name || name.length > 160 || /[\x00-\x1f\x7f/\\]/.test(name)) throw new HttpError(400, 'Invalid attachment name.');
    return readBody(request, config.maxFileMiB * MiB).then(bytes => {
      if (!bytes.length) throw new HttpError(400, 'Choose a nonempty file.');
      return save('', name, bytes);
    });
  }
  return readJson(request, limits.json_body_bytes).then(({ message }) => {
    if (typeof message !== 'string' || !message.trim() || message.length > limits.chat_message_chars) {
      throw new HttpError(400, 'Enter a message of 1–' + limits.chat_message_chars.toLocaleString('en-US') + ' characters.');
    }
    return save(message.trim());
  });
}

export function createDashboard(options, fetcher = fetch) {
  const limits = resolveRuntimeLimits(options.limits);
  const store = openStore(options.directory);
  const config = configuration(store, Boolean(options.account), options.dashboard, limits);
  const auth = accounts(store, limits);
  const provider = telemetry({ account: options.account, fetcher, limits });
  const rate = limiter();
  let pendingUploads = 0;
  let shuttingDown = false;
  const pendingLifecycle = new Map();
  const debugSessions = new Map();
  const debugState = session => {
    const record = debugSessions.get(session);
    if (record && record.until <= Date.now()) {
      debugSessions.delete(session);
      return undefined;
    }
    return record;
  };
  const system = () => ({
    hostname: hostname(), platform: platform(), release: release(), architecture: arch(),
    node: process.version, processUptime: Math.floor(process.uptime()), hostUptime: Math.floor(uptime()),
    memoryTotal: totalmem(), memoryFree: freemem(), transport: options.mode,
    port: options.port, storage: 'SQLite', credentialsConfigured: Boolean(options.account)
  });

  async function consoleCommand(body, context) {
    if (typeof body.command !== 'string' || body.command.length > 120) throw new HttpError(400, 'Invalid command.');
    const parts = body.command.trim().split(/\s+/);
    const words = parts.map(part => part.toLowerCase());
    const [a, b, c, d, e] = words;
    if (a === 'restart' || a === 'stop') {
      const time = Date.now();
      if (!options.lifecycle || shuttingDown) throw new HttpError(409, 'Application lifecycle control is unavailable.');
      if (words.length === 1) {
        for (const [session, pending] of pendingLifecycle) {
          if (pending.until <= time) pendingLifecycle.delete(session);
        }
        pendingLifecycle.set(context.session, { action: a, until: time + limits.lifecycle_confirmation_seconds * 1000 });
        return { output: 'Enter ' + a + ' confirm within ' + limits.lifecycle_confirmation_seconds + ' seconds to continue.' };
      }
      const pending = pendingLifecycle.get(context.session);
      if (words.length !== 2 || b !== 'confirm' || pending?.action !== a || pending.until <= time) {
        throw new HttpError(409, 'Enter ' + a + ' first to request confirmation.');
      }
      if (a === 'restart' && options.validateRestart) {
        try { options.validateRestart(); }
        catch (error) { throw new HttpError(400, error.message); }
      }
      store.audit(context.user.username, 'application.' + a);
      pendingLifecycle.delete(context.session);
      shuttingDown = true;
      return { operation: a, output: a === 'restart' ? 'Restarting Arif WebDashboard…' : 'Stopping Arif WebDashboard…' };
    }
    if (a === 'debug') {
      if (words.length > 2 || (b && !debugOn.includes(b) && !debugOff.includes(b))) {
        throw new HttpError(400, 'Use debug on or debug off.');
      }
      if (debugOn.includes(b)) {
        for (const session of debugSessions.keys()) debugState(session);
        debugSessions.set(context.session, { until: Date.now() + limits.session_minutes * 60000, requests: [] });
      } else if (debugOff.includes(b)) {
        debugSessions.delete(context.session);
      }
      if (b) store.audit(context.user.username, 'debug.' + (debugOn.includes(b) ? 'enable' : 'disable'));
      return { output: 'Debug ' + (debugState(context.session) ? 'enabled.' : 'disabled.') };
    }
    if (a === 'help' && words.length === 1) return { output: commands };
    if (['system', 'syst', 'sys'].includes(a) && b === 'info' && words.length === 2) return { output: system() };
    if (a === 'users' && b === 'list' && words.length === 2) return { output: auth.list() };
    if (a === 'users' && ['create', 'edit', 'delete'].includes(b) && words.length === 3) {
      const target = b === 'create' ? parts[2] : integer(c, 1, Number.MAX_SAFE_INTEGER, 'user ID');
      store.audit(context.user.username, 'console.users.' + b, { target });
      return { open: { action: b, target } };
    }
    if (['system', 'syst', 'sys'].includes(a) && ['configuration', 'config', 'cfg'].includes(b)) {
      if (c === 'show' && words.length === 3) return { output: config.inspect(context.session) };
      if (['prof', 'profiles', 'sets'].includes(c)) {
        if (d === 'list' && words.length === 4) return { output: config.inspect(context.session).profiles };
        if (['create', 'load'].includes(d) && e && words.length === 5) {
          return { state: config.execute(d + '-profile', { ...body, name: parts[4] }, context) };
        }
      }
      if (['default', 'def'].includes(c) && ['override', 'ovr'].includes(d) && words.length === 4) {
        return { state: config.execute('override-default', body, context) };
      }
      if (words.length === 3 && ['save', 'test', 'stop', 'apply', 'revert', 'rewind', 'reset'].includes(c)) {
        return { state: config.execute(c, body, context) };
      }
    }
    throw new HttpError(400, 'Unknown command. Enter help for available commands.');
  }

  async function handle(request, response) {
    securityHeaders(response);
    try {
      const origin = clientOrigin(request, options);
      const secure = origin.startsWith('https:');
      if (secure) response.setHeader('Strict-Transport-Security', 'max-age=86400');
      const url = new URL(request.url, origin);
      if (url.origin !== origin) throw new HttpError(400, 'Invalid request target.');
      const path = url.pathname;
      const method = request.method;
      if (method === 'GET' && publicFiles.has(path)) {
        const [file, type] = publicFiles.get(path);
        response.writeHead(200, { 'Content-Type': type });
        response.end(readFileSync(new URL('./public/' + file, import.meta.url)));
        return;
      }
      if (!path.startsWith('/api/') || !['GET', 'POST'].includes(method)) throw new HttpError(404, 'Endpoint not found.');
      if (method === 'POST' && (request.headers.origin !== origin || request.headers['x-adam-request'] !== '1')) {
        throw new HttpError(403, 'Request origin could not be verified.');
      }
      const ip = secure && options.mode === 'proxy' ? (request.headers['x-forwarded-for'] ?? 'proxy').split(',')[0].trim()
        : request.socket.remoteAddress;
      if (method === 'POST' && path === '/api/login') {
        rate('auth-ip:' + ip, limits.login_requests_per_ip_per_minute, 60_000);
        const credentials = await readJson(request, limits.json_body_bytes);
        const name = typeof credentials.username === 'string' ? credentials.username.slice(0, 32).toLowerCase() : '';
        rate('auth-name:' + name, limits.login_requests_per_username_per_minute, 60_000);
        return send(response, await auth.login(credentials, response, secure));
      }
      const requireUser = (admin = false, changing = false) => {
        const context = auth.context(request);
        if (!context) throw new HttpError(401, 'Sign in to continue.');
        if (!changing && context.user.change_required) throw new HttpError(403, 'Change your temporary password to continue.');
        if (admin && context.user.role !== 'admin') throw new HttpError(403, 'Administrator access is required.');
        return context;
      };
      if (method === 'GET' && path === '/api/session') {
        return send(response, { user: auth.context(request)?.user ?? null, secure, transport: options.mode,
          limits: { password_min_length: limits.password_min_length } });
      }
      if (method === 'POST' && path === '/api/logout') {
        const context = requireUser(false, true);
        auth.logout(context.session, response, secure);
        return send(response, { signedOut: true });
      }
      if (method === 'POST' && path === '/api/password') {
        const body = await readJson(request, limits.json_body_bytes);
        const { user } = requireUser(false, true);
        rate('change:' + user.id, limits.password_changes_per_minute, 60_000);
        return send(response, await auth.changePassword(user, body, response, secure, () => requireUser(false, true)));
      }
      const context = requireUser();
      const debug = context.user.role === 'admin' && debugState(context.session);
      if (debug && path !== '/api/admin/debug') {
        const started = Date.now();
        response.once('finish', () => {
          debug.requests.push({ method, path: debugPath(path), status: response.statusCode, ms: Date.now() - started });
          if (debug.requests.length > limits.debug_request_entries) debug.requests.shift();
        });
      }
      rate('user:' + context.user.id, limits.user_requests_per_minute, 60_000);
      const serviceConfig = service => {
        const current = requireUser();
        const effective = config.effective(current.session).config;
        if (!effective[service] || effective[service] === 'off') throw new HttpError(503, 'This service is disabled.');
        if (effective[service + 'Transport'] === 'https' && !secure) {
          throw new HttpError(403, 'This service requires the configured HTTPS address.');
        }
        return { ...current, config: effective };
      };
      if (method === 'GET' && path === '/api/settings') {
        const { chat_message_chars, chat_page_size, historical_window_ms, historical_all_window_ms, password_min_length } = limits;
        return send(response, { ...config.effective(context.session), ui: options.ui ?? {},
          limits: { chat_message_chars, chat_page_size, historical_window_ms, historical_all_window_ms, password_min_length } });
      }
      if (method === 'POST' && path === '/api/preferences') {
        const data = await readJson(request, limits.json_body_bytes);
        return send(response, auth.preferences(requireUser().user, data));
      }
      const dataRoute = endpoint.exec(path);
      if (method === 'GET' && dataRoute) {
        const service = dataRoute[1].split('/')[2];
        const action = dataRoute[2];
        const effective = serviceConfig(service).config;
        if (service === 'historical') return send(response, await provider.historical(action, url.searchParams));
        if (!['info', 'samples'].includes(action)) throw new HttpError(404, 'Unknown live endpoint.');
        return send(response, await provider.live(effective.live, action, url.searchParams));
      }
      if (path.startsWith('/api/chat/')) {
        const current = serviceConfig('chat');
        const upload = method === 'POST' && path.endsWith('/file');
        if (upload && pendingUploads >= limits.max_pending_uploads) throw new HttpError(429, 'Uploads are busy. Try again shortly.');
        if (upload) pendingUploads += 1;
        try {
          const result = await chat(store, request, response, url, context, current.config, () => serviceConfig('chat'), rate, limits);
          return response.writableEnded ? undefined : send(response, result);
        } finally {
          if (upload) pendingUploads -= 1;
        }
      }
      if (path.startsWith('/api/admin/')) {
        requireUser(true);
        const body = method === 'POST' ? await readJson(request, limits.json_body_bytes) : null;
        const admin = () => requireUser(true);
        const current = admin();
        const userRoute = userPath.exec(path);
        if (userRoute && method === 'GET' && !userRoute[1]) return send(response, auth.list());
        if (userRoute && method === 'POST') {
          const id = userRoute[1] ? integer(userRoute[1], 1, Number.MAX_SAFE_INTEGER, 'user ID') : undefined;
          const op = id ? body.action : 'create';
          if (!['edit', 'delete', 'create'].includes(op) || (id && op === 'create')) throw new HttpError(400, 'Unknown account action.');
          return send(response, await auth.manage(current.user, op, body, id, admin));
        }
        if (method === 'GET' && path === '/api/admin/system') return send(response, system());
        if (method === 'GET' && path === '/api/admin/audit') {
          return send(response, store.all('SELECT id,at,actor,action,detail FROM audit ORDER BY id DESC LIMIT ?', limits.audit_entries)
            .map(row => ({ ...row, detail: parse(row.detail) })));
        }
        if (method === 'GET' && path === '/api/admin/config') return send(response, config.inspect(current.session));
        if (method === 'POST' && path === '/api/admin/config') {
          if (['create-profile', 'override-default'].includes(body.action)) throw new HttpError(403, 'Use the command console for this action.');
          return send(response, config.execute(body.action, body, current));
        }
        if (method === 'GET' && path === '/api/admin/debug') {
          const record = debugState(current.session);
          return send(response, { enabled: Boolean(record), requests: record?.requests ?? [] });
        }
        if (method === 'POST' && path === '/api/admin/console') {
          const result = await consoleCommand(body, current);
          if (result.operation) {
            const afterResponse = () => {
              response.off('finish', afterResponse);
              response.off('close', afterResponse);
              options.lifecycle(result.operation);
            };
            response.once('finish', afterResponse);
            response.once('close', afterResponse);
          }
          return send(response, result);
        }
      }
      throw new HttpError(404, 'Endpoint not found.');
    } catch (error) {
      request.resume();
      if (response.headersSent) {
        response.destroy();
        return;
      }
      if (!(error instanceof HttpError)) console.error('Internal request failure:', error.code ?? error.name);
      send(response, { error: error instanceof HttpError ? error.message : 'Internal server error.' },
        error instanceof HttpError ? error.status : 500);
    }
  }

  const server = options.mode === 'tls' ? https(options.tls, handle) : http(handle);
  server.requestTimeout = limits.request_timeout_ms;
  server.headersTimeout = limits.headers_timeout_ms;
  server.setTimeout(limits.socket_timeout_ms);
  server.maxConnections = limits.max_connections;
  server.on('close', () => store.db.close());
  return { server, store };
}

async function main() {
  if (process.argv[2] === 'migrate-config') {
    console.log('Created ' + migrateSettings() + '.');
    return;
  }
  if (process.argv[2] === 'lan-settings') {
    const { lan } = readSettings();
    console.log(json(lan));
    return;
  }
  if (process.argv[2] === 'check-config') {
    environment();
    console.log('Dashboard configuration is valid.');
    return;
  }
  if (process.argv[2] === 'account-status') {
    const path = join(environment().directory, 'dashboard.sqlite');
    if (!existsSync(path)) { console.log('setup'); return; }
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='users'").get();
      console.log(table && db.prepare('SELECT 1 FROM users LIMIT 1').get() ? 'ready' : 'setup');
    } finally { db.close(); }
    return;
  }
  if (process.argv[2] === 'bootstrap') {
    const options = environment();
    if (process.stdin.isTTY) throw new Error('Pipe the temporary password from a hidden prompt. See README.md.');
    const chunks = [];
    let length = 0;
    for await (const chunk of process.stdin) {
      length += chunk.length;
      if (length > 258) throw new Error('Bootstrap input is too long.');
      chunks.push(chunk);
    }
    const input = Buffer.concat(chunks);
    const store = openStore(options.directory);
    try {
      await bootstrap(store, input.toString('utf8').replace(/\r?\n$/, ''), options.limits.password_min_length);
      console.log('Administrator created. First login requires a password change.');
    } finally {
      input.fill(0);
      for (const chunk of chunks) chunk.fill(0);
      store.db.close();
    }
    return;
  }
  let app;
  let draining = false;
  let exitRequested = false;
  function lifecycle(operation) {
    if (operation === 'stop') exitRequested = true;
    if (draining || !app.server.listening) return;
    draining = true;
    app.server.close(() => {
      draining = false;
      if (operation === 'restart' && !exitRequested) {
        try { launch(); }
        catch (error) { console.error(error.message); process.exitCode = 1; }
      }
    });
  }
  function launch() {
    const options = environment();
    app = createDashboard({ ...options, lifecycle, validateRestart: environment });
    if (!app.store.get('SELECT id FROM users LIMIT 1')) {
      app.store.db.close();
      throw new Error('Bootstrap Administrator before starting the server. See README.md.');
    }
    app.server.on('error', error => {
      console.error('Unable to start the server:', error.code ?? error.name);
      process.exitCode = 1;
    });
    app.server.listen(options.port, options.host, () => {
      const address = options.host.includes(':') ? '[' + options.host + ']' : options.host;
      console.log('Arif WebDashboard: ' + (options.publicOrigin ?? 'http://' + address + ':' + options.port));
    });
  }
  launch();
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => lifecycle('stop'));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
