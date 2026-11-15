import { digest, HttpError, json, now, parse, password, passwordHash, secret, username, verify } from './storage.mjs';

const sessionLifetime = 12 * 60 * 60 * 1000;
const sameSite = '; HttpOnly; SameSite=Strict; Path=/';
const accountFields = 'id,username,display,role,change_required,disabled,created,updated,prefs';

export function accounts(store) {
  const { all, get, run, audit, tx } = store;
  const byId = id => get('SELECT ' + accountFields + ' FROM users WHERE id=?', id);
  const view = user => ({ ...user, prefs: parse(user.prefs) });

  function newSession(userId, secure, response) {
    const token = secret();
    run('DELETE FROM sessions WHERE expires<=?', Date.now());
    run('INSERT INTO sessions VALUES(?,?,?)', digest(token), userId, Date.now() + sessionLifetime);
    response.setHeader('Set-Cookie', 'adam_session=' + token + sameSite + (secure ? '; Secure' : ''));
  }

  function context(request) {
    const match = /(?:^|;\s*)adam_session=([a-f0-9]{64})(?:;|$)/.exec(request.headers.cookie ?? '');
    if (!match) return null;
    const session = digest(match[1]);
    const row = get('SELECT user_id FROM sessions WHERE id=? AND expires>?', session, Date.now());
    const user = row && byId(row.user_id);
    return user && !user.disabled ? { session, user: view(user) } : null;
  }

  async function login(body, response, secure) {
    const name = username(body.username);
    const pass = password(body.password);
    const record = get('SELECT id,hash FROM users WHERE username=? COLLATE NOCASE AND disabled=0', name);
    const valid = await verify(pass, record?.hash);
    if (!record || !valid) throw new HttpError(401, 'Invalid username or password.');
    const user = tx(() => {
      const current = get('SELECT hash,disabled FROM users WHERE id=?', record.id);
      if (!current || current.disabled || current.hash !== record.hash) throw new HttpError(401, 'Sign in again.');
      newSession(record.id, secure, response);
      return view(byId(record.id));
    });
    return user;
  }

  function logout(session, response, secure) {
    run('DELETE FROM sessions WHERE id=?', session);
    response.setHeader('Set-Cookie', 'adam_session=' + sameSite + '; Max-Age=0' + (secure ? '; Secure' : ''));
  }

  async function changePassword(user, body, response, secure, assertCurrent) {
    const oldPassword = password(body.current);
    const nextPassword = password(body.password);
    if (oldPassword === nextPassword) throw new HttpError(400, 'Choose a different password.');
    const old = get('SELECT hash FROM users WHERE id=?', user.id);
    if (!old || !await verify(oldPassword, old.hash)) throw new HttpError(403, 'The current password is incorrect.');
    const hash = await passwordHash(nextPassword);
    return tx(() => {
      if (assertCurrent().user.id !== user.id) throw new HttpError(403, 'Sign in again.');
      const updated = run('UPDATE users SET hash=?,change_required=0,updated=? WHERE id=? AND hash=? AND disabled=0',
        hash, now(), user.id, old.hash);
      if (!updated.changes) throw new HttpError(409, 'Account changed. Sign in again.');
      run('DELETE FROM sessions WHERE user_id=?', user.id);
      newSession(user.id, secure, response);
      audit(user.username, 'account.password-change');
      return view(byId(user.id));
    });
  }

  function preferences(user, body) {
    const { theme, units, playbackSpeed, chatSound } = body;
    if (!['dark', 'light', 'system'].includes(theme) || !['kmh', 'mph'].includes(units) ||
        ![0.5, 1, 2, 4].includes(playbackSpeed) || typeof chatSound !== 'boolean') {
      throw new HttpError(400, 'Invalid preferences.');
    }
    run('UPDATE users SET prefs=?,updated=? WHERE id=?', json({ theme, units, playbackSpeed, chatSound }), now(), user.id);
    return view(byId(user.id));
  }

  function normalized(body, current) {
    const name = username(body.username ?? current?.username);
    const display = body.display ?? current?.display ?? name;
    const role = body.role ?? current?.role ?? 'member';
    const disabled = body.disabled ?? Boolean(current?.disabled);
    if (typeof display !== 'string' || !display.trim() || display.length > 64 ||
        !['member', 'admin'].includes(role) || typeof disabled !== 'boolean') {
      throw new HttpError(400, 'Check display name, role and account status.');
    }
    return { name, display: display.trim(), role, disabled: Number(disabled) };
  }

  async function manage(actor, operation, body, id, assertAdmin) {
    const current = id ? byId(id) : null;
    if (operation !== 'create' && !current) throw new HttpError(404, 'Account not found.');
    if (operation === 'delete') {
      return tx(() => {
        assertAdmin();
        if (id === actor.id) throw new HttpError(400, 'You cannot delete your own account.');
        run('DELETE FROM messages WHERE sender=? OR recipient=?', id, id);
        run('DELETE FROM users WHERE id=?', id);
        audit(actor.username, 'account.delete', { id, username: current.username });
        return { deleted: id };
      });
    }
    const data = normalized(body, current);
    if (id === actor.id && (data.disabled || data.role !== 'admin' || body.password !== undefined)) {
      throw new HttpError(400, 'Use your account settings to change your password. Your own admin access must remain enabled.');
    }
    const hash = operation === 'create' || body.password !== undefined ? await passwordHash(password(body.password)) : null;
    return tx(() => {
      assertAdmin();
      const collision = get('SELECT id FROM users WHERE username=? COLLATE NOCASE', data.name);
      if (collision && collision.id !== id) throw new HttpError(409, 'This username already exists.');
      if (operation === 'create') {
        const result = run('INSERT INTO users(username,display,role,hash,change_required,disabled,created,updated) VALUES(?,?,?,?,1,?,?,?)',
          data.name, data.display, data.role, hash, data.disabled, now(), now());
        id = Number(result.lastInsertRowid);
      } else {
        const latest = byId(id);
        if (!latest || latest.updated !== current.updated) throw new HttpError(409, 'The account changed. Reload and retry.');
        run('UPDATE users SET username=?,display=?,role=?,disabled=?,updated=? WHERE id=?',
          data.name, data.display, data.role, data.disabled, now(), id);
        if (hash) run('UPDATE users SET hash=?,change_required=1 WHERE id=?', hash, id);
        if (hash || current.role !== data.role || data.disabled) run('DELETE FROM sessions WHERE user_id=?', id);
      }
      audit(actor.username, 'account.' + operation,
        { id, username: data.name, role: data.role, disabled: Boolean(data.disabled), resetPassword: Boolean(hash) });
      return view(byId(id));
    });
  }

  const list = () => all('SELECT ' + accountFields + ' FROM users ORDER BY username').map(view);
  return { context, login, logout, changePassword, preferences, manage, list };
}
