import { HttpError } from './storage.mjs';
import { setTimeout as delay } from 'node:timers/promises';

const origin = 'https://api.openf1.org';
const minute = 60_000;
const maxResponseBytes = 4 * 1024 * 1024;

export function integer(value, min, max, label) {
  const number = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new HttpError(400, 'Invalid ' + label + '.');
  }
  return number;
}

function timestamp(value) {
  const time = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) ? Date.parse(value) : NaN;
  if (!Number.isFinite(time)) throw new HttpError(400, 'Choose a valid lap or start time.');
  return time;
}

function fields(row, names) {
  return Object.fromEntries(names.map(name => [name, row[name] ?? null]));
}

const carFields = ['date', 'driver_number', 'speed', 'throttle', 'brake', 'n_gear', 'rpm', 'drs'];
const driverFields = ['driver_number', 'full_name', 'name_acronym', 'team_name', 'team_colour'];
const sessionFields = ['session_key', 'session_name', 'location', 'country_name', 'date_start', 'date_end'];
const lapFields = ['driver_number', 'lap_number', 'date_start', 'lap_duration', 'is_pit_out_lap'];

function quota(perSecond, perMinute) {
  let history = [];
  return async function take() {
    const time = Date.now();
    history = history.filter(last => last > time - minute);
    const readyAt = Math.max(time, history.at(-1) ?? 0, (history.at(-perSecond) ?? 0) + 1010);
    if (history.length >= perMinute || readyAt - time > 2500) {
      throw new HttpError(503, 'Telemetry request limit reached. Try again shortly.');
    }
    history.push(readyAt);
    if (readyAt > time) await delay(readyAt - time);
  };
}

async function upstream(fetcher, path, options) {
  let response;
  try {
    response = await fetcher(origin + path, { ...options, redirect: 'error', signal: AbortSignal.timeout(12_000) });
  } catch {
    throw new HttpError(502, 'OpenF1 is unreachable. Check server connectivity and try again.');
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    const status = response.status;
    if (status === 404) return [];
    if (status === 429) throw new HttpError(503, 'OpenF1 is rate limiting requests. Try again in a minute.');
    if (status === 401 || status === 403) throw new HttpError(502, 'OpenF1 denied access. Check credentials, subscription and session availability.');
    throw new HttpError(502, 'OpenF1 returned an error (' + status + ').');
  }
  try {
    let size = 0;
    const chunks = [];
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > maxResponseBytes) throw new Error('Response too large');
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(502, 'OpenF1 returned an unreadable response.');
  }
}

