/** The panel's one page: what needs a person first, then tickets, threads, decisions, settings and the inbox. Plain HTML and JS, no build step. */
export const PANEL_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>pi-superagent</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { color-scheme: light dark; --fg: #1b1b1b; --bg: #fff; --muted: #6b6b6b; --line: #e3e3e3; --warn: #b54708; --warnbg: #fff4e5; --ok: #1f7a3d; --okbg: #e9f7ee; --accent: #2a5bd7; }
  @media (prefers-color-scheme: dark) { :root { --fg: #e8e8e8; --bg: #141414; --muted: #9a9a9a; --line: #2a2a2a; --warnbg: #3a2a12; --okbg: #12301c; } }
  body { margin: 0; font: 14px/1.45 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; color: var(--fg); background: var(--bg); }
  header { display: flex; gap: 16px; align-items: center; padding: 12px 20px; border-bottom: 1px solid var(--line); position: sticky; top: 0; background: var(--bg); }
  header h1 { font-size: 16px; margin: 0; } header nav a { margin-right: 12px; color: var(--accent); text-decoration: none; cursor: pointer; } header nav a.on { font-weight: 600; text-decoration: underline; }
  header .right { margin-left: auto; color: var(--muted); display: flex; gap: 10px; align-items: center; }
  main { padding: 16px 20px; max-width: 1100px; }
  h2 { font-size: 15px; margin: 20px 0 8px; } h2:first-child { margin-top: 0; }
  .empty { color: var(--muted); padding: 10px 0; }
  .card { border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; margin: 8px 0; }
  .card.warn { border-color: var(--warn); background: var(--warnbg); }
  .row { display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap; }
  .tag { font-size: 12px; padding: 1px 7px; border-radius: 10px; border: 1px solid var(--line); color: var(--muted); white-space: nowrap; }
  .tag.person { border-color: var(--warn); color: var(--warn); } .tag.ok { border-color: var(--ok); color: var(--ok); }
  .muted { color: var(--muted); } .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
  button { font: inherit; padding: 4px 10px; border: 1px solid var(--line); border-radius: 6px; background: transparent; color: var(--fg); cursor: pointer; } button:hover { border-color: var(--accent); }
  button.primary { background: var(--accent); color: #fff; border-color: var(--accent); }
  textarea, input, select { font: inherit; color: var(--fg); background: var(--bg); border: 1px solid var(--line); border-radius: 6px; padding: 6px 8px; }
  textarea { width: 100%; box-sizing: border-box; min-height: 120px; font-family: ui-monospace, Menlo, monospace; font-size: 12px; }
  table { border-collapse: collapse; width: 100%; } td, th { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line); vertical-align: top; } th { color: var(--muted); font-weight: 500; }
  pre { white-space: pre-wrap; word-break: break-word; margin: 6px 0; font-size: 12px; }
  .chat { border: 1px solid var(--line); border-radius: 8px; padding: 8px 12px; max-height: 50vh; overflow: auto; }
  .msg { padding: 6px 0; border-bottom: 1px dashed var(--line); } .msg:last-child { border-bottom: 0; } .msg .who { font-weight: 600; } .msg.out .who { color: var(--accent); }
  .err { color: var(--warn); }
  details summary { cursor: pointer; color: var(--accent); }
</style>
</head>
<body>
<header>
  <h1>pi-superagent</h1>
  <nav id="nav"></nav>
  <div class="right"><span id="pause"></span><button id="pauseBtn"></button><span id="clock"></span></div>
</header>
<main id="main"></main>
<script>
const api = async (path, init) => {
  const res = await fetch('/api' + path, init && { ...init, headers: { 'content-type': 'application/json', ...(init.headers || {}) } })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error || res.statusText)
  return body
}
const h = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const ago = iso => { const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000); return s < 60 ? Math.round(s) + 's' : s < 3600 ? Math.round(s / 60) + 'm' : s < 86400 ? Math.round(s / 3600) + 'h' : Math.round(s / 86400) + 'd' }
const VIEWS = ['overview', 'tickets', 'threads', 'decisions', 'inbox', 'settings']
let view = location.hash.slice(1) || 'overview', detail = null
const main = document.getElementById('main'), nav = document.getElementById('nav')
nav.innerHTML = VIEWS.map(v => '<a data-v="' + v + '">' + v + '</a>').join('')
nav.onclick = e => { const v = e.target.dataset.v; if (v) { view = v; detail = null; location.hash = v; render() } }
const stateTag = t => '<span class="tag ' + (t.state.startsWith('person/') ? 'person' : t.state === 'completed' || t.state === 'merged' ? 'ok' : '') + '">' + h(t.state) + '</span>'
const ticketCard = (t, warn) => '<div class="card ' + (warn ? 'warn' : '') + '"><div class="row">' + stateTag(t) + '<b><a data-t="' + h(t.ticket_id) + '" style="cursor:pointer">' + h(t.title) + '</a></b>' +
  (t.pr_number ? '<span class="tag">PR #' + t.pr_number + '</span>' : '') + '<span class="tag">' + h(t.strength) + '</span>' +
  (t.ended ? '<span class="muted">ended ' + ago(t.ended.at) + ' ago by ' + h(t.ended.by) + ': ' + h(t.ended.reason) + '</span>' : '') + '</div>' +
  (t.attention ? '<div class="err">Question: ' + h(t.attention.question) + '</div>' : '') +
  (t.preview ? '<div class="muted">' + h(t.preview) + '</div>' : '') +
  (!t.ended ? '<div class="row" style="margin-top:6px"><button data-stop="' + h(t.ticket_id) + '">Stop</button>' + (t.state === 'person/failed' || t.state === 'person/blocked' || t.state === 'person/delivery' ? '<button data-retry="' + h(t.ticket_id) + '">Retry</button>' : '') + '</div>' : '') + '</div>'
async function render() {
  for (const a of nav.children) a.classList.toggle('on', a.dataset.v === view)
  try {
    const settings = await api('/settings')
    document.getElementById('pause').textContent = settings.settings.paused ? 'Paused' : ''
    document.getElementById('pauseBtn').textContent = settings.settings.paused ? 'Resume' : 'Pause'
    document.getElementById('pauseBtn').onclick = async () => { await api('/settings/pause', { method: 'PUT', body: JSON.stringify({ paused: !settings.settings.paused }) }); render() }
    if (detail) return renderDetail()
    main.innerHTML = await ({ overview, tickets, threads, decisions, inbox, settings: settingsView })[view](settings)
    bind()
  } catch (e) { main.innerHTML = '<div class="err">' + h(e.message) + '</div>' }
  document.getElementById('clock').textContent = new Date().toLocaleTimeString()
}
async function overview() {
  const o = await api('/overview')
  const problems = o.problems.map(p => '<div class="card warn"><b>' + h(p.name) + '</b> <span class="muted">' + ago(p.state.at) + ' ago</span><div>' + h(p.state.detail) + '</div></div>').join('')
  const needs = o.needs_person.map(t => ticketCard(t, true)).join('')
  const evaluating = o.evaluating.map(t => '<div class="card"><div class="row"><span class="tag">' + (t.evaluating ? 'evaluating' : 'queued ' + t.pending) + '</span><b>' + h(t.label) + '</b><span class="muted mono">' + h(t.thread) + '</span>' + (t.evaluating ? '<span class="muted">since ' + ago(t.evaluating.since) + ' ago</span>' : '') + (t.error ? '<span class="err">' + h(t.error) + '</span>' : '') + '</div></div>').join('')
  return '<h2>Needs a person</h2>' + (problems + needs || '<div class="empty">Nothing. ' + o.open + ' open ticket(s), ' + o.ended + ' ended.</div>') +
    (evaluating ? '<h2>Evaluating</h2>' + evaluating : '') +
    '<h2>Open tickets by state</h2><div class="row">' + (Object.entries(o.by_state).map(([k, v]) => '<span class="tag">' + h(k) + ' ' + v + '</span>').join('') || '<span class="muted">none</span>') + '</div>'
}
async function tickets() {
  const r = await api('/read?resource=tickets')
  return '<h2>Tickets (' + r.total + ')</h2>' + (r.items.map(t => ticketCard(t)).join('') || '<div class="empty">No tickets yet.</div>')
}
async function threads() {
  const r = await api('/read?resource=threads')
  return '<h2>Threads (' + r.total + ')</h2><table><tr><th>Thread</th><th>Label</th><th>Tickets</th><th>Pending</th><th></th></tr>' + r.items.map(t => '<tr><td class="mono"><a data-th="' + h(t.thread) + '" style="cursor:pointer">' + h(t.thread) + '</a></td><td>' + h(t.label) + (t.url ? ' <a href="' + h(t.url) + '" target="_blank">↗</a>' : '') + '</td><td>' + t.tickets.length + '</td><td>' + t.pending + (t.evaluating ? ' (evaluating)' : '') + '</td><td>' + (t.tickets.length ? '<button data-unsub="' + h(t.thread) + '">Unsubscribe</button>' : '') + '</td></tr>').join('') + '</table>'
}
async function decisions() {
  const r = await api('/read?resource=decisions')
  return '<h2>Decisions (' + r.total + ')</h2><table><tr><th>When</th><th>Kind</th><th>Strength</th><th>Thread</th><th>Reason</th><th></th></tr>' + r.items.map(d => '<tr><td class="muted">' + ago(d.at) + ' ago</td><td>' + h(d.kind) + '</td><td>' + h(d.strength) + '</td><td class="mono">' + h(d.thread) + '</td><td>' + h(d.reason) + '</td><td>' + (d.kind === 'ignore' || d.kind === 'unavailable' ? d.trigger_ids.map(id => '<button data-requeue="' + h(id) + '">Re-evaluate</button>').join(' ') : '') + '</td></tr>').join('') + '</table>'
}
let inboxThread = localStorage.getItem('inboxThread') || 'general'
async function inbox() {
  const threads = await api('/inbox/threads')
  if (!threads.includes(inboxThread) && threads.length) inboxThread = threads[0]
  const messages = await api('/inbox/' + encodeURIComponent(inboxThread)).catch(() => [])
  return '<h2>Inbox</h2><div class="row"><label>Thread <input id="ibThread" value="' + h(inboxThread) + '" list="ibThreads"></label><datalist id="ibThreads">' + threads.map(t => '<option value="' + h(t) + '">').join('') + '</datalist><label>From <input id="ibFrom" value="' + h(localStorage.getItem('inboxFrom') || 'alice') + '" size="10"></label></div>' +
    '<div class="chat" id="chat">' + (messages.map(m => '<div class="msg ' + (m.outgoing ? 'out' : '') + '"><span class="who">' + h(m.from) + '</span> <span class="muted">' + ago(m.at) + ' ago</span><div>' + h(m.text) + '</div></div>').join('') || '<div class="empty">No messages. Mention the agent (e.g. @agent) to ask for work.</div>') + '</div>' +
    '<div class="row" style="margin-top:8px"><input id="ibText" style="flex:1" placeholder="@agent …"><button class="primary" id="ibSend">Send</button></div>'
}
async function settingsView(s) {
  const blocks = ['policy', 'eval', 'executor', ...Object.keys(s.settings.sources).concat(['github', 'inbox']).filter((v, i, a) => a.indexOf(v) === i).map(id => 'source:' + id)]
  return '<h2>Settings <span class="muted">revision ' + s.revision + ', policy ' + h(s.policyVersion.slice(0, 8)) + '</span></h2>' + blocks.map(b => {
    const value = b.startsWith('source:') ? (s.settings.sources[b.slice(7)] ?? { enabled: false, config: {} }) : s.settings[b]
    return '<details class="card"><summary>' + h(b) + '</summary><textarea data-block="' + h(b) + '">' + h(JSON.stringify(value, null, 2)) + '</textarea><div class="row" style="margin-top:6px"><button class="primary" data-save="' + h(b) + '">Save</button><span class="muted" id="msg-' + h(b.replace(':', '-')) + '"></span></div></details>'
  }).join('')
}
async function renderDetail() {
  const r = await api('/read?resource=' + encodeURIComponent(detail))
  main.innerHTML = '<div class="row"><button id="back">← back</button><span class="mono">' + h(detail) + '</span></div><pre>' + h(JSON.stringify(r, null, 2)) + '</pre>'
  document.getElementById('back').onclick = () => { detail = null; render() }
}
function bind() {
  main.querySelectorAll('[data-t]').forEach(a => a.onclick = () => { detail = 'ticket/' + a.dataset.t; render() })
  main.querySelectorAll('[data-th]').forEach(a => a.onclick = () => { detail = 'thread/' + a.dataset.th; render() })
  main.querySelectorAll('[data-stop]').forEach(b => b.onclick = async () => { const reason = prompt('Why stop?'); if (reason === null) return; await api('/tickets/' + b.dataset.stop + '/stop', { method: 'POST', body: JSON.stringify({ reason }) }); render() })
  main.querySelectorAll('[data-retry]').forEach(b => b.onclick = async () => { await api('/tickets/' + b.dataset.retry + '/retry', { method: 'POST', body: '{}' }); render() })
  main.querySelectorAll('[data-requeue]').forEach(b => b.onclick = async () => { await api('/triggers/' + encodeURIComponent(b.dataset.requeue) + '/reevaluate', { method: 'POST', body: '{}' }); render() })
  main.querySelectorAll('[data-unsub]').forEach(b => b.onclick = async () => { if (confirm('Drop every subscription on ' + b.dataset.unsub + '?')) { await api('/threads/' + encodeURIComponent(b.dataset.unsub) + '/unsubscribe', { method: 'POST', body: '{}' }); render() } })
  main.querySelectorAll('[data-save]').forEach(b => b.onclick = async () => {
    const block = b.dataset.save, msg = document.getElementById('msg-' + block.replace(':', '-'))
    try { const s = await api('/settings'); const value = JSON.parse(main.querySelector('[data-block="' + block + '"]').value); const r = await api('/settings/' + encodeURIComponent(block), { method: 'PUT', body: JSON.stringify({ value, revision: s.revision }) }); msg.textContent = 'Saved revision ' + r.revision + (r.changed.length ? ': ' + r.changed.join(', ') : '') }
    catch (e) { msg.textContent = e.message; msg.className = 'err' }
  })
  const send = document.getElementById('ibSend')
  if (send) {
    const chat = document.getElementById('chat'); chat.scrollTop = chat.scrollHeight
    document.getElementById('ibThread').onchange = e => { inboxThread = e.target.value.trim() || 'general'; localStorage.setItem('inboxThread', inboxThread); render() }
    const go = async () => { const text = document.getElementById('ibText').value.trim(); if (!text) return; const from = document.getElementById('ibFrom').value.trim() || 'alice'; localStorage.setItem('inboxFrom', from); await api('/inbox/' + encodeURIComponent(inboxThread), { method: 'POST', body: JSON.stringify({ from, text }) }); render() }
    send.onclick = go; document.getElementById('ibText').onkeydown = e => { if (e.key === 'Enter') go() }
  }
}
render()
setInterval(() => { if (!document.activeElement || !['TEXTAREA', 'INPUT'].includes(document.activeElement.tagName)) render() }, 5000)
</script>
</body>
</html>`
