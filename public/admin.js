import { button, check, date, el, field, labelError, line, notice, panel, request, select, submit, table, tag, task, title } from './ui.js';

function dialog(host, heading, message, action) {
  return new Promise(resolve => {
    const box = el('dialog', { className: 'panel' });
    const confirm = submit(action);
    confirm.value = 'confirm';
    const cancel = el('button', { type: 'submit', value: 'cancel', autofocus: true }, 'Cancel');
    box.append(el('form', { method: 'dialog', className: 'stack' }, el('h2', {}, heading),
      el('p', {}, message), line(cancel, confirm)));
    box.addEventListener('close', () => {
      resolve(box.returnValue === 'confirm');
      box.remove();
    }, { once: true });
    host.append(box);
    box.showModal();
  });
}

export function admin(parent, state, lifecycle, controller) {
  parent.append(title('Administration', 'Manage accounts, configuration and server activity.', 'ADAM-SERVER-1'));
  const tabs = el('nav', { className: 'tabs', 'aria-label': 'Administration' });
  const content = el('div', { className: 'stack' });
  parent.append(tabs, content);
  let renderId = 0;
  let pendingIntent;
  let selected = 'Console';
  const entries = { Console: consolePage, Users: usersPage, System: systemPage, Configuration: configPage, Audit: auditPage };
  const history = [];
  const transcript = [{ text: 'ADAM-SERVER-1 command console' }, { text: 'Type help to list commands.' }];
  const buttons = Object.keys(entries).map(name => button(name, () => show(name)));
  tabs.append(...buttons);

  function show(name, intent) {
    selected = name;
    pendingIntent = intent;
    const ticket = ++renderId;
    const live = () => lifecycle.active() && ticket === renderId;
    buttons.forEach(node => {
      if (node.textContent === name) node.setAttribute('aria-current', 'page');
      else node.removeAttribute('aria-current');
    });
    content.replaceChildren();
    entries[name](live).catch(failure => {
      if (live()) content.append(el('p', { className: 'notice error', role: 'alert' }, failure.message));
    });
  }

  async function configAction(endpoint, payload, operation, live) {
    if (operation !== 'apply' && operation !== 'reset') return request(endpoint, payload);
    const first = await request(endpoint, { ...payload, step: 'start' });
    const unwrap = result => result.state ?? result;
    const apply = operation === 'apply';
    const label = apply ? 'Apply' : 'Reset draft';
    if (!live() || !await dialog(parent, label + ' · 1 of 2',
      apply ? 'Publish the saved draft as the active configuration for all users?' :
        'Replace the saved draft with the configured defaults?', 'Continue')) return;
    const token = unwrap(first).confirmation;
    const second = await request(endpoint, { ...payload, step: 1, token });
    if (!live() || !await dialog(parent, label + ' · 2 of 2',
      apply ? 'Confirm publication of this configuration version.' : 'Confirm replacing the saved draft.', label)) return;
    return request(endpoint, { ...payload, step: 2, token: unwrap(second).confirmation });
  }

  async function consolePage(live) {
    const terminal = el('div', { className: 'console', role: 'log', tabIndex: 0, 'aria-label': 'Command output' });
    const command = el('input', { placeholder: 'Enter a command', ariaLabel: 'Command', autocomplete: 'off',
      maxLength: 120, spellcheck: false });
    const run = submit('Run');
    const error = labelError();
    const debug = el('pre', { className: 'console', hidden: true, 'aria-label': 'HTTP request metadata' });
    async function refreshDebug() {
      const state = await request('admin/debug');
      if (!live()) return;
      debug.hidden = !state.enabled;
      debug.textContent = state.requests.map(row => row.method + ' ' + row.path + ' → ' + row.status + ' (' + row.ms + ' ms)').join('\n')
        || 'Waiting for requests in this session.';
    }
    const monitor = setInterval(() => {
      if (!live()) clearInterval(monitor);
      else if (!debug.hidden) refreshDebug().catch(() => {});
    }, 4000);
    lifecycle.cleanup(() => clearInterval(monitor));
    refreshDebug().catch(() => {});
    let cursor = history.length;
    function paint() {
      terminal.replaceChildren(...transcript.map(row => el('div', { className: row.command ? 'terminal-prompt' : '' }, row.text)));
      terminal.scrollTop = terminal.scrollHeight;
    }
    function add(text, command = false) {
      transcript.push({ text, command });
      while (transcript.length > 60) transcript.shift();
    }
    command.onkeydown = event => {
      if (!['ArrowUp', 'ArrowDown'].includes(event.key) || !history.length) return;
      event.preventDefault();
      cursor = Math.max(0, Math.min(history.length, cursor + (event.key === 'ArrowUp' ? -1 : 1)));
      command.value = history[cursor] ?? '';
    };
    const form = el('form', { className: 'console-input' }, command, run);
    form.onsubmit = event => {
      event.preventDefault();
      const value = command.value.trim();
      if (!value) return;
      command.value = '';
      if (/^runas(?:\s|$)/i.test(value)) {
        error.textContent = 'Use a Windows terminal on the server for Windows account commands.';
        return;
      }
      task(run, error, async () => {
        const direct = /^(restart|stop|debug)(?:\s|$)/i.test(value);
        const cfg = direct ? {} : await request('admin/config');
        const action = direct ? '' : value.toLowerCase().split(/\s+/).at(-1);
        const result = await configAction('admin/console', { command: value, revision: cfg.revision, draft: cfg.draft }, action, live);
        if (!live()) return;
        history.push(value);
        if (history.length > 40) history.shift();
        cursor = history.length;
        add('> ' + value, true);
        if (!result) add('Cancelled.');
        else if (result.open) {
          add('Opened account action.');
          show('Users', result.open);
        } else if (result.state) {
          add('Configuration updated. Active version ' + result.state.active + '.');
          await controller.refresh();
        } else {
          add(typeof result.output === 'string' ? result.output :
            Array.isArray(result.output) && result.output.every(item => typeof item === 'string')
              ? result.output.join('\n') : JSON.stringify(result.output, null, 2));
        }
        paint();
        if (/^debug(?:\s|$)/i.test(value)) await refreshDebug();
      });
    };
    content.append(panel(el('h2', {}, 'Command console'), terminal, form, error, debug));
    paint();
  }

  async function usersPage(live) {
    const users = await request('admin/users');
    if (!live()) return;
    const details = panel(el('h2', {}, 'Select an account'));
    const create = button('Create account', () => editor(), 'primary');
    content.append(panel(el('div', { className: 'row spread' }, el('h2', {}, 'Accounts'), create),
      table(['ID', 'Username', 'Display name', 'Role', 'Status', ''],
        users.map(user => [user.id, user.username, user.display, user.role,
          user.disabled ? 'Disabled' : user.change_required ? 'Password change required' : 'Active',
          button('View', () => editor(user))]))), details);

    async function remove(user) {
      if (!await dialog(parent, 'Delete ' + user.username + '?',
        'This removes the account and its messages and attachments from both sides of its conversations.', 'Delete account')) return;
      await request('admin/users/' + user.id, { action: 'delete' });
      if (live()) show('Users');
      notice('Account deleted.');
    }
    function editor(user, defaultName = '') {
      const own = user?.id === state.user.id;
      const name = el('input', { required: true, minLength: 3, maxLength: 32, pattern: '[A-Za-z0-9][A-Za-z0-9_.\\-]{2,31}',
        value: user?.username ?? defaultName, autocomplete: 'off' });
      const display = el('input', { maxLength: 64, value: user?.display ?? '' });
      const role = select([['member', 'Member'], ['admin', 'Administrator']], user?.role ?? 'member', { disabled: own });
      const secret = el('input', { type: 'password', required: !user, maxLength: 256,
        autocomplete: 'new-password', disabled: own });
      const disabled = el('input', { type: 'checkbox', checked: Boolean(user?.disabled), disabled: own });
      const error = labelError();
      const save = submit(user ? 'Save account' : 'Create account');
      const form = el('form', { className: 'stack' },
        el('div', { className: 'form-grid' }, field('Username', name), field('Display name', display), field('Role', role),
          own ? null : field(user ? 'New temporary password (optional)' : 'Temporary password', secret)),
        check('Disable account', disabled), error,
        line(save, user && !own ? button('Delete account', event => task(event.currentTarget, error, () => remove(user)), 'danger') : null));
      form.onsubmit = event => {
        event.preventDefault();
        task(save, error, async () => {
          const data = { action: 'edit', username: name.value, display: display.value.trim() || name.value,
            role: role.value, disabled: disabled.checked };
          if (secret.value) data.password = secret.value;
          await request('admin/users' + (user ? '/' + user.id : ''), data);
          secret.value = '';
          if (own) await controller.account();
          if (live()) show('Users');
          notice(user ? 'Account saved.' : 'Account created.');
        });
      };
      details.replaceChildren(el('h2', {}, user ? '@' + user.username : 'Create account'),
        user ? el('small', {}, 'Created ' + date(user.created) + ' · Updated ' + date(user.updated)) : null,
        form);
      name.focus();
      return error;
    }
    if (pendingIntent) {
      const { action, target } = pendingIntent;
      pendingIntent = null;
      if (action === 'create') editor(undefined, target);
      else {
        const user = users.find(row => row.id === target);
        if (!user) throw new Error('Account not found.');
        const error = editor(user);
        if (action === 'delete') remove(user).catch(failure => { error.textContent = failure.message; });
      }
    }
  }

  async function systemPage(live) {
    const info = await request('admin/system');
    if (!live()) return;
    const fmt = value => Math.round(value / 1024 / 1024).toLocaleString() + ' MiB';
    const time = value => Math.floor(value / 3600) + ' h ' + Math.floor(value % 3600 / 60) + ' min';
    const fields = {
      Host: info.hostname, 'Operating system': info.platform + ' ' + info.release, Architecture: info.architecture,
      'Node.js': info.node, 'Application uptime': time(info.processUptime), 'Host uptime': time(info.hostUptime),
      'Host memory free': fmt(info.memoryFree) + ' / ' + fmt(info.memoryTotal),
      Transport: info.transport, 'Listen port': info.port, Storage: info.storage,
      'OpenF1 account': info.credentialsConfigured ? 'Configured' : 'Missing'
    };
    content.append(panel(el('div', { className: 'row spread' }, el('h2', {}, 'System information'),
      button('Refresh', () => show(selected))),
    el('dl', { className: 'summary' }, Object.entries(fields).map(([name, value]) => el('div', {}, el('dt', {}, name), el('dd', {}, value))))));
  }

  async function auditPage(live) {
    const log = await request('admin/audit');
    if (!live()) return;
    content.append(panel(el('div', { className: 'row spread' }, el('h2', {}, 'Audit log'), button('Refresh', () => show(selected))),
      table(['Time', 'Actor', 'Action', 'Details'],
        log.map(row => [date(row.at), row.actor, row.action, el('span', { className: 'mono' }, JSON.stringify(row.detail))]))));
  }

  async function configPage(live) {
    let cfg = await request('admin/config');
    if (!live()) return;
    const form = el('form', { className: 'stack' });
    const report = labelError();
    const controls = el('div', { className: 'row' });
    const summary = el('div', { className: 'row' });
    const status = el('small', { className: 'mono' });
    const versions = panel();
    const profiles = panel();
    let busy = false;
    const titleInput = el('input', { required: true, maxLength: 64 });
    const historyEnabled = el('input', { type: 'checkbox' });
    const chatEnabled = el('input', { type: 'checkbox' });
    const mode = select([['mock', 'Mock / simulation'], ['openf1', 'Authorized OpenF1'], ['off', 'Disabled']]);
    const seconds = el('input', { type: 'number', min: 1, max: 120, required: true });
    const fileLimit = el('input', { type: 'number', min: 1, max: 16, required: true });
    const transport = () => select([['inherit', 'Inherit server transport'], ['https', 'Require HTTPS']]);
    const historyTransport = transport();
    const liveTransport = transport();
    const chatTransport = transport();
    const save = submit('Save draft');
    const actions = [
      ['test', 'Test'], ['stop', 'Stop test'], ['apply', 'Apply'], ['revert', 'Revert draft'],
      ['rewind', 'Rewind active'], ['reset', 'Reset draft']
    ].map(([op, label]) => [op, button(label, () => act(op))]);
    controls.append(save, ...actions.map(([, node]) => node));
    form.append(summary,
      el('div', { className: 'form-grid' }, field('Site name', titleInput), field('Live feed', mode),
        field('TEST duration (seconds)', seconds), field('Attachment limit (MiB)', fileLimit),
        field('Historical transport', historyTransport), field('Live transport', liveTransport), field('Chat transport', chatTransport)),
      line(check('Enable historical telemetry', historyEnabled), check('Enable private chat', chatEnabled)),
      controls, status, report);
    content.append(panel(el('h2', {}, 'Staged configuration'), form), versions, profiles);

    function values() {
      return { title: titleInput.value, historical: historyEnabled.checked, live: mode.value,
        chat: chatEnabled.checked, maxFileMiB: Number(fileLimit.value), testSeconds: Number(seconds.value),
        historicalTransport: historyTransport.value, liveTransport: liveTransport.value, chatTransport: chatTransport.value };
    }
    function render() {
      const draft = cfg.draft;
      titleInput.value = draft.title;
      historyEnabled.checked = draft.historical;
      chatEnabled.checked = draft.chat;
      mode.value = draft.live;
      seconds.value = draft.testSeconds;
      fileLimit.value = draft.maxFileMiB;
      historyTransport.value = draft.historicalTransport;
      liveTransport.value = draft.liveTransport;
      chatTransport.value = draft.chatTransport;
      summary.replaceChildren(tag('Active version ' + cfg.active, 'good'), tag('Draft revision ' + cfg.revision),
        tag(cfg.providerReady ? 'OpenF1 account configured' : 'OpenF1 account missing', cfg.providerReady ? 'good' : ''));
      versions.replaceChildren(el('h2', {}, 'Version history'),
        table(['Version', 'Parent', 'Saved', 'Author', 'State'], cfg.versions.map(row =>
          [row.id, row.parent ?? '—', date(row.at), row.author, row.id === cfg.active ? 'Active' : 'Saved'])));
      profiles.replaceChildren(el('h2', {}, 'Profiles'),
        cfg.profiles.length ? table(['Name', 'Created', 'Author', ''], cfg.profiles.map(row =>
          [row.name, date(row.at), row.author, button('Load as draft', () => act('load-profile', { name: row.name }))])) :
          el('p', { className: 'muted' }, 'Create a profile in the console with system configuration profiles create <name>.'));
      countdown();
    }
    function countdown() {
      const remaining = Math.max(0, Math.ceil(((cfg.previewUntil ?? 0) - Date.now()) / 1000));
      status.textContent = remaining ? 'TEST active in this session · ' + remaining + ' s remaining' :
        'TEST previews the saved draft in this session.';
      for (const [op, node] of actions) {
        node.disabled = busy || (op === 'stop' && !remaining) || (op === 'rewind' && !cfg.parent);
      }
      save.disabled = busy;
    }
    async function act(action, extras = {}) {
      if (busy) return;
      if (['save', 'test', 'apply'].includes(action) && !form.reportValidity()) return;
      busy = true;
      countdown();
      report.textContent = '';
      try {
        const endpoint = 'admin/config';
        const draft = values();
        if (['test', 'apply'].includes(action) && JSON.stringify(draft) !== JSON.stringify(cfg.draft)) {
          cfg = await request(endpoint, { action: 'save', revision: cfg.revision, draft });
        }
        if (action === 'rewind' && !await dialog(parent, 'Rewind active configuration?',
          'Restore version ' + cfg.parent + ' for all users and replace the saved draft.', 'Rewind')) return;
        const result = await configAction(endpoint, { action, revision: cfg.revision, draft, ...extras }, action, live);
        if (!result || !live()) return;
        cfg = result;
        render();
        await controller.refresh();
        if (action !== 'test') notice('Configuration updated.');
      } catch (failure) {
        if (live()) report.textContent = failure.message + (failure.message.startsWith('Configuration changed')
          ? ' Switch tabs to reload the latest configuration.' : '');
      } finally {
        busy = false;
        if (live()) countdown();
      }
    }
    form.onsubmit = event => { event.preventDefault(); act('save'); };
    render();
    const interval = setInterval(() => {
      if (live()) countdown();
      else clearInterval(interval);
    }, 500);
    lifecycle.cleanup(() => clearInterval(interval));
  }
  show(selected);
}
