import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { createDashboard } from '../server.mjs';
import { bootstrap } from '../storage.mjs';

const initial = 'initial-test-only';
const finished = 'changed-test-only';
const temporary = 'other-test-only';

function fixtureFeed(url, init) {
  const { pathname, searchParams } = new URL(url);
  const session = {
    session_key: 42, session_name: 'Race', location: 'Test Circuit',
    date_start: '2024-03-01T08:00:00Z', date_end: '2024-03-01T10:00:00Z'
  };
  const live = { ...session, session_key: 99,
    date_start: new Date(Date.now() - 60_000).toISOString(), date_end: new Date(Date.now() + 60_000).toISOString() };
  if (pathname === '/token') {
    assert.equal(init.method, 'POST');
    assert.equal(init.body.get('username'), 'fixture');
    assert.equal(init.body.get('password'), 'fixture-secret');
    return Response.json({ access_token: 'fixture-token', expires_in: 120 });
  }
  if (searchParams.get('session_key') === 'latest' || searchParams.get('session_key') === '99') {
    assert.equal(init.headers.Authorization, 'Bearer fixture-token');
  } else {
    assert.equal(init.headers.Authorization, undefined);
  }
  if (pathname.endsWith('/sessions')) return Response.json([searchParams.get('session_key') === 'latest' ? live : session]);
  if (pathname.endsWith('/drivers')) return Response.json([{ driver_number: 1, full_name: 'Fixture Driver' }]);
  if (pathname.endsWith('/laps')) return Response.json([{ driver_number: 1, lap_number: 1, lap_duration: 90, date_start: session.date_start }]);
  if (pathname.endsWith('/car_data')) {
    assert.match(url, /&date>[^&]+&date<[^&]+/);
    const date = searchParams.get('session_key') === '99' ? new Date().toISOString() : session.date_start;
    return Response.json([{ date, driver_number: 1, speed: 300, throttle: 100, n_gear: 7, rpm: 11500 }]);
  }
  throw new Error('Unexpected test provider request: ' + url);
}

async function instance(t, overrides = {}, bootstrapPassword = initial) {
  const directory = await mkdtemp(join(tmpdir(), 'arif-webdashboard-test-'));
  const app = createDashboard({ mode: 'local', directory, port: 8765,
    account: { username: 'fixture', password: 'fixture-secret' }, ...overrides }, fixtureFeed);
  t.after(async () => {
    if (app.server.listening) {
      app.server.closeAllConnections();
      await new Promise(resolve => app.server.close(resolve));
    } else {
      app.store.db.close();
    }
    await rm(directory, { recursive: true, force: true });
  });
  await bootstrap(app.store, bootstrapPassword);
  await assert.rejects(bootstrap(app.store, bootstrapPassword), { status: 409 });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const url = 'http://127.0.0.1:' + app.server.address().port;
  return { ...app, url };
}

function client(app, proxy) {
  let cookie;
  return {
    async call(path, body, extra = {}) {
      const headers = {
        ...(cookie ? { Cookie: cookie } : {}),
        ...(proxy ? { Host: new URL(proxy).host, 'X-Forwarded-Proto': 'https' } : {}),
        ...(body === undefined ? {} : { Origin: proxy ?? app.url,
          'X-Adam-Request': '1', 'Content-Type': 'application/json' }),
        ...extra
      };
      const address = app.url + '/api/' + path;
      const method = body === undefined ? 'GET' : 'POST';
      const bytes = body === undefined ? undefined : body instanceof Uint8Array ? body : JSON.stringify(body);
      const response = proxy ? await forwarded(address, method, headers, bytes) : await fetch(address, { method, headers, body: bytes });
      const setCookie = response.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0];
      const data = response.headers.get('content-type')?.includes('application/json')
        ? await response.json() : Buffer.from(await response.arrayBuffer());
      return { status: response.status, data, headers: response.headers };
    }
  };
}

function forwarded(address, method, headers, body) {
  return new Promise((resolve, reject) => {
    const upstream = httpRequest(address, { method, headers }, async incoming => {
      try {
        const parts = [];
        for await (const chunk of incoming) parts.push(chunk);
        const headers = new Headers(incoming.headers);
        resolve(new Response(Buffer.concat(parts), { status: incoming.statusCode, headers }));
      } catch (error) {
        reject(error);
      }
    });
    upstream.on('error', reject);
    upstream.end(body);
  });
}

