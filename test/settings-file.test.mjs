import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { configuration } from '../config.mjs';
import { environment } from '../server.mjs';
import { readSettings } from '../settings-file.mjs';
import { openStore } from '../storage.mjs';

async function scratch(t) {
  const directory = await mkdtemp(join(tmpdir(), 'arif-settings-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('TOML options use file-relative paths and allow environment overrides', async t => {
  const directory = await scratch(t);
  const path = join(directory, 'custom.toml');
  await writeFile(path, [
    '[server]', 'port = 8_700', "data_directory = 'database #1' # comment",
    '[lan]', "address = '127.0.0.1'", 'port = 8770', 'backend_port = 8771',
    '[dashboard]', 'title = "Garage #2"', 'max_file_mib = 4', 'historical = false', "live = 'openf1'",
    '[openf1]', "username_env = 'TEST_USER'", "password_env = 'TEST_PASSWORD'"
  ].join('\r\n'));
  const env = { ADAM_CONFIG: path, ADAM_PORT: '8769', TEST_USER: 'fixture', TEST_PASSWORD: 'fixture' };
  const settings = readSettings(env);
  assert.deepEqual(settings.lan, { address: '127.0.0.1', port: 8770, backend_port: 8771 });
  const options = environment(env, settings);
  assert.equal(options.directory, join(directory, 'database #1'));
  assert.equal(options.port, 8769);
  assert.equal(environment({ ...env, ADAM_PORT: undefined }, settings).port, 8700);
  assert.deepEqual(options.dashboard, { title: 'Garage #2', maxFileMiB: 4, historical: false, live: 'openf1' });
  assert.throws(() => environment({}, settings), /Configure the OpenF1 account/);
  assert.equal(readSettings({}, directory).lan.port, 8765);
  await writeFile(path, '[server]\nport = 123\nport = 456');
  assert.throws(() => readSettings(env), /:3: Duplicate setting server.port/);
  await writeFile(path, '[lan]\nport = 8766');
  assert.throws(() => readSettings(env), /different LAN and backend ports/);
  assert.throws(() => readSettings({ ADAM_CONFIG: join(directory, 'missing.toml') }), /Cannot read configuration file/);
});

test('TOML edits create versions and unchanged values preserve later admin edits', async t => {
  const directory = await scratch(t);
  const store = openStore(directory);
  try {
    const context = { session: 'admin-fixture', user: { username: 'Fixture Admin' } };
    const file = { title: 'File title', chat: false };
    const first = configuration(store, false, file);
    const initial = first.inspect(context.session);
    assert.equal(initial.config.title, 'File title');
    assert.equal(initial.config.chat, false);
    assert.equal(initial.versions[0].author, 'Configuration file');

    const saved = first.execute('save', {
      draft: { ...initial.draft, title: 'Console title', testSeconds: 25 }, revision: initial.revision
    }, context);
    const { revision } = saved;
    const one = first.execute('apply', { revision, step: 'start' }, context);
    first.execute('apply', { revision, step: 1, token: one.confirmation }, context);
    const adminVersion = first.execute('apply', { revision, step: 2, token: one.confirmation }, context);

    const same = configuration(store, false, file).inspect(context.session);
    assert.equal(same.active, adminVersion.active);
    assert.equal(same.config.title, 'Console title');
    const edit = configuration(store, false, { ...file, chat: true }).inspect(context.session);
    assert.equal(edit.parent, adminVersion.active);
    assert.equal(edit.config.title, 'Console title');
    assert.equal(edit.config.chat, true);
    assert.equal(edit.config.testSeconds, 25);
    const removed = configuration(store, false, {}).inspect(context.session);
    assert.equal(removed.active, edit.active);
    const restored = configuration(store, false, file).inspect(context.session);
    assert.equal(restored.config.title, 'File title');
    assert.equal(restored.config.chat, false);
  } finally {
    store.db.close();
  }
});
