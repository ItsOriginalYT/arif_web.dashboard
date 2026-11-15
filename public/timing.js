import { button, el, field, labelError, line, option, panel, preferences, query, request, select, serviceProblem, table, tag, title } from './ui.js';

const traceColor = index => 'hsl(' + (index * 137.5 % 360) + ', 78%, 61%)';

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
  function draw(samples, tracks, duration) {
    const first = Date.parse(samples[0]?.date);
    const span = Math.max(1, duration ?? Date.parse(samples.at(-1)?.date) - first);
    const x = sample => 55 + 720 * (sample.elapsed ?? Date.parse(sample.date) - first) / span;
    const max = samples.reduce((highest, sample) => Math.max(highest, sample.speed), 360);
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
    for (const track of tracks ?? [{ rows: samples }]) {
      const stride = Math.max(1, Math.ceil(track.rows.length / 1500));
      const plotted = track.rows.filter((_, index) => index % stride === 0 || index === track.rows.length - 1);
      const style = track.color ? { stroke: track.color, fill: 'none', 'vector-effect': 'non-scaling-stroke' } : { class: 'trace' };
      if (plotted.length === 1) graph.append(svg('circle', { cx: x(plotted[0]), cy: y(plotted[0]), r: 4, ...style }));
      if (plotted.length > 1) {
        const trace = plotted.map((sample, index) => (index ? 'L' : 'M') + x(sample).toFixed(1) + ' ' + y(sample).toFixed(1)).join(' ');
        if (!track.color) graph.append(svg('path', { d: trace + ' L' + x(plotted.at(-1)) + ' 241 L' + x(plotted[0]) + ' 241 Z', class: 'shade' }));
        graph.append(svg('path', { d: trace, ...style }));
      }
    }
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
    } else if (duration) {
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
  const comparison = el('section', { className: 'panel stack', hidden: true });
  parent.append(panel(el('div', { className: 'row spread' }, el('h2', {}, 'Session selection'), tag('OpenF1 archive', 'good')),
    el('div', { className: 'form-grid' }, field('Season', year), field('Session', session), field('Driver', driver), field('Lap', lap)),
    line(load, loading), error),
  el('div', { className: 'stack' }, dash.metrics, dash.chart,
    panel(line(play, seek, clock, speed)), comparison));
  let tracks = [];
  let drivers = [];
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
  function sampleAt(rows) {
    let low = 0;
    let high = rows.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (rows[middle].elapsed <= position) low = middle + 1;
      else high = middle;
    }
    const row = rows[low - 1];
    return row && position - row.elapsed < 5000 ? row : undefined;
  }
  function render() {
    let displayed;
    for (const track of tracks) {
      const sample = sampleAt(track.rows);
      displayed ??= sample;
      if (!track.cells) continue;
      const values = [sample?.speed == null ? null : Math.round(sample.speed * (pref.units === 'mph' ? 0.621371 : 1)),
        sample?.throttle, sample?.n_gear, sample?.rpm];
      values.forEach((value, index) => {
        const text = value == null ? '—' : String(value);
        if (track.cells[index].textContent !== text) track.cells[index].textContent = text;
      });
    }
    dash.mark(displayed, duration ? position / duration : 0);
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
    tracks = next;
    const samples = tracks.flatMap(track => track.rows);
    duration = tracks.reduce((max, track) => Math.max(max, track.rows.at(-1)?.elapsed ?? 0), 0);
    position = 0;
    dash.draw(samples, tracks, duration);
    seek.disabled = play.disabled = !duration;
    comparison.hidden = tracks.length < 2;
    dash.metrics.hidden = !comparison.hidden;
    comparison.replaceChildren();
    if (!comparison.hidden) {
      comparison.append(el('h2', {}, 'Driver comparison'),
        table(['Driver', pref.units === 'mph' ? 'Speed (mph)' : 'Speed (km/h)', 'Throttle (%)', 'Gear', 'RPM'],
          tracks.map(track => {
            track.cells = Array.from({ length: 4 }, () => el('span'));
            const dot = svg('svg', { width: 12, height: 12, viewBox: '0 0 12 12', 'aria-hidden': 'true' });
            dot.append(svg('circle', { cx: 6, cy: 6, r: 5, fill: track.color }));
            return [line(dot, driverName(track.driver)), ...track.cells];
          })));
    }
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
        drivers = rows;
        driver.append(...rows.map(row => option(row.driver_number, driverName(row))));
        if (rows.length) driver.append(option('all', 'All Drivers'));
      }
      if (session.value && driver.value) {
        const rows = await query('historical/laps', { session: session.value, driver: driver.value });
        if (!fresh()) return;
        laps = rows.filter(row => Number.isFinite(Date.parse(row.date_start)) && row.lap_duration > 0 && row.lap_duration <= 300);
        const numbers = [...new Set(laps.map(row => row.lap_number))];
        lap.append(...numbers.map(number => {
          const row = laps.find(lap => lap.lap_number === number);
          return option(number, 'Lap ' + number + (driver.value === 'all' ? '' : ' · ' + row.lap_duration.toFixed(3) + ' s'));
        }));
        if (!laps.length) {
          const selected = sessions.find(row => String(row.session_key) === session.value);
          if (Number.isFinite(Date.parse(selected?.date_start))) {
            laps = [{ date_start: selected.date_start, lap_duration: 120 }];
            lap.append(option('opening', 'Opening two-minute window'));
          }
        }
        const selected = sessions.find(row => String(row.session_key) === session.value);
        if (Date.parse(selected?.date_end) > Date.parse(selected?.date_start)) lap.append(option('all', 'All Laps'));
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
    const run = ++revision;
    const fresh = () => lifecycle.active() && run === revision;
    busy = true;
    update();
    reset();
    error.textContent = '';
    loading.textContent = 'Loading telemetry…';
    try {
      const sessionKey = session.value;
      const driverKey = driver.value;
      const full = lap.value === 'all';
      const opening = lap.value === 'opening';
      const selected = sessions.find(row => String(row.session_key) === sessionKey);
      const windows = (full || opening ? laps : laps.filter(row => row.lap_number === Number(lap.value)))
        .map(row => {
          const start = Date.parse(row.date_start);
          return { driver: row.driver_number, start, end: start + row.lap_duration * 1000 };
        });
      const start = full ? Math.min(Date.parse(selected.date_start), ...windows.map(row => row.start))
        : Math.min(...windows.map(row => row.start));
      const end = full ? Math.max(Date.parse(selected.date_end), ...windows.map(row => row.end))
        : Math.max(...windows.map(row => row.end));
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new Error('No replay window is available.');
      const roster = driverKey === 'all' ? drivers : drivers.filter(row => String(row.driver_number) === driverKey);
      const next = roster.map((driver, index) => ({
        driver, color: roster.length > 1 ? traceColor(index) : undefined, rows: []
      }));
      const byDriver = new Map(next.map(track => [track.driver.driver_number, track]));
      const lapWindows = new Map(windows.map(window => [window.driver, window]));
      const chunk = driverKey === 'all' ? 120000 : 300000;
      let count = 0;
      for (let from = start; from < end && fresh(); from += chunk) {
        const until = Math.min(from + chunk, end);
        loading.textContent = 'Loading telemetry… ' + Math.floor(100 * (from - start) / (end - start)) + '%';
        const params = { session: sessionKey, driver: driverKey, start: new Date(from).toISOString(), end: new Date(until).toISOString() };
        let rows;
        try {
          rows = await query('historical/samples', params);
        } catch (failure) {
          if (!full || failure.status !== 503 || !/rate.limit|request limit/i.test(failure.message)) throw failure;
          loading.textContent = 'Waiting for the OpenF1 request limit…';
          await new Promise(resolve => setTimeout(resolve, 61000));
          if (!fresh()) return;
          rows = await query('historical/samples', params);
        }
        if (!fresh()) return;
        for (const row of rows) {
          const track = driverKey === 'all' ? byDriver.get(row.driver_number) : next[0];
          if (!track) continue;
          const time = Date.parse(row.date);
          const window = !full && !opening && driverKey === 'all' ? lapWindows.get(row.driver_number) : { start, end };
          if (!window || time < window.start || time > window.end) continue;
          const elapsed = time - window.start;
          if (full && elapsed - (track.rows.at(-1)?.elapsed ?? -Infinity) < 1000) continue;
          track.rows.push({ ...row, elapsed });
          count += 1;
        }
      }
      if (!fresh()) return;
      reset(count ? next : []);
      loading.textContent = count ? count.toLocaleString() + ' samples loaded' : 'OpenF1 returned no samples for this window.';
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
  lap.onchange = () => {
    revision += 1;
    busy = false;
    error.textContent = loading.textContent = '';
    reset();
    update();
  };
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
