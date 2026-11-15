import { HttpError, json, now, parse, secret } from './storage.mjs';

export const factory = Object.freeze({
  title: 'Arif WebDashboard',
  historical: true,
  live: 'mock',
  chat: true,
  maxFileMiB: 8,
  testSeconds: 15,
  historicalTransport: 'inherit',
  liveTransport: 'inherit',
  chatTransport: 'inherit'
});

const choice = (value, options) => options.includes(value);
const within = (value, from, to) => Number.isInteger(value) && value >= from && value <= to;

function validate(data, providerReady) {
  if (!data || typeof data !== 'object' || Array.isArray(data) ||
      Object.keys(data).length !== Object.keys(factory).length ||
      typeof data.title !== 'string' || !data.title.trim() || data.title.length > 64 ||
      typeof data.historical !== 'boolean' || typeof data.chat !== 'boolean' ||
      !choice(data.live, ['mock', 'openf1', 'off']) ||
      !within(data.maxFileMiB, 1, 16) || !within(data.testSeconds, 1, 120)) {
    throw new HttpError(400, 'Check the title, modes, attachment limit (1–16 MiB) and TEST duration (1–120 seconds).');
  }
  for (const key of ['historicalTransport', 'liveTransport', 'chatTransport']) {
    if (!choice(data[key], ['inherit', 'https'])) throw new HttpError(400, 'Choose either inherited transport or HTTPS required.');
  }
  if (data.live === 'openf1' && !providerReady) {
    throw new HttpError(400, 'Configure the OpenF1 account on the server before enabling the provider.');
  }
  return Object.fromEntries(Object.keys(factory).map(key => [key, key === 'title' ? data[key].trim() : data[key]]));
}

export function configuration(store, providerReady) {
  const { all, get, run, tx, audit } = store;
  tx(() => {
    if (get('SELECT id FROM config')) return;
    const body = json(factory);
    const initial = run('INSERT INTO versions(body,at,author) VALUES(?,?,?)', body, now(), 'System');
    run('INSERT INTO config VALUES(1,?,1,?,?)', initial.lastInsertRowid, body, body);
  });
  const state = () => get('SELECT c.*, v.body AS current, v.parent FROM config c JOIN versions v ON c.active=v.id');
  const preview = session => get('SELECT body,expires FROM previews WHERE session=? AND expires>?', session, Date.now());
  const confirmations = new Map();

  function effective(session) {
    const test = preview(session);
    return { config: parse(test?.body ?? state().current), previewUntil: test?.expires ?? null };
  }

  function inspect(session) {
    const row = state();
    return {
      ...effective(session), draft: parse(row.draft), defaults: parse(row.defaults),
      revision: row.revision, active: row.active, parent: row.parent, providerReady,
      versions: all('SELECT id,parent,at,author FROM versions ORDER BY id DESC LIMIT 50'),
      profiles: all('SELECT name,at,author FROM profiles ORDER BY name')
    };
  }

  function confirm(op, session, body, revision) {
    const time = Date.now();
    for (const [key, pending] of confirmations) {
      if (pending.until <= time) confirmations.delete(key);
    }
    if (body.step === 'start') {
      const pending = { token: secret(), op, revision, step: 1, until: time + 60000 };
      confirmations.set(session, pending);
      return { confirmation: pending.token, step: 1 };
    }
    const pending = confirmations.get(session);
    if (!pending || pending.op !== op || pending.token !== body.token ||
        pending.revision !== revision || pending.step !== body.step) {
      throw new HttpError(409, 'The confirmation expired or the draft changed. Start again.');
    }
    if (pending.step === 1) {
      pending.step = 2;
      return { confirmation: pending.token, step: 2 };
    }
    confirmations.delete(session);
    return null;
  }

  function execute(op, body, context) {
    const { session, user } = context;
    const actor = user.username;
    return tx(() => {
      const row = state();
      if (op === 'stop') {
        run('DELETE FROM previews WHERE session=?', session);
        audit(actor, 'config.stop');
        return inspect(session);
      }
      if (body.revision !== row.revision) throw new HttpError(409, 'Configuration changed. Reload the draft and retry.');
      const changeDraft = data => run('UPDATE config SET draft=?,revision=revision+1 WHERE id=1', data);
      const changeActive = (id, data) => {
        run('UPDATE config SET active=?,draft=?,revision=revision+1 WHERE id=1', id, data);
        run('DELETE FROM previews');
      };
      const detail = {};
      switch (op) {
        case 'save':
          changeDraft(json(validate(body.draft, providerReady)));
          break;
        case 'test': {
          const draft = validate(parse(row.draft), providerReady);
          const expires = Date.now() + draft.testSeconds * 1000;
          run('DELETE FROM previews WHERE expires<=?', Date.now());
          run('INSERT INTO previews VALUES(?,?,?) ON CONFLICT(session) DO UPDATE SET body=excluded.body,expires=excluded.expires',
            session, json(draft), expires);
          detail.expires = new Date(expires).toISOString();
          break;
        }
        case 'apply':
        case 'reset': {
          const next = confirm(op, session, body, row.revision);
          if (next) return next;
          if (op === 'reset') {
            changeDraft(row.defaults);
            break;
          }
          validate(parse(row.draft), providerReady);
          const version = run('INSERT INTO versions(parent,body,at,author) VALUES(?,?,?,?)', row.active, row.draft, now(), actor);
          changeActive(version.lastInsertRowid, row.draft);
          detail.version = Number(version.lastInsertRowid);
          break;
        }
        case 'revert':
          changeDraft(row.current);
          run('DELETE FROM previews WHERE session=?', session);
          break;
        case 'rewind': {
          if (!row.parent) throw new HttpError(409, 'There is no earlier active version.');
          const parent = get('SELECT body FROM versions WHERE id=?', row.parent);
          validate(parse(parent.body), providerReady);
          changeActive(row.parent, parent.body);
          detail.version = row.parent;
          break;
        }
        case 'override-default':
          run('UPDATE config SET defaults=draft,revision=revision+1 WHERE id=1');
          break;
        case 'create-profile':
        case 'load-profile': {
          if (typeof body.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.test(body.name)) {
            throw new HttpError(400, 'Use 1–32 letters, digits, underscores or hyphens for the profile name.');
          }
          const existing = get('SELECT body FROM profiles WHERE name=?', body.name);
          if (op === 'create-profile') {
            if (existing) throw new HttpError(409, 'A profile with that name already exists.');
            run('INSERT INTO profiles VALUES(?,?,?,?)', body.name, row.draft, now(), actor);
          } else {
            if (!existing) throw new HttpError(404, 'Profile not found.');
            changeDraft(existing.body);
          }
          detail.name = body.name;
          break;
        }
        default:
          throw new HttpError(404, 'Unknown configuration action.');
      }
      audit(actor, 'config.' + op, detail);
      return inspect(session);
    });
  }

  return { effective, inspect, execute };
}
