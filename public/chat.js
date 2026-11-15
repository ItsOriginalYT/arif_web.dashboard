import { button, date, el, labelError, line, panel, preferences, query, request, serviceProblem, submit, task, title } from './ui.js';

export function chat(parent, state, lifecycle) {
  parent.append(title('Private chat', 'Send messages and files to other accounts on this server.'));
  const disabled = serviceProblem(state, 'chat');
  if (disabled) {
    parent.append(panel(el('p', { className: 'notice' }, disabled)));
    return;
  }
  const contactsNode = el('ul', {});
  const chatTitle = el('h2', {}, 'Choose a contact');
  const messages = el('div', { className: 'conversation', role: 'region', 'aria-label': 'Conversation', tabIndex: 0 });
  const body = el('textarea', { ariaLabel: 'Message', rows: 1, maxLength: 4000, required: true, placeholder: 'Write a message' });
  const send = submit('Send');
  const input = el('input', { className: 'file-input', type: 'file', ariaLabel: 'Attachment' });
  const attach = button('Send file', upload);
  const error = labelError();
  const older = button('Load older messages', loadOlder);
  const compose = el('form', { className: 'compose' }, body, send);
  const footer = line(input, attach, el('small', {}, 'Up to ' + state.config.maxFileMiB + ' MiB per file'));
  const people = panel(el('h2', {}, 'Contacts'), contactsNode);
  people.classList.add('contacts');
  parent.append(el('div', { className: 'chat-layout' }, people, panel(el('div', { className: 'row spread' }, chatTitle, older),
    messages, compose, footer, error)));
  let peers = [];
  let selected;
  let shown = [];
  let loadedHistory = false;
  let hasOlder = false;
  let sequence = 0;
  let refreshing = false;
  let ticks = 0;
  let audio;

  function ping() {
    if (!audio || audio.state !== 'running') return;
    const tone = audio.createOscillator();
    const gain = audio.createGain();
    gain.gain.setValueAtTime(0.08, audio.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.19);
    tone.frequency.value = 660;
    tone.connect(gain).connect(audio.destination);
    tone.start();
    tone.stop(audio.currentTime + 0.2);
  }
  if (preferences(state.user).chatSound && window.AudioContext) {
    parent.addEventListener('pointerdown', () => {
      audio = new AudioContext();
      audio.resume().catch(() => {});
    }, { once: true });
  }

  function selectContact(peer) {
    if (selected?.id === peer.id) return;
    selected = peer;
    sequence += 1;
    shown = [];
    loadedHistory = false;
    hasOlder = false;
    body.value = input.value = '';
    renderContacts();
    renderMessages();
    refresh();
  }
  function renderContacts() {
    contactsNode.replaceChildren(...peers.map(peer => {
      const node = button(peer.display, () => selectContact(peer));
      node.title = '@' + peer.username;
      node.setAttribute('aria-pressed', String(peer.id === selected?.id));
      return el('li', {}, node);
    }));
    if (!peers.length) contactsNode.append(el('li', { className: 'muted' }, 'No other accounts yet.'));
  }
  function renderMessages(prepend = false) {
    const previousHeight = messages.scrollHeight;
    const previousTop = messages.scrollTop;
    const nearEnd = previousHeight - previousTop - messages.clientHeight < 65;
    chatTitle.textContent = selected?.display ?? 'Choose a contact';
    compose.hidden = footer.hidden = !selected;
    older.hidden = !hasOlder;
    const empty = selected ? 'No messages yet.' : 'Select an account to start a conversation.';
    messages.replaceChildren(...(shown.length ? shown.map(message => {
      const own = message.sender === state.user.id;
      return el('article', { className: own ? 'message mine' : 'message' },
        message.filename ? el('a', { href: '/api/chat/attachment/' + message.id }, message.filename) : el('p', {}, message.body),
        el('time', { dateTime: message.sent }, date(message.sent)));
    }) : [el('p', { className: 'muted' }, empty)]));
    if (prepend) messages.scrollTop = previousTop + messages.scrollHeight - previousHeight;
    else if (nearEnd || !loadedHistory) messages.scrollTop = messages.scrollHeight;
    else messages.scrollTop = previousTop;
  }
  const idOfLast = () => shown.at(-1)?.id ?? 0;
  function combine(rows) {
    const byId = new Map(shown.map(row => [row.id, row]));
    for (const row of rows) byId.set(row.id, row);
    shown = [...byId.values()].sort((a, b) => a.id - b.id);
  }
  async function refresh() {
    if (refreshing || !lifecycle.active()) return;
    refreshing = true;
    const run = sequence;
    try {
      if (ticks++ % 5 === 0) {
        const list = await request('chat/contacts');
        if (!lifecycle.active()) return;
        if (JSON.stringify(list) !== JSON.stringify(peers)) {
          const incoming = peers.length && list.some(peer => peer.latestIncoming >
            (peers.find(previous => previous.id === peer.id)?.latestIncoming ?? 0) && peer.id !== selected?.id);
          peers = list;
          if (selected && !peers.some(peer => peer.id === selected.id)) {
            selected = undefined;
            shown = [];
            sequence += 1;
            renderMessages();
          }
          renderContacts();
          if (incoming) ping();
        }
      }
      if (!selected || run !== sequence) return;
      const rows = await request('chat/with/' + selected.id);
      if (!lifecycle.active() || run !== sequence) return;
      if (!loadedHistory || (rows.at(-1)?.id ?? 0) !== idOfLast()) {
        if (loadedHistory && rows.some(row => row.id > idOfLast() && row.sender !== state.user.id)) ping();
        if (!loadedHistory) hasOlder = rows.length === 80;
        combine(rows);
        renderMessages();
        loadedHistory = true;
      }
    } catch (failure) {
      if (lifecycle.active() && run === sequence) error.textContent = failure.message;
    } finally {
      refreshing = false;
      if (lifecycle.active() && sequence !== run) refresh();
    }
  }
  function loadOlder() {
    task(older, error, async () => {
      const run = sequence;
      const rows = await query('chat/with/' + selected.id, { before: shown[0].id });
      if (!lifecycle.active() || run !== sequence) return;
      hasOlder = rows.length === 80;
      combine(rows);
      renderMessages(true);
    });
  }
  compose.onsubmit = event => {
    event.preventDefault();
    const run = sequence;
    task(send, error, async () => {
      const value = body.value;
      await request('chat/with/' + selected.id, { message: value });
      if (lifecycle.active() && run === sequence) {
        if (body.value === value) body.value = '';
        refresh();
      }
    });
  };
  function upload() {
    const file = input.files[0];
    if (!file) {
      error.textContent = 'Choose an attachment to send.';
      return;
    }
    const run = sequence;
    task(attach, error, async () => {
      if (file.size > state.config.maxFileMiB * 1024 * 1024) throw new Error('Attachment exceeds the configured limit.');
      await request('chat/with/' + selected.id + '/file', file, {
        'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name)
      });
      if (lifecycle.active() && run === sequence) {
        input.value = '';
        refresh();
      }
    });
  }
  renderContacts();
  renderMessages();
  const timer = setInterval(refresh, 2400);
  lifecycle.cleanup(() => {
    clearInterval(timer);
    if (audio) audio.close().catch(() => {});
  });
  refresh();
}
