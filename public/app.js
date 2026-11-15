import { admin } from './admin.js';
import { chat } from './chat.js';
import { historical, live } from './timing.js';
import { button, check, el, field, labelError, line, notice, panel, preferences, request, select, submit, tag, task, title } from './ui.js';

const app = document.querySelector('#app');
const color = matchMedia('(prefers-color-scheme: light)');
const routes = [
  ['historical', 'Historical', '≋', historical],
  ['live', 'Live telemetry', '◉', live],
  ['chat', 'Private chat', '▤', chat],
  ['settings', 'Settings', '⚙', settings],
  ['admin', 'Administration', '›_', admin]
];
let state = { user: null, config: {} };
let generation = 0;
let cleanup = [];
let currentRoute;
let page;
let currentNav;
let topName;
let preview;
let accountName;
let connection;
let loadingSettings = false;

function brand() {
  return el('div', { className: 'brand' }, el('span', { className: 'brand-mark', 'aria-hidden': 'true' }, 'A'),
    el('div', {}, el('strong', {}, 'Arif WebDashboard'), el('small', {}, 'ADAM-SERVER-1')));
}

function theme() {
  const chosen = state.user ? preferences(state.user).theme : 'dark';
  document.documentElement.dataset.theme = chosen === 'system' ? (color.matches ? 'light' : 'dark') : chosen;
}
color.addEventListener('change', theme);

function stopPage() {
  generation += 1;
  for (const dispose of cleanup) dispose();
  cleanup = [];
}

function signout() {
  state = { ...state, user: null, config: {}, previewUntil: null };
  document.querySelector('#notifications').replaceChildren();
  theme();
  authPage();
}

async function start() {
  const session = await request('session');
  state = { ...state, ...session };
  theme();
  if (!state.user || state.user.change_required) authPage();
  else {
    Object.assign(state, await request('settings'));
    workspace();
  }
}

function authPage() {
  stopPage();
  currentRoute = null;
  page = null;
  const changing = Boolean(state.user?.change_required);
  const user = el('input', { name: 'username', autocomplete: 'username', required: true, maxLength: 32, autofocus: !changing });
  const current = el('input', { name: 'current', type: 'password', autocomplete: 'current-password', required: true,
    maxLength: 256, autofocus: changing });
  const next = el('input', { name: 'password', type: 'password', autocomplete: 'new-password', required: true,
    minLength: 12, maxLength: 256 });
  const confirm = el('input', { name: 'confirmation', type: 'password', autocomplete: 'new-password',
    required: true, minLength: 12, maxLength: 256 });
  const error = labelError();
  const submitButton = submit(changing ? 'Set password' : 'Sign in');
  const form = el('form', { className: 'stack' },
    changing ? null : field('Username', user),
    field(changing ? 'Temporary password' : 'Password', current),
    changing ? [field('New password', next), field('Confirm password', confirm)] : null,
    error, submitButton,
    changing ? button('Sign out', () => task(submitButton, error, async () => { await request('logout', {}); signout(); })) : null);
  form.onsubmit = event => {
    event.preventDefault();
    task(submitButton, error, async () => {
      if (changing && next.value !== confirm.value) throw new Error('The new passwords do not match.');
      state.user = changing ? await request('password', { current: current.value, password: next.value })
        : await request('login', { username: user.value, password: current.value });
      current.value = next.value = confirm.value = '';
      theme();
      if (state.user.change_required) authPage();
      else {
        Object.assign(state, await request('settings'));
        workspace();
      }
    });
  };
  app.replaceChildren(el('main', { className: 'auth-shell' },
    el('section', { className: 'panel stack auth-card' }, brand(),
      el('div', { className: 'stack' }, el('h1', {}, changing ? 'Set a new password' : 'Sign in'),
        el('p', { className: 'muted' }, changing ? 'Your temporary password must be changed to continue.' :
          'Use the account provided by your administrator.')),
      form, state.secure ? tag('HTTPS', 'good') : tag('Loopback connection'))));
}

function workspace() {
  currentNav = el('nav', { 'aria-label': 'Dashboard' });
  accountName = el('strong', {});
  const signoutButton = button('Sign out', () => task(signoutButton, error, async () => {
    await request('logout', {});
    signout();
  }));
  const error = labelError();
  const rail = el('aside', { className: 'sidebar' }, brand(), currentNav,
    el('div', { className: 'account row spread' }, accountName, signoutButton, error));
  topName = el('span', { className: 'top-name' });
  connection = tag('');
  preview = el('p', { className: 'notice test', role: 'status' });
  page = el('section', { className: 'stack' });
  app.replaceChildren(el('div', { className: 'shell' }, rail,
    el('main', { className: 'workspace' }, el('header', { className: 'top' }, topName, connection),
      el('div', { className: 'page stack' }, preview, page))));
  updateFrame();
  route();
}

function updateFrame() {
  if (!page) return;
  accountName.textContent = state.user.display;
  topName.textContent = document.title = state.config.title || 'Arif WebDashboard';
  connection.textContent = state.secure ? 'HTTPS' : 'LOCAL / HTTP';
  connection.className = 'tag' + (state.secure ? ' good' : '');
  const remaining = Math.max(0, Math.ceil(((state.previewUntil ?? 0) - Date.now()) / 1000));
  preview.textContent = remaining ? 'Configuration TEST in this session · ' + remaining + ' s remaining' : '';
}

