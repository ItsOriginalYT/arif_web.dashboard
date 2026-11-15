import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const derive = promisify(scrypt);
const work = { N: 65536, r: 8, p: 1, maxmem: 96 * 1024 * 1024 };
const fake = '0'.repeat(32) + ':' + '0'.repeat(128);

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const now = () => new Date().toISOString();
export const digest = text => createHash('sha256').update(text).digest('hex');
export const secret = () => randomBytes(32).toString('hex');
export const json = JSON.stringify;
export const parse = JSON.parse;

export function username(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{2,31}$/.test(value)) {
    throw new HttpError(400, 'Use 3–32 letters, digits, dots, underscores or hyphens for the username.');
  }
  return value;
}

export function password(value, min = 12) {
  if (typeof value !== 'string' || value.length < min || Buffer.byteLength(value) > 256 || !value.trim()) {
    throw new HttpError(400, 'Use at least ' + min + ' characters and at most 256 bytes for the password.');
  }
  return value;
}

let passwordJobs = 0;
async function hashWork(value, salt) {
  if (passwordJobs >= 2) throw new HttpError(429, 'Password checks are busy. Try again shortly.');
  passwordJobs += 1;
  try {
    return await derive(value, Buffer.from(salt, 'hex'), 64, work);
  } finally {
    passwordJobs -= 1;
  }
}

export async function passwordHash(value) {
  const salt = randomBytes(16).toString('hex');
  return salt + ':' + (await hashWork(value, salt)).toString('hex');
}

export async function verify(value, stored = fake) {
  const [salt, key] = stored.split(':');
  return timingSafeEqual(await hashWork(value, salt), Buffer.from(key, 'hex'));
}

export function openStore(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(directory, 'dashboard.sqlite'));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000');
  db.exec(
    'CREATE TABLE IF NOT EXISTS users (' +
      'id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT COLLATE NOCASE UNIQUE NOT NULL,' +
      'display TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN (\'admin\', \'member\')),' +
      'hash TEXT NOT NULL, change_required INTEGER NOT NULL, disabled INTEGER NOT NULL DEFAULT 0,' +
      'created TEXT NOT NULL, updated TEXT NOT NULL, prefs TEXT NOT NULL DEFAULT \'{}\');' +
    'CREATE TABLE IF NOT EXISTS sessions (' +
      'id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users ON DELETE CASCADE, expires INTEGER NOT NULL);' +
    'CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);' +
    'CREATE TABLE IF NOT EXISTS messages (' +
      'id INTEGER PRIMARY KEY AUTOINCREMENT, sender INTEGER NOT NULL, recipient INTEGER NOT NULL, sent TEXT NOT NULL,' +
      'body TEXT NOT NULL, filename TEXT, attachment BLOB);' +
    'CREATE INDEX IF NOT EXISTS message_pair ON messages(sender,recipient,id);' +
    'CREATE TABLE IF NOT EXISTS audit (' +
      'id INTEGER PRIMARY KEY, at TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL);' +
    'CREATE TABLE IF NOT EXISTS versions (' +
      'id INTEGER PRIMARY KEY, parent INTEGER REFERENCES versions, body TEXT NOT NULL,' +
      'at TEXT NOT NULL, author TEXT NOT NULL);' +
    'CREATE TABLE IF NOT EXISTS config (' +
      'id INTEGER PRIMARY KEY CHECK(id=1), active INTEGER NOT NULL REFERENCES versions,' +
      'revision INTEGER NOT NULL, draft TEXT NOT NULL, defaults TEXT NOT NULL);' +
    'CREATE TABLE IF NOT EXISTS profiles (' +
      'name TEXT COLLATE NOCASE PRIMARY KEY, body TEXT NOT NULL, at TEXT NOT NULL, author TEXT NOT NULL);' +
    'CREATE TABLE IF NOT EXISTS previews (' +
      'session TEXT PRIMARY KEY REFERENCES sessions ON DELETE CASCADE, body TEXT NOT NULL, expires INTEGER NOT NULL);'
  );
  const get = (sql, ...args) => db.prepare(sql).get(...args);
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  function tx(operation) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  const audit = (actor, action, detail = {}) =>
    run('INSERT INTO audit(at,actor,action,detail) VALUES(?,?,?,?)', now(), actor, action, json(detail));
  return { db, get, all, run, tx, audit };
}

export async function bootstrap(store, initial) {
  const hash = await passwordHash(password(initial, 8));
  store.tx(() => {
    if (store.get('SELECT id FROM users LIMIT 1')) throw new HttpError(409, 'Accounts already exist.');
    store.run('INSERT INTO users(username,display,role,hash,change_required,created,updated) VALUES(?,?,?,?,1,?,?)',
      'Administrator', 'Administrator', 'admin', hash, now(), now());
    store.audit('Administrator', 'account.bootstrap');
  });
}
