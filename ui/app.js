// MineAgent observer client.
//
// Opens a WebSocket to /ws, paints every incoming snapshot/event into the
// panels declared in index.html, and uses the browser SpeechSynthesis API
// to speak voice events. The agent loop and the connection layer are the
// source of every payload this script consumes.

(function () {
  const $ = (id) => document.getElementById(id);

  const els = {
    connDot: $('connDot'),
    connText: $('connText'),
    status: $('status'),
    server: $('server'),
    username: $('username'),
    task: $('task'),
    session: $('session'),
    lastError: $('lastError'),
    position: $('position'),
    health: $('health'),
    food: $('food'),
    inventory: $('inventory'),
    actions: $('actions'),
    chat: $('chat'),
    chatForm: $('chatForm'),
    chatInput: $('chatInput'),
    voice: $('voice'),
    voiceInput: $('voiceInput'),
    voiceBtn: $('voiceBtn'),
    voiceAuto: $('voiceAuto'),
  };

  const history = { chat: [], actions: [], voice: [] };
  const MAX_LOG = 100;

  function setConn(state, text) {
    els.connDot.className = 'dot ' + state;
    els.connText.textContent = text;
  }

  function fmtPos(p) {
    if (!p) return '—';
    return `${p.x}, ${p.y}, ${p.z}`;
  }

  function fmtHealth(h) {
    if (!h || h.current == null) return '—';
    const max = h.max != null ? `/${h.max}` : '';
    return `${h.current}${max}`;
  }

  function fmtFood(h) {
    if (!h || h.food == null) return '—';
    return `${h.food}/20`;
  }

  function fmtSession(s) {
    if (!s || !s.startedAt) return '—';
    const elapsed = Math.max(0, Date.now() - s.startedAt);
    return `${Math.floor(elapsed / 1000)}s`;
  }

  function paintState(s) {
    if (!s) return;
    if (s.status === 'connected') setConn('on', 'connected');
    else if (s.status === 'connecting' || s.status === 'reconnecting')
      setConn('warn', s.status);
    else if (s.status === 'error') setConn('off', 'error');
    else setConn('off', 'disconnected');

    els.status.textContent = s.status;
    els.server.textContent = s.host ? `${s.host}:${s.port}` : '—';
    els.username.textContent = s.username || '—';
    els.task.textContent = s.currentTask || 'idle';
    els.session.textContent = fmtSession(s.session);
    els.lastError.textContent = s.lastError || '—';

    els.position.textContent = fmtPos(s.position);
    els.health.textContent = fmtHealth(s.health);
    els.food.textContent = fmtFood(s.health);

    paintInventory(s.inventory);
  }

  function paintInventory(items) {
    els.inventory.innerHTML = '';
    if (!items || items.length === 0) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = 'empty';
      els.inventory.appendChild(li);
      return;
    }
    for (const it of items) {
      const li = document.createElement('li');
      const name = document.createElement('span');
      name.textContent = it.name;
      const count = document.createElement('span');
      count.className = 'count';
      count.textContent = it.count;
      li.appendChild(name);
      li.appendChild(count);
      els.inventory.appendChild(li);
    }
  }

  function logTo(ul, list, item, formatter) {
    history[list].push(item);
    if (history[list].length > MAX_LOG) history[list].shift();
    if (history[list].length === 1) ul.innerHTML = '';
    const li = document.createElement('li');
    const ts = document.createElement('span');
    ts.className = 'ts';
    ts.textContent = new Date(item.ts || Date.now()).toLocaleTimeString();
    li.appendChild(ts);
    li.appendChild(formatter(item));
    ul.appendChild(li);
    ul.scrollTop = ul.scrollHeight;
  }

  function chatFormatter(item) {
    const from = document.createElement('span');
    from.className = 'from';
    from.textContent = `<${item.from}>`;
    const msg = document.createElement('span');
    msg.textContent = item.message || '';
    const frag = document.createDocumentFragment();
    frag.appendChild(from);
    frag.appendChild(msg);
    return frag;
  }

  function actionFormatter(item) {
    const text = document.createElement('span');
    text.textContent = item.detail ? `${item.action} — ${item.detail}` : item.action;
    return text;
  }

  function voiceFormatter(item) {
    const text = document.createElement('span');
    text.textContent = item.text;
    return text;
  }

  function speak(text) {
    if (!('speechSynthesis' in window)) return;
    try {
      const utt = new SpeechSynthesisUtterance(text);
      utt.rate = 1;
      utt.pitch = 1;
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(utt);
    } catch (e) {
      console.warn('TTS failed', e);
    }
  }

  function handle(event, payload) {
    switch (event) {
      case 'snapshot':
      case 'state':
      case 'status':
        paintState(payload);
        break;
      case 'chat':
      case 'message':
        logTo(els.chat, 'chat', { ts: Date.now(), from: payload.username || 'server', message: payload.message || payload.text || '' }, chatFormatter);
        break;
      case 'action':
        logTo(els.actions, 'actions', payload, actionFormatter);
        break;
      case 'voice':
        logTo(els.voice, 'voice', payload, voiceFormatter);
        if (els.voiceAuto.checked) speak(payload.text);
        break;
      case 'connected':
      case 'disconnected':
      case 'kicked':
      case 'error':
      case 'end':
        // state snapshot will follow; nothing extra to do here
        break;
      default:
        break;
    }
  }

  function connect() {
    setConn('warn', 'connecting…');
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.addEventListener('open', () => setConn('on', 'live'));
    ws.addEventListener('close', () => {
      setConn('off', 'closed');
      setTimeout(connect, 1500);
    });
    ws.addEventListener('error', () => setConn('off', 'error'));
    ws.addEventListener('message', (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        handle(msg.event, msg.payload);
      } catch (e) {
        console.warn('bad message', e);
      }
    });
  }

  els.chatForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = els.chatInput.value.trim();
    if (!text) return;
    fetch('/api/say', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    }).catch(() => {});
    els.chatInput.value = '';
  });

  els.voiceBtn.addEventListener('click', () => {
    const text = els.voiceInput.value.trim();
    if (!text) return;
    logTo(els.voice, 'voice', { ts: Date.now(), text }, voiceFormatter);
    speak(text);
    els.voiceInput.value = '';
  });

  // Periodic state poll as a safety net for the WebSocket (also lets the
  // page work even if the WebSocket is blocked).
  async function poll() {
    try {
      const r = await fetch('/api/state', { cache: 'no-store' });
      const s = await r.json();
      paintState(s);
    } catch (e) {
      // ignore; the WebSocket is the primary source
    }
  }
  poll();
  setInterval(poll, 2000);
  connect();
})();
