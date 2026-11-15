import { button, el, field, labelError, line, option, panel, preferences, query, request, select, serviceProblem, tag, task, title } from './ui.js';

function svg(name, attributes, content) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', name);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  if (content != null) node.textContent = content;
  return node;
}

function instrument(units, live) {
  const mph = units === 'mph';
  const speed = value => Math.round(value * (mph ? 0.621371 : 1));
  const labels = [['Speed', mph ? 'mph' : 'km/h'], ['Throttle', '%'], ['Gear', 'selected'], ['Engine', 'rpm']];
  const values = labels.map(() => el('strong', {}, '—'));
  const metrics = el('div', { className: 'metrics' }, labels.map(([label, unit], index) =>
    el('div', { className: 'panel metric' }, el('small', {}, label), values[index], el('span', {}, unit))));
  const graph = svg('svg', { class: 'graph', viewBox: '0 0 800 280', preserveAspectRatio: 'none',
    role: 'img', 'aria-label': 'Speed over elapsed time' });
  const label = el('small', { className: 'mono' }, 'Waiting for samples');
  const chart = panel(el('div', { className: 'row spread' }, el('h2', {}, 'Speed trace'), label), graph);
  let cursor;
  function draw(samples) {
    const first = Date.parse(samples[0]?.date);
    const span = Math.max(1, Date.parse(samples.at(-1)?.date) - first);
    const x = sample => 55 + 720 * (Date.parse(sample.date) - first) / span;
    const max = Math.max(360, ...samples.map(sample => sample.speed));
    const y = sample => 241 - 216 * sample.speed / max;
    graph.replaceChildren();
    for (let index = 0; index <= 4; index++) {
      const y = 25 + index * 54;
      graph.append(svg('line', { x1: 55, y1: y, x2: 775, y2: y, class: 'grid' }),
        svg('text', { x: 15, y: y + 4 }, speed(max * (4 - index) / 4)));
      const x = 55 + index * 180;
      graph.append(svg('line', { x1: x, y1: 25, x2: x, y2: 241, class: 'grid' }),
        svg('text', { x, y: 263, 'text-anchor': index === 4 ? 'end' : 'start' },
          samples.length ? (span * index / 4000).toFixed(1) + ' s' : ''));
    }
    cursor = null;
    if (!samples.length) {
      graph.append(svg('text', { x: 415, y: 139, 'text-anchor': 'middle' }, 'No telemetry samples'));
      return;
    }
    const trace = samples.map((sample, index) => (index ? 'L' : 'M') + x(sample).toFixed(1) + ' ' + y(sample).toFixed(1)).join(' ');
    if (samples.length === 1) graph.append(svg('circle', { cx: 55, cy: y(samples[0]), r: 4, class: 'trace' }));
    else graph.append(svg('path', { d: trace + ' L775 241 L55 241 Z', class: 'shade' }), svg('path', { d: trace, class: 'trace' }));
    if (!live) {
      cursor = svg('line', { x1: 55, y1: 25, x2: 55, y2: 241, class: 'cursor' });
      graph.append(cursor);
    }
  }
  const number = value => Number.isFinite(value) ? Number(value).toLocaleString() : '—';
  function mark(sample, ratio = 0) {
    values[0].textContent = number(sample && speed(sample.speed));
    values[1].textContent = number(sample?.throttle);
    values[2].textContent = number(sample?.n_gear);
    values[3].textContent = number(sample?.rpm);
    label.textContent = sample?.date ? new Date(sample.date).toISOString().slice(11, 23) + ' UTC' : 'Waiting for samples';
    if (cursor) {
      cursor.setAttribute('x1', 55 + ratio * 720);
      cursor.setAttribute('x2', 55 + ratio * 720);
    }
  }
  draw([]);
  return { chart, metrics, draw, mark };
}

function driverName(driver) {
  return '#' + driver.driver_number + ' · ' + (driver.full_name || driver.name_acronym || 'Unknown driver') +
    (driver.team_name ? ' · ' + driver.team_name : '');
}