export function telemetry({ account, fetcher = fetch }) {
  const freeQuota = quota(3, 30);
  const liveQuota = quota(6, 60);
  const cache = new Map();
  let token;
  let tokenUntil = 0;
  let tokenRequest;

  function accessToken() {
    if (token && Date.now() < tokenUntil) return Promise.resolve(token);
    if (!tokenRequest) {
      tokenRequest = Promise.resolve().then(async () => {
        await liveQuota();
        return upstream(fetcher, '/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams(account)
        });
      }).then(data => {
        if (typeof data.access_token !== 'string' || !data.access_token) {
          throw new HttpError(502, 'OpenF1 did not issue a usable token.');
        }
        token = data.access_token;
        const ttl = Number(data.expires_in) || 3600;
        tokenUntil = Date.now() + Math.max(1, Math.min(ttl - 30, 3300)) * 1000;
        return token;
      }).finally(() => { tokenRequest = undefined; });
    }
    return tokenRequest;
  }

  async function load(path, live, ttl, key = path) {
    const id = (live ? 'live:' : 'free:') + key;
    const current = cache.get(id);
    if (current && current.until > Date.now()) return current.value;
    const entry = { until: Date.now() + Math.max(ttl, 15_000) };
    entry.value = Promise.resolve().then(async () => {
      const headers = { Accept: 'application/json' };
      if (live) {
        if (!account) throw new HttpError(503, 'The OpenF1 account is missing on the server.');
        headers.Authorization = 'Bearer ' + await accessToken();
      }
      await (live ? liveQuota : freeQuota)();
      const rows = await upstream(fetcher, '/v1/' + path, { headers });
      if (!Array.isArray(rows) || rows.some(row => !row || typeof row !== 'object')) {
        throw new HttpError(502, 'Unexpected OpenF1 response format.');
      }
      entry.until = Date.now() + ttl;
      return rows;
    }).catch(error => {
      if (cache.get(id) === entry) cache.delete(id);
      throw error;
    });
    if (cache.size >= 64) cache.delete(cache.keys().next().value);
    cache.set(id, entry);
    return entry.value;
  }

  function carPath(session, driver, start, end) {
    const format = time => encodeURIComponent(new Date(time).toISOString().slice(0, -1));
    return 'car_data?session_key=' + session + (driver === 'all' ? '' : '&driver_number=' + driver) +
      '&date>' + format(start) + '&date<' + format(end);
  }

  function samples(rows) {
    return rows.filter(row => Number.isFinite(Date.parse(row.date)) && Number.isFinite(row.speed))
      .map(row => fields(row, carFields)).sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
  }

  async function historical(action, query) {
    const maxYear = new Date().getUTCFullYear();
    if (action === 'sessions') {
      const year = integer(query.get('year'), 2023, maxYear, 'season');
      const rows = await load('sessions?year=' + year, false, 300_000);
      return rows.filter(row => Date.parse(row.date_end) < Date.now() - 30 * minute)
        .map(row => fields(row, sessionFields)).reverse();
    }
    const session = integer(query.get('session'), 1, 999999, 'session');
    if (action === 'drivers') {
      const rows = await load('drivers?session_key=' + session, false, 300_000);
      return rows.map(row => fields(row, driverFields));
    }
    const driver = query.get('driver') === 'all' ? 'all' : integer(query.get('driver'), 1, 999, 'driver');
    if (action === 'laps') {
      const rows = await load('laps?session_key=' + session +
        (driver === 'all' ? '' : '&driver_number=' + driver), false, 300_000);
      return rows.map(row => fields(row, lapFields)).sort((a, b) => a.lap_number - b.lap_number);
    }
    if (action === 'samples') {
      const start = timestamp(query.get('start'));
      const end = timestamp(query.get('end'));
      const maxWindow = driver === 'all' ? 120_000 : 300_000;
      if (end <= start || end - start > maxWindow || end > Date.now() - 30 * minute) {
        throw new HttpError(400, 'Choose a historical window of up to ' + maxWindow / minute + ' minutes.');
      }
      return samples(await load(carPath(session, driver, start, end), false, 600_000));
    }
    throw new HttpError(404, 'Unknown historical endpoint.');
  }

  async function live(mode, action, query) {
    if (mode === 'mock') {
      const drivers = [
        { driver_number: 1, name_acronym: 'SIM', full_name: 'Simulation Driver 1', team_name: 'Test Garage' },
        { driver_number: 2, name_acronym: 'DEV', full_name: 'Simulation Driver 2', team_name: 'Test Garage' }
      ];
      if (action === 'info') return { mode, drivers, session: { session_name: 'Telemetry simulation' } };
      const driver = integer(query.get('driver'), 1, 2, 'simulation driver');
      const end = Math.floor(Date.now() / 250) * 250;
      return { mode, samples: Array.from({ length: 80 }, (_, index) => {
        const time = end - (79 - index) * 250;
        const phase = time / 2800 + driver;
        const speed = Math.round(236 + 54 * Math.sin(phase) + 23 * Math.sin(phase * 2.1));
        return {
          date: new Date(time).toISOString(), speed, throttle: Math.round(50 + 50 * Math.sin(phase + 0.8)),
          brake: Math.cos(phase) < -0.65 ? 100 : 0, n_gear: Math.min(8, Math.round(speed / 40)),
          rpm: 7900 + (speed % 40) * 100, drs: speed > 270 ? 12 : 0
        };
      }) };
    }
    const rows = await load('sessions?session_key=latest', true, 30_000);
    const latest = rows.at(-1);
    const start = Date.parse(latest?.date_start);
    const end = Date.parse(latest?.date_end);
    const current = Date.now();
    const inWindow = Number.isFinite(start) && Number.isFinite(end) && current >= start - 30 * minute &&
      current <= end + 30 * minute;
    if (!inWindow) return { mode, session: null, drivers: [], samples: [] };
    const session = integer(latest.session_key, 1, 999999, 'session');
    if (action === 'info') {
      const drivers = await load('drivers?session_key=' + session, true, 60_000);
      return { mode, session: fields(latest, sessionFields), drivers: drivers.map(row => fields(row, driverFields)) };
    }
    const driver = integer(query.get('driver'), 1, 999, 'driver');
    const values = samples(await load(carPath(session, driver, current - 30_000, current), true, 5000, session + ':' + driver));
    return { mode, samples: values.filter(row => Date.parse(row.date) >= Date.now() - 35_000) };
  }

  return { historical, live };
}
