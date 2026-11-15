export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (key in node && !key.includes('-')) node[key] = value;
    else node.setAttribute(key, value === true ? '' : value);
  }
  node.append(...children.flat().filter(child => child != null));
  return node;
}

export async function request(path, data, rawHeaders) {
  const headers = data === undefined ? {} : { 'X-Adam-Request': '1', 'Content-Type': 'application/json', ...rawHeaders };
  const response = await fetch('/api/' + path, {
    method: data === undefined ? 'GET' : 'POST',
    headers,
    body: data === undefined ? undefined : rawHeaders ? data : JSON.stringify(data),
    cache: 'no-store'
  });
  const result = await response.json();
  if (!response.ok) {
    if (response.status === 401 && path !== 'login') document.dispatchEvent(new Event('session-ended'));
    throw new Error(result.error || 'Request failed (' + response.status + ').');
  }
  return result;
}

export const query = (path, values) => request(path + '?' + new URLSearchParams(values));
export const field = (label, control) => el('label', { className: 'field' }, label, control);
export const check = (label, control) => el('label', { className: 'check' }, control, label);
export const labelError = () => el('p', { className: 'notice error', role: 'alert' });
export const button = (label, onclick, className) => el('button', { type: 'button', className, onclick }, label);
export const submit = label => el('button', { type: 'submit', className: 'primary' }, label);
export const tag = (label, kind = '') => el('span', { className: 'tag ' + kind }, label);
export const date = value => value ? new Date(value).toLocaleString() : '—';
export const line = (...items) => el('div', { className: 'row' }, items);
export const title = (name, description, category) => el('header', { className: 'heading' },
  category ? el('div', { className: 'eyebrow' }, category) : null,
  el('h1', {}, name), description ? el('p', {}, description) : null);
export const panel = (...children) => el('section', { className: 'panel stack' }, children);
export const option = (value, label) => el('option', { value }, label);

export function select(options, value, props = {}) {
  const control = el('select', props, options.map(([id, label]) => option(id, label)));
  if (value !== undefined) control.value = value;
  return control;
}

export async function task(control, error, work) {
  if (control.disabled) return;
  control.disabled = true;
  error.textContent = '';
  try {
    return await work();
  } catch (failure) {
    error.textContent = failure.message;
    return undefined;
  } finally {
    control.disabled = false;
  }
}

let toastTimer;
export function notice(text) {
  const node = document.querySelector('#notifications');
  node.replaceChildren(el('p', { className: 'notice' }, text));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.replaceChildren(), 4000);
}

export function table(headers, rows) {
  return el('div', { className: 'table-wrap' }, el('table', {},
    el('thead', {}, el('tr', {}, headers.map(label => el('th', { scope: 'col' }, label)))),
    el('tbody', {}, rows.map(cells => el('tr', {}, cells.map(cell => el('td', {}, cell)))))));
}

export const preferences = user => ({ theme: 'dark', units: 'kmh', playbackSpeed: 1, chatSound: false, ...user.prefs });

export function serviceProblem(state, service) {
  if (!state.config[service] || state.config[service] === 'off') return 'This service is disabled.';
  if (!state.secure && state.config[service + 'Transport'] === 'https') return 'This service requires HTTPS.';
  return '';
}