function route() {
  if (!page || !state.user || state.user.change_required) return;
  stopPage();
  const available = routes.filter(([key]) => key !== 'admin' || state.user.role === 'admin');
  const [active, , , render] = available.find(([key]) => '#' + key === location.hash) ?? available[0];
  currentRoute = active;
  currentNav.replaceChildren(...available.map(([key, label, icon]) => el('a',
    { href: '#' + key, 'aria-current': key === active ? 'page' : null },
    el('span', { className: 'nav-icon', 'aria-hidden': 'true' }, icon), label)));
  page.replaceChildren();
  const current = generation;
  render(page, state, { active: () => current === generation, cleanup: fn => cleanup.push(fn) }, {
    refresh: refreshConfig, account: refreshAccount
  });
}

async function refreshAccount() {
  const { user } = await request('session');
  if (!user) { signout(); return; }
  state.user = user;
  theme();
  updateFrame();
}

async function refreshConfig() {
  if (!page || loadingSettings) return;
  loadingSettings = true;
  const userId = state.user.id;
  try {
    const next = await request('settings');
    if (!page || state.user?.id !== userId) return;
    const previous = state.config;
    Object.assign(state, next);
    updateFrame();
    const service = currentRoute;
    if (['historical', 'live', 'chat'].includes(service) &&
        (previous[service] !== next.config[service] ||
          previous[service + 'Transport'] !== next.config[service + 'Transport'] ||
          (service === 'chat' && previous.maxFileMiB !== next.config.maxFileMiB))) route();
  } finally {
    loadingSettings = false;
  }
}

function settings(parent, model, lifecycle) {
  const pref = preferences(model.user);
  parent.append(title('Settings', 'Set your display preferences, replay speed and chat alerts.'));
  const appearance = select([['dark', 'Dark'], ['light', 'Light'], ['system', 'Match device']], pref.theme);
  const units = select([['kmh', 'Kilometres per hour'], ['mph', 'Miles per hour']], pref.units);
  const speed = select([[0.5, '0.5×'], [1, '1×'], [2, '2×'], [4, '4×']], pref.playbackSpeed);
  const sound = el('input', { type: 'checkbox', checked: pref.chatSound });
  const save = submit('Save preferences');
  const error = labelError();
  const form = el('form', { className: 'stack' }, el('div', { className: 'form-grid' },
    field('Theme', appearance), field('Speed units', units), field('Default replay speed', speed)),
  check('Play a sound for incoming chat messages', sound), error, line(save));
  form.onsubmit = event => {
    event.preventDefault();
    task(save, error, async () => {
      const user = await request('preferences', {
        theme: appearance.value, units: units.value, playbackSpeed: Number(speed.value), chatSound: sound.checked
      });
      if (model.user?.id !== user.id) return;
      model.user = user;
      theme();
      if (lifecycle.active()) notice('Preferences saved.');
    });
  };
  const old = el('input', { type: 'password', autocomplete: 'current-password', required: true, maxLength: 256 });
  const next = el('input', { type: 'password', autocomplete: 'new-password', required: true, minLength: 12, maxLength: 256 });
  const confirm = el('input', { type: 'password', autocomplete: 'new-password', required: true, minLength: 12, maxLength: 256 });
  const passwordError = labelError();
  const change = submit('Change password');
  const passwordForm = el('form', { className: 'stack' }, el('div', { className: 'form-grid' },
    field('Current password', old), field('New password', next), field('Confirm password', confirm)),
  passwordError, line(change));
  passwordForm.onsubmit = event => {
    event.preventDefault();
    task(change, passwordError, async () => {
      if (next.value !== confirm.value) throw new Error('The new passwords do not match.');
      const user = await request('password', { current: old.value, password: next.value });
      if (model.user?.id === user.id) model.user = user;
      passwordForm.reset();
      if (lifecycle.active()) notice('Password changed. Other sessions were signed out.');
    });
  };
  const inherited = model.secure ? 'HTTPS' : 'Loopback HTTP';
  const rows = [['Historical telemetry', 'historical'], ['Live telemetry', 'live'], ['Private chat', 'chat']];
  const connectionPanel = panel(el('h2', {}, 'Connection'),
    el('dl', { className: 'summary' }, rows.map(([label, key]) => el('div', {}, el('dt', {}, label),
      el('dd', {}, model.config[key + 'Transport'] === 'https' ? 'HTTPS required' : inherited)))));
  parent.append(panel(el('h2', {}, 'Preferences'), form), connectionPanel, panel(el('h2', {}, 'Password'), passwordForm));
}

window.addEventListener('hashchange', route);
document.addEventListener('session-ended', signout);
setInterval(() => { if (page) updateFrame(); }, 500);
setInterval(() => { refreshConfig().catch(() => {}); }, 2500);
start().catch(error => {
  if (state.user) signout();
  else app.replaceChildren(el('main', { className: 'auth-shell' }, panel(el('h1', {}, 'Connection unavailable'),
    el('p', { className: 'notice error', role: 'alert' }, error.message), button('Retry', () => location.reload()))));
});