export function historical(parent, state, lifecycle) {
  parent.append(title('Historical telemetry', 'Replay a completed session from the OpenF1 archive.', 'Telemetry / Archive'));
  const disabled = serviceProblem(state, 'historical');
  if (disabled) {
    parent.append(panel(el('p', { className: 'notice' }, disabled)));
    return;
  }
  const pref = preferences(state.user);
  const dash = instrument(pref.units, false);
  const yearNow = new Date().getFullYear();
  const years = Array.from({ length: yearNow - 2022 }, (_, index) => [yearNow - index, yearNow - index]);
  const year = select(years);
  const session = select([]);
  const driver = select([]);
  const lap = select([]);
  const load = button('Load telemetry', loadSamples, 'primary');
  const play = button('Play', () => {
    if (frame) {
      stop();
    } else if (samples.length > 1) {
      if (position >= duration) position = 0;
      previousTick = performance.now();
      play.textContent = 'Pause';
      frame = requestAnimationFrame(tick);
    }
  });
  const speed = select([[0.5, '0.5×'], [1, '1×'], [2, '2×'], [4, '4×']], pref.playbackSpeed, { 'aria-label': 'Playback speed' });
  const seek = el('input', { type: 'range', min: 0, max: 1000, value: 0, className: 'seek', 'aria-label': 'Seek telemetry' });
  const clock = el('small', { className: 'mono' }, '0.0 / 0.0 s');
  const error = labelError();
  const loading = el('small', {});
  parent.append(panel(el('div', { className: 'row spread' }, el('h2', {}, 'Session selection'), tag('OpenF1 archive', 'good')),
    el('div', { className: 'form-grid' }, field('Season', year), field('Session', session), field('Driver', driver), field('Lap', lap)),
    line(load, loading), error),
  el('div', { className: 'stack' }, dash.metrics, dash.chart,
    panel(line(play, seek, clock, speed))));
  let samples = [];
  let times = [];
  let laps = [];
  let sessions = [];
  let duration = 0;
  let position = 0;
  let previousTick = 0;
  let frame = 0;
  let revision = 0;
  let busy = false;
  function stop() {
    cancelAnimationFrame(frame);
    frame = 0;
    play.textContent = 'Play';
  }
  function render() {
    let low = 0;
    let high = times.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (times[middle] <= position) low = middle + 1;
      else high = middle;
    }
    const index = Math.max(0, low - 1);
    dash.mark(samples[index], duration ? (times[index] ?? 0) / duration : 0);
    seek.value = duration ? String(Math.round(position / duration * 1000)) : '0';
    clock.textContent = (position / 1000).toFixed(1) + ' / ' + (duration / 1000).toFixed(1) + ' s';
  }
  function tick(now) {
    position = Math.min(duration, position + (now - previousTick) * Number(speed.value));
    previousTick = now;
    render();
    if (position >= duration || !lifecycle.active()) stop();
    else frame = requestAnimationFrame(tick);
  }
  function reset(next = []) {
    stop();
    samples = next;
    times = next.map(row => Date.parse(row.date) - Date.parse(next[0].date));
    duration = times.at(-1) ?? 0;
    position = 0;
    dash.draw(samples);
    seek.disabled = play.disabled = !(samples.length > 1);
    render();
  }
  function update() {
    load.disabled = busy || !session.value || !driver.value || !lap.value;
  }
  seek.oninput = () => { position = duration * Number(seek.value) / 1000; render(); };
  async function fetchSelection(level) {
    const run = ++revision;
    const fresh = () => lifecycle.active() && run === revision;
    error.textContent = '';
    busy = true;
    loading.textContent = 'Loading archive…';
    reset();
    if (level <= 0) session.replaceChildren();
    if (level <= 1) driver.replaceChildren();
    lap.replaceChildren();
    update();
    try {
      if (level <= 0) {
        const rows = await query('historical/sessions', { year: year.value });
        if (!fresh()) return;
        sessions = rows;
        session.append(...rows.map(row => option(row.session_key, (row.date_start ?? '').slice(0, 10) + ' · ' +
          (row.location || row.country_name || 'Circuit') + ' · ' + row.session_name)));
      }
      if (level <= 1 && session.value) {
        const rows = await query('historical/drivers', { session: session.value });
        if (!fresh()) return;
        driver.append(...rows.map(row => option(row.driver_number, driverName(row))));
      }
      if (session.value && driver.value) {
        const rows = await query('historical/laps', { session: session.value, driver: driver.value });
        if (!fresh()) return;
        laps = rows.filter(row => Number.isFinite(Date.parse(row.date_start)) && row.lap_duration > 0 && row.lap_duration <= 300);
        lap.append(...laps.map((row, index) => option(index, 'Lap ' + row.lap_number + ' · ' + row.lap_duration.toFixed(3) + ' s')));
        if (!laps.length) {
          const selected = sessions.find(row => String(row.session_key) === session.value);
          if (Number.isFinite(Date.parse(selected?.date_start))) {
            laps = [{ date_start: selected.date_start, lap_duration: 120 }];
            lap.append(option(0, 'Opening two-minute window'));
          }
        }
      }
      loading.textContent = lap.value ? '' : 'No session, driver or lap data available.';
    } catch (failure) {
      if (fresh()) {
        error.textContent = failure.message;
        loading.replaceChildren(button('Retry archive', () => fetchSelection(level)));
      }
    } finally {
      if (fresh()) { busy = false; update(); }
    }
  }
  async function loadSamples() {
    const selected = laps[Number(lap.value)];
    if (!selected) return;
    const run = ++revision;
    busy = true;
    update();
    reset();
    error.textContent = '';
    loading.textContent = 'Loading telemetry…';
    try {
      const from = new Date(selected.date_start);
      const until = new Date(+from + selected.lap_duration * 1000);
      const rows = await query('historical/samples', {
        session: session.value, driver: driver.value, start: from.toISOString(), end: until.toISOString()
      });
      if (!lifecycle.active() || run !== revision) return;
      reset(rows);
      loading.textContent = rows.length ? rows.length + ' samples loaded' : 'OpenF1 returned no samples for this window.';
    } catch (failure) {
      if (lifecycle.active() && run === revision) {
        error.textContent = failure.message;
        loading.textContent = '';
      }
    } finally {
      if (lifecycle.active() && run === revision) { busy = false; update(); }
    }
  }
  year.onchange = () => fetchSelection(0);
  session.onchange = () => fetchSelection(1);
  driver.onchange = () => fetchSelection(2);
  lap.onchange = () => reset();
  lifecycle.cleanup(stop);
  fetchSelection(0);
}