async function ok(client, path, body, headers) {
  const result = await client.call(path, body, headers);
  assert.equal(result.status, 200, JSON.stringify(result.data));
  return result.data;
}

async function signIn(client, name = 'Administrator', old = initial, password = finished) {
  const user = await ok(client, 'login', { username: name, password: old });
  return user.change_required ? ok(client, 'password', { current: old, password }) : user;
}

async function confirm(client, payload) {
  const first = await ok(client, 'admin/config', { ...payload, step: 'start' });
  assert.equal(first.step, 1);
  const second = await ok(client, 'admin/config', { ...payload, step: 1, token: first.confirmation });
  assert.equal(second.step, 2);
  return ok(client, 'admin/config', { ...payload, step: 2, token: second.confirmation });
}

test('login, first password rotation, account roles and CSRF protection', async t => {
  const app = await instance(t);
  const admin = client(app);
  const second = client(app);
  const guest = client(app);
  assert.equal((await guest.call('admin/users')).status, 401);
  assert.equal((await guest.call('login', { username: 'Administrator', password: initial }, { Origin: 'https://other.test' })).status, 403);
  assert.equal((await ok(admin, 'login', { username: 'Administrator', password: initial })).change_required, 1);
  await ok(second, 'login', { username: 'Administrator', password: initial });
  assert.equal((await admin.call('admin/config')).status, 403);
  assert.equal((await admin.call('live/info')).status, 403);
  await ok(admin, 'password', { current: initial, password: finished });
  assert.equal((await ok(second, 'session')).user, null);
  assert.equal((await second.call('login', { username: 'Administrator', password: initial })).status, 401);
  const row = app.store.get('SELECT hash FROM users');
  assert.match(row.hash, /^[a-f0-9]{32}:[a-f0-9]{128}$/);
  const member = await ok(admin, 'admin/users', { username: 'member1', password: temporary });
  assert.equal(member.change_required, 1);
  assert.equal('hash' in member, false);
  assert.equal('password' in member, false);
  const user = await signIn(guest, 'member1', temporary);
  assert.equal(user.role, 'member');
  assert.equal((await guest.call('admin/users', { username: 'fake', password: temporary })).status, 403);
  const prefs = { theme: 'light', units: 'mph', playbackSpeed: 2, chatSound: true };
  assert.deepEqual((await ok(guest, 'preferences', prefs)).prefs, prefs);
  assert.deepEqual((await ok(guest, 'session')).user.prefs, prefs);
  const edited = await ok(admin, 'admin/users/' + member.id, { action: 'edit', disabled: true });
  assert.equal(edited.disabled, 1);
  assert.equal((await ok(guest, 'session')).user, null);
  const log = await ok(admin, 'admin/audit');
  assert.ok(log.some(row => row.action === 'account.edit'));
  assert.ok(!JSON.stringify(log).includes(temporary));
  const ui = await fetch(app.url);
  assert.equal(ui.status, 200);
  assert.match(ui.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  await ui.text();
});

test('one-character passwords work for setup, account creation, changes and resets', async t => {
  const app = await instance(t, {}, 'a');
  const admin = client(app);
  await signIn(admin, 'Administrator', 'a', 'b');
  assert.equal((await admin.call('password', { current: 'b', password: '' })).status, 400);
  assert.equal((await admin.call('admin/users', { username: 'blank', password: ' ' })).status, 400);
  const member = await ok(admin, 'admin/users', { username: 'member1', password: 'c' });
  await signIn(client(app), member.username, 'c', 'd');
  await ok(admin, 'admin/users/' + member.id, { action: 'edit', password: 'e' });
  await signIn(client(app), member.username, 'e', 'f');
  assert.equal((await signIn(client(app), member.username, 'f')).change_required, 0);
});

test('console lifecycle confirmation and debug are scoped to the administrator session', async t => {
  const operations = [];
  const app = await instance(t, { lifecycle: operation => operations.push(operation) });
  const admin = client(app);
  const other = client(app);
  await signIn(admin);
  await signIn(other, 'Administrator', finished);
  const command = (client, command) => ok(client, 'admin/console', { command });
  await command(admin, 'debug positive');
  await ok(admin, 'settings?secret=redact-this');
  const debug = await ok(admin, 'admin/debug');
  assert.equal(debug.enabled, true);
  assert.ok(debug.requests.some(row => row.method === 'GET' && row.path === '/api/settings' && row.status === 200));
  assert.ok(!JSON.stringify(debug).includes('redact-this'));
  assert.deepEqual(await ok(other, 'admin/debug'), { enabled: false, requests: [] });
  await command(admin, 'debug negative');
  assert.deepEqual(await ok(admin, 'admin/debug'), { enabled: false, requests: [] });
  assert.equal((await admin.call('admin/console', { command: 'stop confirm' })).status, 409);
  assert.match((await command(admin, 'restart')).output, /restart confirm/);
  assert.equal((await other.call('admin/console', { command: 'restart confirm' })).status, 409);
  assert.deepEqual(operations, []);
  assert.equal((await command(admin, 'restart confirm')).operation, 'restart');
  assert.deepEqual(operations, ['restart']);
});

test('direct messages, authenticated downloads, limits and account deletion', async t => {
  const app = await instance(t);
  const admin = client(app);
  const sender = client(app);
  const receiver = client(app);
  await signIn(admin);
  const alice = await ok(admin, 'admin/users', { username: 'alice', password: temporary });
  const bob = await ok(admin, 'admin/users', { username: 'bobby', password: temporary });
  await signIn(sender, 'alice', temporary);
  await signIn(receiver, 'bobby', temporary);
  await ok(sender, 'chat/with/' + bob.id, { message: '<b>Hello</b>' });
  const fileHeaders = { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent('data ü.csv') };
  const file = await ok(sender, 'chat/with/' + bob.id + '/file', Buffer.from('speed\n180'), fileHeaders);
  const messages = await ok(receiver, 'chat/with/' + alice.id);
  assert.equal(messages[0].body, '<b>Hello</b>');
  assert.equal(messages[1].filename, 'data ü.csv');
  assert.deepEqual(await ok(admin, 'chat/with/' + alice.id), []);
  const path = 'chat/attachment/' + file.id;
  assert.equal((await admin.call(path)).status, 404);
  assert.equal((await client(app).call(path)).status, 401);
  const download = await receiver.call(path);
  assert.equal(download.data.toString(), 'speed\n180');
  assert.match(download.headers.get('content-disposition'), /^attachment/);
  assert.equal((await sender.call('chat/with/' + bob.id + '/file', Buffer.alloc(8 * 1024 * 1024 + 1), fileHeaders)).status, 413);
  await ok(admin, 'admin/users/' + bob.id, { action: 'delete' });
  assert.equal((await sender.call(path)).status, 404);
  assert.equal((await ok(receiver, 'session')).user, null);
});

test('TEST is session-private, expires, and supports double-confirmed version changes', async t => {
  const app = await instance(t);
  const admin = client(app);
  const other = client(app);
  await signIn(admin);
  await signIn(other, 'Administrator', finished);
  let state = await ok(admin, 'admin/config');
  const factory = state.draft;
  const updated = { ...factory, title: 'Preview', testSeconds: 1, liveTransport: 'https' };
  state = await ok(admin, 'admin/config', { action: 'save', draft: updated, revision: state.revision });
  assert.equal((await other.call('admin/config', { action: 'save', draft: factory, revision: state.revision - 1 })).status, 409);
  const revision = state.revision;
  await ok(admin, 'admin/config', { action: 'test', revision });
  assert.equal((await ok(admin, 'settings')).config.title, 'Preview');
  assert.equal((await admin.call('live/info')).status, 403);
  assert.equal((await ok(other, 'settings')).config.title, factory.title);
  assert.equal((await ok(other, 'live/info')).mode, 'mock');
  await delay(1100);
  assert.equal((await ok(admin, 'settings')).config.title, factory.title);
  await ok(admin, 'admin/config', { action: 'test', revision });
  await ok(admin, 'admin/config', { action: 'stop' });
  assert.equal((await ok(admin, 'settings')).previewUntil, null);
  const start = await ok(admin, 'admin/config', { action: 'apply', revision, step: 'start' });
  assert.equal((await other.call('admin/config', { action: 'apply', revision, step: 1, token: start.confirmation })).status, 409);
  assert.equal((await admin.call('admin/config', { action: 'apply', revision, step: 2, token: start.confirmation })).status, 409);
  state = await confirm(admin, { action: 'apply', revision });
  assert.equal(state.parent, 1);
  assert.equal((await ok(other, 'settings')).config.title, 'Preview');
  state = (await ok(admin, 'admin/console', { command: 'sys cfg sets create Race_Mode', revision: state.revision })).state;
  assert.equal(state.profiles[0].name, 'Race_Mode');
  state = (await ok(admin, 'admin/console', { command: 'sys cfg def ovr', revision: state.revision })).state;
  assert.equal(state.defaults.title, 'Preview');
  state = await ok(admin, 'admin/config', { action: 'rewind', revision: state.revision });
  assert.equal(state.active, 1);
  assert.equal(state.versions.length, 2);
  state = await confirm(admin, { action: 'reset', revision: state.revision });
  assert.equal(state.draft.title, 'Preview');
  assert.equal(state.config.title, factory.title);
  state = await ok(admin, 'admin/config', { action: 'revert', revision: state.revision });
  assert.equal(state.draft.title, factory.title);
  state = await ok(admin, 'admin/config', { action: 'load-profile', name: 'race_mode', revision: state.revision });
  assert.equal(state.draft.title, 'Preview');
  assert.equal((await admin.call('admin/console', { command: 'echo hello' })).status, 400);
});

test('historical telemetry and authorized live mode with provider fixtures', async t => {
  const app = await instance(t);
  const admin = client(app);
  await signIn(admin);
  assert.equal((await ok(admin, 'historical/sessions?year=2024'))[0].session_key, 42);
  assert.equal((await ok(admin, 'historical/drivers?session=42'))[0].driver_number, 1);
  const laps = await ok(admin, 'historical/laps?session=42&driver=1');
  assert.equal(laps[0].lap_number, 1);
  const time = 'start=2024-03-01T08:00:00Z&end=2024-03-01T08:01:30Z';
  assert.equal((await ok(admin, 'historical/samples?session=42&driver=1&' + time))[0].speed, 300);
  assert.equal((await admin.call('historical/samples?session=42&driver=1&' + time.replace('08:01:30', '09:01:30'))).status, 400);
  assert.equal((await ok(admin, 'historical/laps?session=42&driver=all'))[0].driver_number, 1);
  assert.equal((await ok(admin, 'historical/samples?session=42&driver=all&' + time))[0].driver_number, 1);
  assert.equal((await admin.call('historical/samples?session=42&driver=all&' + time.replace('08:01:30', '08:03:00'))).status, 400);
  assert.equal((await ok(admin, 'live/samples?driver=1')).samples.length, 80);
  const cfg = await ok(admin, 'admin/config');
  const saved = await ok(admin, 'admin/config', { action: 'save', revision: cfg.revision, draft: { ...cfg.draft, live: 'openf1' } });
  await confirm(admin, { action: 'apply', revision: saved.revision });
  assert.equal((await ok(admin, 'live/info')).session.session_key, 99);
  assert.equal((await ok(admin, 'live/samples?driver=1')).samples[0].speed, 300);
});

test('HTTPS reverse-proxy validation and Secure session cookies', async t => {
  const origin = 'https://dashboard.test';
  const app = await instance(t, { mode: 'proxy', publicOrigin: origin });
  const raw = client(app);
  const secure = client(app, origin);
  assert.equal((await raw.call('session')).status, 421);
  assert.equal((await secure.call('session', undefined, { 'X-Forwarded-Proto': 'http' })).status, 403);
  const login = await secure.call('login', { username: 'Administrator', password: initial });
  assert.equal(login.status, 200);
  assert.match(login.headers.get('set-cookie'), /; Secure/);
  assert.match(login.headers.get('strict-transport-security'), /max-age=/);
  assert.equal((await ok(secure, 'session')).secure, true);
});