export function live(parent, state, lifecycle) {
  parent.append(title('Live telemetry', 'Follow one driver’s current speed, throttle, gear and engine speed.', 'Telemetry / Live'));
  const disabled = serviceProblem(state, 'live');
  if (disabled) {
    parent.append(panel(el('p', { className: 'notice' }, disabled)));
    return;
  }
  const mock = state.config.live === 'mock';
  const dash = instrument(preferences(state.user).units, true);
  const driver = select([]);
  const mode = tag(mock ? 'SIMULATION' : 'WAITING', mock ? 'sim' : '');
  const sessionName = el('h2', {}, 'Connecting…');
  const comment = el('small', {}, mock ? 'Synthetic test data' : 'OpenF1 · Updates every 5 seconds');
  const error = labelError();
  parent.append(panel(el('div', { className: 'row spread' }, sessionName, mode),
    el('div', { className: 'form-grid' }, field('Driver', driver)), comment, error),
  el('div', { className: 'stack' }, dash.metrics, dash.chart));
  let session = '';
  let lastInfo = 0;
  let timeout;
  let running = false;
  let refresh = false;
  let failed = false;
  async function poll() {
    if (running) {
      refresh = true;
      return;
    }
    clearTimeout(timeout);
    running = true;
    try {
      if (Date.now() - lastInfo >= (mock ? 120_000 : 30_000)) {
        const info = await request('live/info');
        if (!lifecycle.active()) return;
        lastInfo = Date.now();
        const id = info.session?.session_key ?? info.session?.session_name ?? '';
        if (id !== session) {
          session = id;
          const choice = driver.value;
          driver.replaceChildren(...info.drivers.map(row => option(row.driver_number, driverName(row))));
          if ([...driver.options].some(item => item.value === choice)) driver.value = choice;
        }
        sessionName.textContent = info.session?.session_name || 'Waiting for a session';
      }
      const chosen = driver.value;
      const result = chosen ? await query('live/samples', { driver: chosen }) : { samples: [] };
      if (!lifecycle.active() || chosen !== driver.value) return;
      const rows = result.samples;
      dash.draw(rows);
      dash.mark(rows.at(-1));
      if (!mock) {
        mode.textContent = rows.length ? 'LIVE DATA' : 'WAITING';
        mode.className = 'tag' + (rows.length ? ' good' : '');
        comment.textContent = rows.length ? 'OpenF1 · Updates every 5 seconds' : 'Waiting for fresh samples from OpenF1.';
      }
      error.textContent = '';
      failed = false;
    } catch (failure) {
      if (lifecycle.active()) {
        error.textContent = failure.message;
        dash.draw([]);
        dash.mark();
        if (!mock) {
          mode.textContent = 'FEED UNAVAILABLE';
          mode.className = 'tag';
        }
        failed = true;
      }
    } finally {
      running = false;
      if (lifecycle.active()) timeout = setTimeout(poll, refresh ? 0 : failed ? 15_000 : mock ? 1000 : 5000);
      refresh = false;
    }
  }
  driver.onchange = poll;
  lifecycle.cleanup(() => clearTimeout(timeout));
  poll();
}
