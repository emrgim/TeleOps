'use strict'
/* global t, applyI18n, TELEOPS_LANG, TELEOPS_API_IT */
const $ = (s, r = document) => r.querySelector(s)
const $$ = (s, r = document) => [...r.querySelectorAll(s)]
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const ORIGIN = location.origin
const MCP = ORIGIN + '/mcp'
const LOCALE = TELEOPS_LANG === 'it' ? 'it-IT' : 'en-GB'
let state = { overview: null, accounts: [] }

document.title = t('title')
applyI18n()

function toast(msg, err = false) {
  const d = document.createElement('div')
  d.textContent = msg
  if (err) d.className = 'err'
  $('#toast').appendChild(d)
  setTimeout(() => d.remove(), err ? 7000 : 3500)
}

async function api(method, url, body) {
  const headers = { 'accept-language': TELEOPS_LANG }
  if (body !== undefined) headers['content-type'] = 'application/json'
  const r = await fetch(url, { method, credentials: 'same-origin', headers, body: body !== undefined ? JSON.stringify(body) : undefined })
  if (r.status === 401 && !url.startsWith('/auth')) { location.reload(); throw new Error(t('sessionExpired')) }
  let j = null
  try { j = await r.json() } catch { j = null }
  if (!r.ok) { const err = new Error((j && j.error && (j.error.message || j.error)) || `HTTP ${r.status}`); err.code = j?.error?.code; err.status = r.status; throw err }
  return j
}
const run = (fn) => async (...a) => { try { await fn(...a) } catch (e) { toast(e.message, true) } }

function copy(text) { navigator.clipboard.writeText(text).then(() => toast(t('copied'))) }
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-copy],[data-copy-el]')
  if (!b) return
  e.preventDefault()
  copy(b.dataset.copy ?? $('#' + b.dataset.copyEl).textContent)
})
const fmtDate = (v) => (v ? new Date(typeof v === 'number' ? v : Date.parse(v)).toLocaleString(LOCALE, { dateStyle: 'short', timeStyle: 'short' }) : '—')
const num = (n) => Number(n ?? 0).toLocaleString(LOCALE)

// ---------------------------------------------------------------- grid / list view (per list, remembered in this browser)
const viewOf = (id) => (localStorage.getItem('to.view.' + id) === 'list' ? 'list' : 'grid')
function applyView(id) {
  const v = viewOf(id)
  const el = document.getElementById(id)
  if (el) { el.classList.toggle('view-list', v === 'list'); el.classList.toggle('view-grid', v === 'grid') }
  $$(`.viewsw[data-view-for="${id}"] button`).forEach((b) => { b.classList.toggle('on', b.dataset.view === v); b.setAttribute('aria-pressed', String(b.dataset.view === v)) })
}
$$('.viewsw').forEach((w) => {
  w.querySelectorAll('button').forEach((b) => { b.title = t(b.dataset.i18nTitle); b.setAttribute('aria-label', b.title) })
  w.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-view]')
    if (!b) return
    localStorage.setItem('to.view.' + w.dataset.viewFor, b.dataset.view)
    applyView(w.dataset.viewFor)
  })
  applyView(w.dataset.viewFor)
})

// ---------------------------------------------------------------- tabs
// top tabs: bots · connectors (mcp / api / hooks) · settings (general / db / …)
const SUBS = { connect: ['mcp', 'api', 'hooks'], settings: ['general', 'updates', 'db', 'log', 'voice', 'feedback', 'backup', 'license'] }
const LEGACY = { numbers: 'bots', keys: 'connect/api', hooks: 'connect/hooks', db: 'settings/db' }
const lastSub = { connect: 'mcp', settings: 'general' }
let routeItem = null // third part of the route: #connect/mcp/cursor
$$('#tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)))
$$('.subnav button').forEach((b) => b.addEventListener('click', () => showTab(b.closest('.subnav').dataset.for, b.dataset.sub)))
function showTab(tab, sub, item) {
  routeItem = item || null
  if (SUBS[tab]) { sub = SUBS[tab].includes(sub) ? sub : lastSub[tab]; lastSub[tab] = sub } else sub = undefined
  $$('#tabs button').forEach((x) => x.classList.toggle('on', x.dataset.tab === tab))
  $$('.tab').forEach((x) => x.classList.toggle('on', x.id === tab))
  $$('.subnav').forEach((n) => { n.hidden = n.dataset.for !== tab })
  $('.subbar').classList.toggle('on', !!sub)
  if (sub) {
    $$(`.subnav[data-for=${tab}] button`).forEach((b) => b.classList.toggle('on', b.dataset.sub === sub))
    $$('.sub', $('#' + tab)).forEach((d) => d.classList.toggle('on', d.id === tab + '-' + sub))
  }
  window.scrollTo(0, 0)
  const route = sub ? tab + '/' + sub : tab
  if (route !== 'settings/log') stopLogLive()
  history.replaceState(null, '', '#' + route + (routeItem ? '/' + routeItem : ''))
  loaders[route]?.()
}
$('#logout').addEventListener('click', run(async () => { await api('POST', '/auth/logout'); location.reload() }))

// ---------------------------------------------------------------- bots
const STATE_CLASS = { open: 'open', connecting: 'warn', reconnecting: 'warn', conflict: 'bad', unauthorized: 'bad', not_linked: 'bad', error: 'bad', stopped: '' }
function badge(s) { return `<span class="badge ${STATE_CLASS[s] ?? ''}">${esc(t('state.' + s))}</span>` }

async function loadOverview() {
  state.overview = await api('GET', '/v1/admin/overview')
  state.accounts = state.overview.accounts
  // only the version: the server's address is not shown in the page
  $('#host').textContent = state.overview.versionLabel || state.overview.version
  $('.subnav[data-for=settings] [data-sub=license]').hidden = !state.overview.license?.enabled
  renderAccounts()
  fillAccountSelects()
}

function renderAccounts() {
  const el = $('#accounts')
  if (!state.accounts.length) {
    el.innerHTML = `<div class="card"><p>${esc(t('bots.empty'))}</p><p class="muted">${t('bots.emptyHint')}</p></div>`
    return
  }
  el.innerHTML = state.accounts.map((a) => {
    const st = a.stats
    const conflict = a.state === 'conflict'
    return `<div class="card acc" data-id="${esc(a.id)}">
      <div class="top"><div class="who">${avatar(a)}<div><h4>${esc(a.name)} ${a.default ? `<span class="badge">${esc(t('acc.default'))}</span>` : ''}</h4>
        <div class="phone">${a.username ? `<a href="${esc(a.link)}" target="_blank" rel="noopener">@${esc(a.username)}</a>` : '—'}</div>${a.about ? `<div class="muted small about">${esc(a.about)}</div>` : ''}<div class="muted small">id <code>${esc(a.id)}</code></div></div></div>${badge(a.state)}</div>
      ${st ? `<div class="stats"><span><b>${num(st.chats)}</b> ${esc(t('acc.chats'))}</span><span><b>${num(st.messages)}</b> ${esc(t('acc.messages'))}</span><span><b>${num(st.people)}</b> ${esc(t('acc.people'))}</span><span><b>${num(st.groups)}</b> ${esc(t('acc.groups'))}</span>${st.channels ? `<span><b>${num(st.channels)}</b> ${esc(t('acc.channels'))}</span>` : ''}</div>` : ''}
      ${a.readsAllGroupMessages === false ? `<div class="muted small">${esc(t('acc.privacyOn'))}</div>` : ''}
      ${a.lastError && a.state !== 'open' ? `<div class="muted small">${esc(t('acc.lastError', a.lastError.reason))}</div>` : ''}
      <div class="actions">
        <button class="small" data-act="profile">${esc(t('acc.profile'))}</button>
        ${conflict ? `<button class="small" data-act="takeover">${esc(t('acc.takeOver'))}</button>` : ''}
        ${a.state === 'unauthorized' ? `<button class="small" data-act="token">${esc(t('acc.newToken'))}</button>` : ''}
        ${a.enabled && !['open', 'conflict', 'unauthorized'].includes(a.state) ? `<button class="small ghost" data-act="restart">${esc(t('acc.reconnect'))}</button>` : ''}
        ${!a.default ? `<button class="small ghost" data-act="default">${esc(t('acc.makeDefault'))}</button>` : ''}
        <button class="small ghost" data-act="toggle">${esc(t(a.enabled ? 'acc.pause' : 'acc.resume'))}</button>
        <button class="small danger" data-act="delete">${esc(t('acc.delete'))}</button>
      </div></div>`
  }).join('')
}

$('#accounts').addEventListener('click', run(async (e) => {
  const b = e.target.closest('button[data-act]')
  if (!b) return
  const id = b.closest('[data-id]').dataset.id
  const a = state.accounts.find((x) => x.id === id)
  switch (b.dataset.act) {
    case 'profile': return openProfile(id)
    case 'token': return openAdd()
    case 'restart': await api('POST', `/v1/bots/${id}/restart`, {}); toast(t('acc.reconnecting')); break
    case 'takeover':
      if (!confirm(t('confirm.takeOver', a.name))) return
      await api('POST', `/v1/bots/${id}/restart`, { takeOver: true }); toast(t('acc.reconnecting')); break
    case 'default': await api('PATCH', `/v1/bots/${id}`, { isDefault: true }); break
    case 'toggle': await api('PATCH', `/v1/bots/${id}`, { enabled: !a.enabled }); break
    case 'delete':
      if (!confirm(t('confirm.delete', a.name))) return
      await api('DELETE', `/v1/bots/${id}`); break
  }
  await loadOverview()
}))

function openAdd() { $('#addForm').reset(); $('#addDlg').showModal(); $('#addForm').token.focus() }
$('#addBot').addEventListener('click', openAdd)
$('#addDlg').addEventListener('close', run(async () => {
  if ($('#addDlg').returnValue !== 'ok') return
  const token = $('#addForm').token.value.trim()
  if (!token) return
  let r
  try {
    r = await api('POST', '/v1/bots', { token })
  } catch (e) {
    // the bot sends its updates to another program's webhook: take it over only if the owner says so
    if (e.code !== 'WEBHOOK_SET' || !confirm(e.message)) throw e
    r = await api('POST', '/v1/bots', { token, takeOver: true })
  }
  toast(t(r.created ? 'bots.added' : 'bots.tokenReplaced', r.name))
  await loadOverview()
}))

// ---------------------------------------------------------------- profile (name · descriptions · commands · photo, changed on Telegram)
function initials(name) { return String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase() }
function avatar(a, big = false) {
  return a.photo
    ? `<img class="avatar${big ? ' big' : ''}" alt="" src="/v1/bots/${encodeURIComponent(a.id)}/profile/photo?t=${Date.now() >> 16}">`
    : `<span class="avatar${big ? ' big' : ''}">${esc(initials(a.name))}</span>`
}
let profId = null
let profCur = null
const cmdsToText = (list) => (list || []).map((c) => `/${c.command} - ${c.description}`).join('\n')
function textToCmds(s) {
  return String(s || '').split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
    const m = l.match(/^\/?([A-Za-z0-9_]{1,32})\s*(?:[-–—:]\s*)?(.*)$/)
    if (!m || !m[2].trim()) throw new Error(t('prof.badCommand', l))
    return { command: m[1].toLowerCase(), description: m[2].trim() }
  })
}
async function openProfile(id) {
  const a = state.accounts.find((x) => x.id === id)
  if (!a) return
  if (a.state !== 'open') { toast(t('prof.offline'), true); return }
  profId = id
  profCur = await api('GET', `/v1/bots/${encodeURIComponent(id)}/profile`)
  const f = $('#profForm')
  f.reset()
  $('#profAvatar').outerHTML = avatar(a, true).replace('class="avatar big"', 'class="avatar big" id="profAvatar"')
  $('#profPhone').textContent = a.username ? '@' + a.username : ''
  f.name.value = profCur.name
  f.about.value = profCur.about ?? ''
  f.description.value = profCur.description ?? ''
  f.commands.value = cmdsToText(profCur.commands)
  f.readAll.checked = !!profCur.readsAllGroupMessages
  $('#profRemovePhoto').hidden = !profCur.photo
  $('#profDlg').showModal()
}
const fileToDataUrl = (f) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(f) })
// preview the chosen photo before it is sent to Telegram
$('#profForm').photo.addEventListener('change', run(async (e) => {
  const f = e.target.files[0]
  if (!f) return
  $('#profAvatar').outerHTML = `<img class="avatar big" id="profAvatar" alt="" src="${await fileToDataUrl(f)}">`
}))
// a wrong command line keeps the dialog open
$('#profForm').addEventListener('submit', (e) => {
  if (e.submitter?.value !== 'ok') return
  try { textToCmds($('#profForm').commands.value) } catch (err) { e.preventDefault(); toast(err.message, true) }
})
$('#profRemovePhoto').addEventListener('click', run(async () => {
  if (!confirm(t('prof.confirmRemove'))) return
  await api('DELETE', `/v1/bots/${encodeURIComponent(profId)}/profile/photo`)
  $('#profDlg').close('cancel')
  toast(t('prof.saved'))
  await loadOverview()
}))
$('#profDlg').addEventListener('close', run(async () => {
  if ($('#profDlg').returnValue !== 'ok' || !profId || !profCur) return
  const f = $('#profForm')
  const body = {}
  if (f.name.value.trim() && f.name.value.trim() !== profCur.name) body.name = f.name.value.trim()
  if (f.about.value.trim() !== (profCur.about ?? '')) body.about = f.about.value.trim()
  if (f.description.value.trim() !== (profCur.description ?? '')) body.description = f.description.value.trim()
  const cmds = textToCmds(f.commands.value)
  if (JSON.stringify(cmds) !== JSON.stringify((profCur.commands || []).map((c) => ({ command: c.command, description: c.description })))) body.commands = cmds
  if (f.readAll.checked !== !!profCur.readsAllGroupMessages) body.readAllGroupMessages = f.readAll.checked
  if (Object.keys(body).length) await api('PATCH', `/v1/bots/${encodeURIComponent(profId)}/profile`, body)
  const file = f.photo.files[0]
  if (file) await api('PUT', `/v1/bots/${encodeURIComponent(profId)}/profile/photo`, { base64: await fileToDataUrl(file) })
  if (Object.keys(body).length || file) toast(t('prof.saved'))
  await loadOverview()
}))

// ---------------------------------------------------------------- your Telegram (login codes come there)
let ownerTimer = null
async function loadOwner() {
  const o = await api('GET', '/v1/admin/owner')
  $('#ownerState').innerHTML = o.linked
    ? esc(t('owner.linked', o.telegram.name || o.telegram.id, o.telegram.username ? '@' + o.telegram.username : 'id ' + o.telegram.id))
    : `<span class="muted">${esc(t('owner.none'))}</span>`
  $('#ownerUnlink').hidden = !o.linked
  $('#ownerLink').textContent = t(o.linked ? 'owner.relink' : 'owner.link')
  return o
}
$('#ownerLink').addEventListener('click', run(async () => {
  const before = (await api('GET', '/v1/admin/owner')).telegram?.at ?? null
  const r = await api('POST', '/v1/admin/owner/link', {})
  $('#ownerOut').hidden = false
  $('#ownerOut').innerHTML = `<p>${esc(t('owner.open', '@' + r.username, r.expiresInMin))}</p><p><a href="${esc(r.url)}" target="_blank" rel="noopener"><button type="button">${esc(t('owner.openBtn'))}</button></a> <button type="button" class="ghost small" data-copy="${esc(r.url)}">${esc(t('copy'))}</button></p>`
  // wait for Start to be pressed (as long as the link is valid)
  clearInterval(ownerTimer)
  const until = Date.now() + r.expiresInMin * 60_000
  ownerTimer = setInterval(async () => {
    if (Date.now() > until || !$('#ownerCard')) { clearInterval(ownerTimer); return }
    const o = await api('GET', '/v1/admin/owner').catch(() => null)
    if (o?.linked && o.telegram.at !== before) {
      clearInterval(ownerTimer)
      $('#ownerOut').hidden = true
      await loadOwner()
      toast(t('owner.done'))
    }
  }, 3000)
}))
$('#ownerUnlink').addEventListener('click', run(async () => {
  if (!confirm(t('owner.unlinkConfirm'))) return
  await api('DELETE', '/v1/admin/owner')
  await loadOwner()
}))

// ---------------------------------------------------------------- live events
function startEvents() {
  const es = new EventSource('/v1/events')
  let timer = null
  const refresh = () => { clearTimeout(timer); timer = setTimeout(() => loadOverview().catch(() => {}), 600) }
  es.addEventListener('connection.update', refresh)
  es.addEventListener('profile.update', refresh)
  es.addEventListener('chat.member', refresh)
}

// ---------------------------------------------------------------- connectors
// connectors: square tiles (logo + name); the settings of each app open when you enter its tile
const MCP_CLIENTS = [
  { id: 'cursor', name: 'Cursor', logo: 'cursor.svg', mono: true, match: /cursor/i },
  { id: 'claude', name: 'Claude', logo: 'claude.svg', match: /claude|anthropic/i },
  { id: 'chatgpt', name: 'ChatGPT', logo: 'chatgpt.svg', mono: true, match: /chatgpt|openai/i },
  { id: 'grok', name: 'Grok', logo: 'grok.svg', mono: true, match: /^grok$|grok\.com|^grok[^-\s]/i },
  { id: 'grokbot', name: 'Grok Bot', logo: 'grokbot.png', match: /grok[-\s]?bot/i },
  { id: 'hermes', name: 'Hermes', logo: 'hermes.png', match: /hermes/i },
  { id: 'gemini', name: 'Gemini', logo: 'gemini.svg', match: /gemini/i },
  { id: 'other', nameKey: 'connect.other.title', logo: 'mcp.svg', mono: true },
]
const clientName = (c) => (c.nameKey ? t(c.nameKey) : c.name)
function logo(c, big = false) {
  const u = `/static/logos/${c.logo}`
  return c.mono
    ? `<span class="logo mono${big ? ' big' : ''}" style="-webkit-mask-image:url(${u});mask-image:url(${u})" role="img" aria-label="${esc(clientName(c))}"></span>`
    : `<img class="logo${big ? ' big' : ''}" src="${u}" alt="${esc(clientName(c))}">`
}
function tiles(list, sub) {
  return list.map((c) => `<button type="button" class="tile" data-tile="${esc(c.id)}" data-sub="${sub}">${logo(c)}<span class="tile-name">${esc(clientName(c))}</span><span class="chev" aria-hidden="true">›</span></button>`).join('')
}
function detailHead(c, sub) {
  return `${sub ? `<div class="detail-head"><button type="button" class="ghost small" data-back="${sub}">← MCP</button></div>` : ''}
    <div class="detail-title">${logo(c, true)}<h2>${esc(clientName(c))}</h2></div>`
}
function endpointLine() {
  return `<p class="muted"><span>${esc(t('connect.endpoint'))}</span> <code>${esc(MCP)}</code> <button class="ghost small" data-copy="${esc(MCP)}">${esc(t('copy'))}</button></p>`
}
// the Agent Skill in the repository: the guide to every tool for the agent that connects
const SKILL_FILE = 'https://github.com/emrgim/TeleOps/raw/main/skills/teleops.skill'
const SKILL_GUIDE = 'https://github.com/emrgim/TeleOps/blob/main/skills/teleops/SKILL.md'
function skillLine() {
  return `<p class="muted"><span>${esc(t('connect.skill'))}</span> <a href="${SKILL_FILE}" download>teleops.skill</a> · <a href="${SKILL_GUIDE}#3-install-this-skill" target="_blank" rel="noopener">${esc(t('connect.skillHow'))}</a></p>`
}
function mcpSetup(id) {
  const cursorLink = `cursor://anysphere.cursor-deeplink/mcp/install?name=teleops&config=${encodeURIComponent(btoa(JSON.stringify({ url: MCP })))}`
  switch (id) {
    case 'cursor': return `<p class="muted">${esc(t('connect.cursor.hint'))}</p><p><a href="${esc(cursorLink)}"><button type="button">${esc(t('connect.cursor.add'))}</button></a></p>
      <pre>${esc(JSON.stringify({ mcpServers: { teleops: { url: MCP } } }, null, 2))}</pre><p class="muted small">${t('connect.cursor.plugin')}</p>`
    case 'claude': return `<p class="muted">${t('connect.claude.hint')}</p><pre>${esc(MCP)}</pre>
      <p class="muted">${esc(t('connect.claude.code'))}</p><pre>claude mcp add --transport http teleops ${esc(MCP)}</pre>`
    case 'chatgpt': return `<p class="muted">${esc(t('connect.chatgpt.hint'))}</p><pre>${esc(MCP)}</pre>`
    case 'grok': return `<p class="muted">${esc(t('connect.grok.hint'))}</p><pre>Server URL: ${esc(MCP)}
Client ID: grok
Client Secret: ${esc(t('connect.empty'))}
Authorization Endpoint: ${esc(ORIGIN)}/oauth/authorize
Token Endpoint: ${esc(ORIGIN)}/oauth/token
Scopes: read send
Token Auth Method: none (PKCE)</pre>`
    case 'grokbot': return `<p class="muted">${esc(t('connect.grokbot.hint'))}</p><div id="grokBotOut"><button type="button" class="ghost" data-mk="grokbot">${esc(t('connect.grokbot.mk'))}</button></div>`
    case 'hermes': return `<p class="muted">${esc(t('connect.hermes.hint'))}</p><div id="hermesOut"><button type="button" class="ghost" data-mk="hermes">${esc(t('connect.hermes.mk'))}</button></div>`
    case 'gemini': return `<p class="muted">${esc(t('connect.gemini.hint'))}</p><pre>gemini mcp add --transport http teleops ${esc(MCP)}</pre>
      <pre>${esc(JSON.stringify({ mcpServers: { teleops: { httpUrl: MCP } } }, null, 2))}</pre><p class="muted small">${esc(t('connect.gemini.auth'))}</p>`
    default: return `<p class="muted">${esc(t('connect.other.hint'))}</p><pre>${esc(MCP)}</pre>
      <p class="muted">${esc(t('connect.other.stdio'))}</p><pre>TELEOPS_MCP_URL=${esc(MCP)} TELEOPS_API_KEY=tok_… teleops stdio</pre>`
  }
}
const grantOf = (g) => MCP_CLIENTS.find((c) => c.match && (c.match.test(g.clientId) || c.match.test(g.clientName)))?.id ?? 'other'
async function loadConnect() {
  const item = routeItem
  const c = item && MCP_CLIENTS.find((x) => x.id === item)
  $('#mcpTiles').hidden = !!c
  $('#mcpBar').hidden = !!c
  $('#mcpDetail').hidden = !c
  if (!c) { $('#mcpTiles').innerHTML = tiles(MCP_CLIENTS, 'mcp'); return }
  $('#mcpDetail').innerHTML = `${detailHead(c, 'mcp')}<div class="card client">${endpointLine()}${mcpSetup(c.id)}${skillLine()}</div>
    <div class="card"><h3>${esc(t('connect.appGrants'))}</h3><div id="grants"></div></div>`
  const o = await api('GET', '/v1/admin/oauth')
  const mine = o.grants.filter((g) => grantOf(g) === c.id)
  $('#grants').innerHTML = mine.length
    ? `<table><tr><th>${t('th.app')}</th><th>${t('th.scopes')}</th><th>${t('th.authorized')}</th><th>${t('th.lastUsed')}</th><th></th></tr>${mine.map((g) => `<tr><td>${esc(g.clientName)}</td><td>${esc(g.scopes)}</td><td>${fmtDate(g.createdAt)}</td><td>${fmtDate(g.lastUsed)}</td><td><button class="small danger" data-revoke-grant="${esc(g.family)}">${esc(t('revoke'))}</button></td></tr>`).join('')}</table>`
    : `<p class="muted">${esc(t('connect.noGrants'))}</p>`
}
async function loadSessions() {
  const s = await api('GET', '/v1/admin/sessions')
  $('#sessions').innerHTML = `<table><tr><th>${t('th.access')}</th><th>${t('th.created')}</th><th>${t('th.lastUsed')}</th><th></th></tr>${s.map((x) => `<tr><td>${esc(x.label)}</td><td>${fmtDate(x.created_at)}</td><td>${fmtDate(x.last_seen)}</td><td><button class="small danger" data-revoke-sess="${esc(x.id_hash)}">${esc(t('revoke'))}</button></td></tr>`).join('')}</table>`
}
document.addEventListener('click', run(async (e) => {
  const tile = e.target.closest('[data-tile]')
  if (tile) return showTab('connect', tile.dataset.sub, tile.dataset.tile)
  const back = e.target.closest('[data-back]')
  if (back) return showTab('connect', back.dataset.back)
  const mk = e.target.closest('[data-mk]')
  if (mk) {
    const which = mk.dataset.mk
    const k = await api('POST', '/v1/admin/api-keys', { name: which === 'grokbot' ? 'Grok Bot' : 'Hermes', scopes: ['read', 'send'] })
    if (which === 'grokbot') $('#grokBotOut').innerHTML = `<pre>${esc(MCP)}?token=${esc(k.key)}</pre><button class="small" data-copy="${esc(MCP + '?token=' + k.key)}">${esc(t('copyUrl'))}</button> <span class="muted small">${esc(t('shownOnce'))}</span>`
    else {
      const y = `mcp_servers:\n  teleops:\n    url: "${MCP}"\n    headers:\n      Authorization: "Bearer ${k.key}"\n    timeout: 120`
      $('#hermesOut').innerHTML = `<pre>${esc(y)}</pre><button class="small" data-copy="${esc(y)}">${esc(t('copy'))}</button> <span class="muted small">${esc(t('shownOnce'))}</span>`
    }
    return
  }
  const g = e.target.closest('[data-revoke-grant]')
  if (g && confirm(t('confirm.revokeApp'))) { await api('DELETE', `/v1/admin/oauth/grants/${g.dataset.revokeGrant}`); await loadConnect() }
  const s = e.target.closest('[data-revoke-sess]')
  if (s && confirm(t('confirm.revokeSession'))) { await api('DELETE', `/v1/admin/sessions/${s.dataset.revokeSess}`); await loadSessions() }
}))

// ---------------------------------------------------------------- API keys
function fillAccountSelects() {
  const opts = state.accounts.map((a) => `<option value="${esc(a.id)}">${esc(a.name)}${a.username ? ' · @' + esc(a.username) : ''}</option>`).join('')
  $('#keyForm select[name=bots]').innerHTML = opts
  $('#hookForm select[name=bot]').innerHTML = `<option value="*">${esc(t('all'))}</option>` + opts
}
async function loadKeys() {
  const keys = await api('GET', '/v1/admin/api-keys')
  $('#keyList').innerHTML = keys.length
    ? `<table><tr><th>${t('th.name')}</th><th>${t('th.prefix')}</th><th>${t('th.scopes')}</th><th>${t('th.bots')}</th><th>${t('th.created')}</th><th>${t('th.lastUsed')}</th><th></th></tr>${keys.map((k) => `<tr style="${k.revoked ? 'opacity:.45' : ''}"><td>${esc(k.name)}</td><td><code>${esc(k.prefix)}…</code></td><td>${esc(k.scopes)}</td><td>${esc(k.accounts === '*' ? t('all') : k.accounts)}</td><td>${fmtDate(k.created_at)}</td><td>${fmtDate(k.last_used)}</td><td>${k.revoked ? esc(t('keys.revoked')) : `<button class="small danger" data-revoke-key="${esc(k.id)}">${esc(t('revoke'))}</button>`}</td></tr>`).join('')}</table>`
    : `<p class="muted">${esc(t('keys.none'))}</p>`
}
$('#keyForm').addEventListener('submit', run(async (e) => {
  e.preventDefault()
  const f = e.target
  const scopes = ['read', 'send', 'admin'].filter((s) => f[s].checked)
  const bots = [...f.bots.selectedOptions].map((o) => o.value)
  const k = await api('POST', '/v1/admin/api-keys', { name: f.elements.name.value, scopes, bots: bots.length ? bots : '*' })
  $('#newKey').hidden = false
  $('#newKey').innerHTML = `<b>${esc(t('keys.created'))}</b><code>${esc(k.key)}</code><button class="small" data-copy="${esc(k.key)}">${esc(t('copy'))}</button>`
  f.reset()
  await loadKeys()
}))
$('#keyList').addEventListener('click', run(async (e) => {
  const b = e.target.closest('[data-revoke-key]')
  if (b && confirm(t('confirm.revokeKey'))) { await api('DELETE', `/v1/admin/api-keys/${b.dataset.revokeKey}`); await loadKeys() }
}))

// ---------------------------------------------------------------- database
const DIALECT = { sqlite: 'SQLite', postgres: 'PostgreSQL', mysql: 'MySQL / MariaDB' }
async function loadDb() {
  const d = await api('GET', '/v1/admin/database')
  $('#dbCurrent').innerHTML = `<div class="muted small">${esc(t('db.inUse'))}</div><b>${esc(DIALECT[d.dialect])}</b><div><code>${esc(d.url)}</code></div>
    ${d.envOverride ? `<p class="muted">${esc(t('db.env'))}</p>` : ''}
    ${d.previous.length ? `<p class="muted small">${esc(t('db.previous'))} ${d.previous.map((p) => `<code>${esc(p.url)}</code> (${fmtDate(p.at)})`).join(', ')}</p>` : ''}`
  $('#dbForm [name=path]').placeholder = d.defaultSqlite.replace('sqlite://', '')
}
function dbType() { return $('#dbForm [name=type]').value }
$('#dbForm [name=type]').addEventListener('change', () => {
  const ty = dbType()
  $('#dbForm [data-for=sqlite]').hidden = ty !== 'sqlite'
  $('#dbForm [data-for=net]').hidden = ty === 'sqlite'
  $('#dbForm [name=port]').placeholder = ty === 'mysql' ? '3306' : '5432'
})
function dbUrl() {
  const f = $('#dbForm')
  if (f.url.value.trim()) return f.url.value.trim()
  const ty = dbType()
  if (ty === 'sqlite') return 'sqlite://' + (f.path.value.trim() || f.path.placeholder)
  const host = f.host.value.trim() || '127.0.0.1'
  const port = f.port.value.trim() || (ty === 'mysql' ? '3306' : '5432')
  const cred = f.user.value ? encodeURIComponent(f.user.value) + (f.password.value ? ':' + encodeURIComponent(f.password.value) : '') + '@' : ''
  let u = `${ty === 'mysql' ? 'mysql' : 'postgres'}://${cred}${host}:${port}/${encodeURIComponent(f.database.value.trim() || 'teleops')}`
  if (f.ssl.checked) u += ty === 'mysql' ? '?ssl={"rejectUnauthorized":true}' : '?sslmode=require'
  return u
}
$('#dbTest').addEventListener('click', run(async () => {
  $('#dbResult').textContent = t('db.testing')
  const r = await api('POST', '/v1/admin/database/test', { url: dbUrl() })
  $('#dbResult').textContent = t('db.ok', DIALECT[r.dialect], r.latencyMs) + (r.existingBots != null ? t('db.hasAccounts', r.existingBots) : t('db.empty'))
}))
$('#dbForm').addEventListener('submit', run(async (e) => {
  e.preventDefault()
  const copyData = $('#dbForm [name=copy]').checked
  if (!confirm(t(copyData ? 'db.confirmCopy' : 'db.confirmNoCopy'))) return
  $('#dbResult').textContent = t('db.moving')
  const r = await api('POST', '/v1/admin/database/switch', { url: dbUrl(), copyData })
  $('#dbResult').textContent = t('db.done') + (r.copied ? t('db.copied', Object.entries(r.copied).filter(([, n]) => n).map(([tb, n]) => `${tb} ${num(n)}`).join(', ')) : '')
  setTimeout(() => location.reload(), 6000)
}))

// ---------------------------------------------------------------- webhooks
async function loadHooks() {
  const [hooks, del] = await Promise.all([api('GET', '/v1/admin/webhooks'), api('GET', '/v1/admin/webhooks/deliveries')])
  $('#hookList').innerHTML = hooks.length
    ? `<table><tr><th>URL</th><th>${t('th.events')}</th><th>${t('th.bot')}</th><th>${t('th.auth')}</th><th>${t('th.status')}</th><th></th></tr>${hooks.map((h) => `<tr data-hook-row="${esc(h.id)}"><td><code>${esc(h.url)}</code></td><td>${esc(h.events)}</td><td>${esc(h.account_id === '*' ? t('all') : h.account_id)}</td><td class="small">${Object.keys(h.headers || {}).length ? Object.entries(h.headers).map(([k, v]) => `<code>${esc(k)}: ${esc(v)}</code>`).join('<br>') : '<span class="muted">—</span>'}</td><td>${esc(t(h.active ? 'hooks.active' : 'hooks.paused'))}</td><td class="actions"><button class="small ghost" data-hook-test="${esc(h.id)}">${esc(t('hooks.test'))}</button><button class="small ghost" data-hook-auth="${esc(h.id)}" data-has="${Object.keys(h.headers || {}).length ? 1 : 0}">${esc(t('hooks.key'))}</button><button class="small ghost" data-hook-toggle="${esc(h.id)}" data-active="${h.active}">${esc(t(h.active ? 'hooks.pause' : 'hooks.enable'))}</button><button class="small danger" data-hook-del="${esc(h.id)}">${esc(t('hooks.delete'))}</button></td></tr>`).join('')}</table>`
    : `<p class="muted">${esc(t('hooks.none'))}</p>`
  $('#deliveries').innerHTML = del.length
    ? `<table><tr><th>${t('th.when')}</th><th>${t('th.event')}</th><th>${t('th.result')}</th><th>${t('th.attempts')}</th><th>${t('th.http')}</th></tr>${del.slice(0, 30).map((d) => `<tr><td>${fmtDate(d.created_at)}</td><td>${esc(d.event)}</td><td>${esc(d.state)}${d.last_error ? ' · ' + esc(d.last_error) : ''}</td><td>${d.attempts}</td><td>${d.last_status || '—'}</td></tr>`).join('')}</table>`
    : `<p class="muted">${esc(t('hooks.noDeliveries'))}</p>`
}
$('#hookForm').addEventListener('submit', run(async (e) => {
  e.preventDefault()
  const f = e.target
  const h = await api('POST', '/v1/admin/webhooks', { url: f.url.value, events: f.events.value || '*', bot: f.bot.value, ...(f.auth.value.trim() ? { headers: f.auth.value } : {}) })
  $('#newHook').hidden = false
  $('#newHook').innerHTML = `<b>${esc(t('hooks.created'))}</b><code>${esc(h.secret)}</code><button class="small" data-copy="${esc(h.secret)}">${esc(t('copy'))}</button>`
  f.reset()
  await loadHooks()
}))
$('#hookList').addEventListener('submit', run(async (e) => {
  const f = e.target.closest('[data-hook-auth-form]')
  if (!f) return
  e.preventDefault()
  await api('PATCH', `/v1/admin/webhooks/${f.dataset.hookAuthForm}`, { headers: f.auth.value })
  toast(t('hooks.keySaved'))
  await loadHooks()
}))
$('#hookList').addEventListener('click', run(async (e) => {
  const tb = e.target.closest('[data-hook-test]')
  if (tb) {
    tb.disabled = true
    try {
      const r = await api('POST', `/v1/admin/webhooks/${tb.dataset.hookTest}/test`)
      if (r.ok) toast(t('hooks.testOk', r.status)); else toast(t('hooks.testFail', r.error || 'HTTP ' + r.status), true)
    } finally { tb.disabled = false }
    await loadHooks()
  }
  const ka = e.target.closest('[data-hook-auth]')
  if (ka) {
    const row = ka.closest('tr')
    if (row.nextElementSibling?.classList.contains('hook-edit')) { row.nextElementSibling.remove(); return }
    row.insertAdjacentHTML('afterend', `<tr class="hook-edit"><td colspan="6"><form class="row hook-auth" data-hook-auth-form="${esc(ka.dataset.hookAuth)}">
      <input name="auth" type="password" autocomplete="new-password" spellcheck="false" placeholder="${esc(t('hooks.authPh'))}" required>
      <button type="submit" class="small">${esc(t('save'))}</button>${ka.dataset.has === '1' ? `<button type="button" class="small danger" data-hook-auth-del="${esc(ka.dataset.hookAuth)}">${esc(t('hooks.keyRemove'))}</button>` : ''}</form></td></tr>`)
    row.nextElementSibling.querySelector('input').focus()
  }
  const kd = e.target.closest('[data-hook-auth-del]')
  if (kd && confirm(t('hooks.keyRemoveConfirm'))) { await api('PATCH', `/v1/admin/webhooks/${kd.dataset.hookAuthDel}`, { headers: '' }); toast(t('hooks.keyRemoved')); await loadHooks() }
  const g = e.target.closest('[data-hook-toggle]'); if (g) { await api('PATCH', `/v1/admin/webhooks/${g.dataset.hookToggle}`, { active: g.dataset.active !== '1' }); await loadHooks() }
  const d = e.target.closest('[data-hook-del]'); if (d && confirm(t('confirm.deleteHook'))) { await api('DELETE', `/v1/admin/webhooks/${d.dataset.hookDel}`); await loadHooks() }
}))

// ---------------------------------------------------------------- api vocabulary
let vocab = null
const VOCAB_METHODS = ['get', 'post', 'put', 'patch', 'delete']
const VOCAB_ORDER = ['Send', 'Messages', 'Chats', 'Bots', 'Contacts', 'Events', 'Webhooks', 'Admin']
async function loadApi() {
  $('#apiBase').textContent = ORIGIN + '/v1'
  await loadKeys()
  if (!vocab) { const r = await fetch('/openapi.json', { credentials: 'same-origin' }); vocab = await r.json() }
  renderVocab()
}
const vt = (s) => (TELEOPS_LANG === 'it' && TELEOPS_API_IT[s]) || s
function renderVocab() {
  const q = $('#apiFilter').value.trim().toLowerCase()
  const groups = {}
  let n = 0
  for (const [path, ops] of Object.entries(vocab.paths || {})) {
    for (const [m, op] of Object.entries(ops)) {
      if (!VOCAB_METHODS.includes(m)) continue
      if (!op.tags || !op.tags.length) continue // OAuth / discovery plumbing is not part of the API
      const tag = op.tags[0]
      const sum = vt(op.summary || '')
      if (q && !`${m} ${path} ${sum} ${op.summary || ''} ${vt(tag)}`.toLowerCase().includes(q)) continue
      ;(groups[tag] ||= []).push({ m, path, sum })
      n++
    }
  }
  $('#apiCount').textContent = t('api.count', n)
  const order = (g) => { const i = VOCAB_ORDER.indexOf(g); return i < 0 ? 99 : i }
  $('#apiVocab').innerHTML = Object.entries(groups).sort(([a], [b]) => order(a) - order(b)).map(([tag, ops]) => `<div class="card"><h4>${esc(vt(tag))} <span class="muted small">${ops.length}</span></h4><table>${ops.map((o) => `<tr><td class="m m-${o.m}">${o.m.toUpperCase()}</td><td><code>${esc(o.path)}</code><div class="muted small">${esc(o.sum)}</div></td></tr>`).join('')}</table></div>`).join('') || `<p class="muted">${esc(t('api.none'))}</p>`
}
$('#apiFilter').addEventListener('input', () => vocab && renderVocab())

// ---------------------------------------------------------------- service log (terminal)
const LEVEL_NAME = { 10: 'TRACE', 20: 'DEBUG', 30: 'INFO', 40: 'WARN', 50: 'ERROR', 60: 'FATAL' }
const LEVEL_MIN = { all: 0, info: 30, warn: 40, error: 50 }
const TERM_MAX = 2000
let logES = null
let logLive = true
let logEntries = []
let logPending = 0
const pad2 = (n) => String(n).padStart(2, '0')
function termTime(t) {
  const d = new Date(t)
  const hms = `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`
  return d.toDateString() === new Date().toDateString() ? hms : `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${hms}`
}
function termKv(data) {
  if (!data) return ''
  return Object.entries(data).map(([k, v]) => {
    const s = typeof v === 'string' ? v.split('\n')[0] : JSON.stringify(v)
    return `<span class="tk">${esc(k)}</span>=<span class="tv">${esc(s.length > 160 ? s.slice(0, 160) + '…' : s)}</span>`
  }).join(' ')
}
function termLine(e, idx) {
  const lv = Math.min(60, Math.floor(e.level / 10) * 10)
  const name = String(LEVEL_NAME[e.level] ?? e.level).padEnd(5)
  const mod = (e.mod ?? '').padEnd(7)
  return `<div class="tl lv-${lv}${e.data ? ' has' : ''}" data-i="${idx}"><span class="tt">${esc(termTime(e.t))}</span> <span class="tlv">${esc(name)}</span> <span class="tm">${esc(mod)}</span> <span class="tx">${esc(e.msg)}</span>${e.data ? ' ' + termKv(e.data) : ''}</div>`
}
function logMatches(e) {
  if (e.level < LEVEL_MIN[$('#logLevel').value]) return false
  const q = $('#logQ').value.trim().toLowerCase()
  return !q || `${e.mod ?? ''} ${e.msg} ${e.data ? JSON.stringify(e.data) : ''}`.toLowerCase().includes(q)
}
const termEl = () => $('#logList')
const termAtBottom = () => { const el = termEl(); return el.scrollHeight - el.scrollTop - el.clientHeight < 30 }
function termToBottom() { const el = termEl(); el.scrollTop = el.scrollHeight; logPending = 0; $('#logJump').hidden = true }
function termCount() { $('#logCount').textContent = logEntries.length ? t('log.count', num(logEntries.length)) : t('log.empty') }
function termRender() {
  termEl().innerHTML = logEntries.map(termLine).join('')
  termCount()
  termToBottom()
}
function termAppend(e) {
  const stick = termAtBottom()
  logEntries.push(e)
  termEl().insertAdjacentHTML('beforeend', termLine(e, logEntries.length - 1))
  if (logEntries.length > TERM_MAX) {
    // drop the oldest lines; re-render keeps data-i indexes consistent
    logEntries = logEntries.slice(-TERM_MAX)
    termEl().innerHTML = logEntries.map(termLine).join('')
  }
  termCount()
  if (stick) termToBottom()
  else { logPending++; $('#logJump').hidden = false; $('#logJump').textContent = t('log.jump', logPending) }
}
async function loadLogs() {
  const qs = new URLSearchParams({ level: $('#logLevel').value, limit: '1000' })
  const q = $('#logQ').value.trim()
  if (q) qs.set('q', q)
  const r = await api('GET', '/v1/admin/logs?' + qs)
  logEntries = r.entries
  termRender()
  if (logLive) startLogLive(); else stopLogLive()
}
function startLogLive() {
  if (logES) return
  logES = new EventSource('/v1/admin/logs/stream')
  logES.onmessage = (m) => {
    let e
    try { e = JSON.parse(m.data) } catch { return }
    if (logMatches(e)) termAppend(e)
  }
}
function stopLogLive() { if (logES) { logES.close(); logES = null } }
function setLive(on) {
  logLive = on
  $('#logLive').classList.toggle('on', on)
  $('#term').classList.toggle('live', on)
  if (on) { startLogLive(); termToBottom() } else stopLogLive()
}
termEl().addEventListener('click', (ev) => {
  const line = ev.target.closest('.tl.has')
  if (!line || window.getSelection()?.toString()) return
  const next = line.nextElementSibling
  if (next && next.classList.contains('tdet')) { next.remove(); line.classList.remove('open'); return }
  const e = logEntries[Number(line.dataset.i)]
  if (!e) return
  line.insertAdjacentHTML('afterend', `<pre class="tdet">${esc(JSON.stringify(e.data, null, 2))}</pre>`)
  line.classList.add('open')
})
termEl().addEventListener('scroll', () => { if (termAtBottom()) { logPending = 0; $('#logJump').hidden = true } })
$('#logJump').addEventListener('click', termToBottom)
let logQTimer = null
$('#logLevel').addEventListener('change', run(loadLogs))
$('#logQ').addEventListener('input', () => { clearTimeout(logQTimer); logQTimer = setTimeout(run(loadLogs), 300) })
$('#logLive').addEventListener('click', () => setLive(!logLive))
$('#logClear').addEventListener('click', () => { logEntries = []; termRender() })

// ---------------------------------------------------------------- updates (GitHub releases)
let updTimer = null
function renderUpdates(u) {
  $('#updCur').textContent = u.currentLabel || u.current
  $('#updLatest').textContent = u.latest ? u.latest.version : u.lastError ? t('upd.unknown') : t('upd.none')
  $('#updAuto').checked = !!u.auto
  $('#updAuto').disabled = u.mode === 'manual'
  let st = u.busy ? t('upd.installing') : u.restartNeeded ? t('upd.restartNeeded') : u.available ? t('upd.available', u.latest.version) : u.lastError ? '' : t('upd.uptodate')
  if (u.lastResult) st += (st ? ' · ' : '') + t('upd.last', `${fmtDate(u.lastResult.at)} — ${u.lastResult.message}`)
  if (u.lastError) st += (st ? ' · ' : '') + t('upd.error', u.lastError)
  $('#updState').textContent = st
  $('#updHint').textContent = u.mode !== 'manual' ? t('upd.hintGit', u.intervalMin, u.lastCheck ? fmtDate(u.lastCheck) : '—') : t('upd.hintManual')
  $('#updApply').hidden = !(u.available && u.mode !== 'manual' && !u.busy)
  $('#updNotes').hidden = !(u.latest && u.latest.notes)
  $('#updNotesText').textContent = u.latest?.notes ?? ''
  clearTimeout(updTimer)
  if (u.busy) updTimer = setTimeout(() => loadUpdates().catch(() => location.reload()), 3000)
}
async function loadUpdates() { renderUpdates(await api('GET', '/v1/admin/update')) }
$('#updCheck').addEventListener('click', run(async () => renderUpdates(await api('POST', '/v1/admin/update/check'))))
$('#updApply').addEventListener('click', run(async () => { renderUpdates(await api('POST', '/v1/admin/update/apply')); toast(t('upd.done')) }))
$('#updAuto').addEventListener('change', run(async (e) => { await api('PUT', '/v1/admin/settings', { autoUpdate: e.target.checked }); toast(t('saved')) }))

// ---------------------------------------------------------------- feedback · crash & malfunction reports
async function loadFeedback() {
  const r = await api('GET', '/v1/admin/feedback')
  $('#fbHint').innerHTML = esc(t('fb.hint', '')).replace('()', `(<a href="https://github.com/${esc(r.repo)}/issues" target="_blank" rel="noopener">${esc(r.repo)}</a>)`)
  $('#fbCode').textContent = r.installCode
  $$('input[name=crashReports]').forEach((i) => { i.checked = i.value === r.mode })
  $('#repList').innerHTML = r.pending.length
    ? r.pending.map((p) => `<div class="rep" data-id="${esc(p.id)}"><div class="rep-top"><span class="badge ${p.type === 'crash' ? 'bad' : 'warn'}">${esc(t('rep.' + p.type))}</span> <b>${esc(p.title)}</b> <span class="muted small">${p.count > 1 ? esc(t('rep.times', p.count)) + ' · ' : ''}${esc(fmtDate(p.last))}</span></div>
        <details><summary>${esc(t('rep.view'))}</summary><pre>${esc(p.detail)}</pre></details>
        <div class="row"><button type="button" class="small" data-rep="send">${esc(t('rep.send'))}</button><button type="button" class="small ghost" data-rep="discard">${esc(t('rep.discard'))}</button></div></div>`).join('')
    : `<p class="muted">${esc(t('rep.none'))}</p>`
  $('#fbSent').innerHTML = r.sent.length
    ? `<ul class="sent">${r.sent.map((s) => `<li><a href="${esc(s.url)}" target="_blank" rel="noopener">#${s.number}</a> ${esc(s.type === 'feedback' ? t('fb.' + (s.kind || 'other')) : t('rep.' + s.type))} — ${esc(s.title)} <span class="muted small">${esc(fmtDate(s.at))} · ${esc(t('fb.via.' + s.via))}${s.comment ? ' · ' + esc(t('fb.comment')) : ''}</span></li>`).join('')}</ul>`
    : `<p class="muted">${esc(t('fb.none'))}</p>`
}
$('#fbForm').addEventListener('submit', run(async (e) => {
  e.preventDefault()
  const f = e.target
  const btn = f.querySelector('button[type=submit]')
  btn.disabled = true
  try {
    const s = await api('POST', '/v1/admin/feedback', { kind: f.kind.value, title: f.title.value, message: f.message.value, diagnostics: f.diagnostics.checked })
    f.reset()
    toast(t('fb.sentOk', s.number))
    await loadFeedback()
  } finally { btn.disabled = false }
}))
$$('input[name=crashReports]').forEach((i) => i.addEventListener('change', run(async () => { await api('PUT', '/v1/admin/settings', { crashReports: i.value }); toast(t('saved')); await loadFeedback() })))
$('#repList').addEventListener('click', run(async (e) => {
  const b = e.target.closest('button[data-rep]')
  if (!b) return
  const id = b.closest('[data-id]').dataset.id
  b.disabled = true
  try {
    if (b.dataset.rep === 'send') { const s = await api('POST', `/v1/admin/reports/${id}/send`); toast(t(s.already ? 'rep.already' : 'fb.sentOk', s.number)) }
    else await api('DELETE', `/v1/admin/reports/${id}`)
  } finally { await loadFeedback().catch(() => {}) }
}))

// ---------------------------------------------------------------- license (Polar) — hidden while TeleOps is free
function renderLicense(l) {
  $('#licState').textContent = !l.enabled ? '' : l.plan === 'licensed' ? `${t('lic.ok')} · ${l.key}${l.customer ? ' · ' + l.customer : ''}${l.expiresAt ? ' · ' + fmtDate(l.expiresAt) : ''}` : t('lic.no')
  $('#licRemove').hidden = !(l.enabled && l.key)
}
async function loadLicense() { renderLicense(await api('GET', '/v1/admin/license')) }
$('#licForm').addEventListener('submit', run(async (e) => { e.preventDefault(); renderLicense(await api('POST', '/v1/admin/license', { key: e.target.key.value })); e.target.reset(); toast(t('lic.ok')) }))
$('#licRemove').addEventListener('click', run(async () => renderLicense(await api('DELETE', '/v1/admin/license'))))

// ---------------------------------------------------------------- settings
// ---------------------------------------------------------------- voice messages → text (Settings → Voice)
let voiceCfg = null
let voiceTimer = null
function voiceShow() {
  const f = $('#voiceForm')
  const e = f.querySelector('input[name=engine]:checked')?.value || 'off'
  $$('[data-voice]', f).forEach((d) => { d.hidden = d.dataset.voice === 'on' ? e === 'off' : d.dataset.voice !== e })
  $('#voiceEngineHint').textContent = t('voice.eh.' + e)
  const p = voiceCfg?.providers?.[f.provider.value]
  f.apiUrl.placeholder = p?.url || 'https://…/v1'
  f.apiModel.placeholder = p?.model || ''
  const all = f.querySelector('input[name=autoMode]:checked')?.value !== 'asked'
  $('#voiceWhichHint').textContent = t(all ? 'voice.whichAllHint' : 'voice.whichAskedHint')
}
function voiceLocalRender(c) {
  const L = c.local
  const ins = L.install || {}
  const m = L.model
  let html
  if (ins.state === 'running') html = `<span class="muted">⏳ ${esc(t('voice.installing', t('voice.step.' + (ins.step || 'uv'))))}</span>`
  else if (L.available) html = `<span class="ok-text">✓ ${esc(t('voice.localOk', L.version || '', t('voice.src.' + (L.source || 'system'), L.python)))}</span> <span class="muted">${esc(t('voice.localModel'))}</span>`
  else if (L.installable) html = `<span class="err-text">${esc(t('voice.localMissing'))}</span> <span class="muted">${esc(t('voice.installHint'))}</span>`
  else html = `<span class="err-text">${esc(t('voice.installNo', c.platform))}</span>`
  if (ins.state === 'error') html += `<br><span class="err-text">${esc(ins.error || '')}</span>`
  if (ins.state !== 'running' && m && m.name === c.model) {
    if (m.state === 'loading') html += `<br><span class="muted">⏳ ${esc(t('voice.modelLoading', m.name))}</span>`
    else if (m.state === 'ready') html += `<br><span class="ok-text">✓ ${esc(t('voice.modelReady', m.name))}</span>`
    else if (m.state === 'error') html += `<br><span class="err-text">${esc(t('voice.modelError', m.name, m.error || ''))}</span>`
  }
  $('#voiceLocal').innerHTML = html
  const btn = $('#voiceInstall')
  $('#voiceInstallRow').hidden = !L.installable || (L.available && ins.state !== 'running')
  btn.disabled = ins.state === 'running'
  btn.textContent = t(ins.state === 'error' ? 'voice.installRetry' : 'voice.install')
  // follow the install and the model download
  clearTimeout(voiceTimer)
  if (ins.state === 'running' || m?.state === 'loading') {
    voiceTimer = setTimeout(async () => {
      if (!location.hash.startsWith('#settings/voice')) return
      try {
        const x = await api('GET', '/v1/admin/voice')
        if (ins.state === 'running' && x.local.install?.state !== 'running') return loadVoice() // finished: the engine switched to faster-whisper
        voiceCfg = x
        voiceLocalRender(x)
      } catch {}
    }, 2500)
  }
}
async function loadVoice() {
  const c = (voiceCfg = await api('GET', '/v1/admin/voice'))
  const f = $('#voiceForm')
  $$('input[name=engine]', f).forEach((r) => { r.checked = r.value === c.engine })
  f.model.innerHTML = c.models.map((m) => `<option value="${esc(m)}">${esc(m)}</option>`).join('')
  if (!c.models.includes(c.model)) f.model.insertAdjacentHTML('beforeend', `<option value="${esc(c.model)}">${esc(c.model)}</option>`)
  f.model.value = c.model
  f.provider.value = c.provider
  f.apiUrl.value = c.apiUrl || ''
  f.apiModel.value = c.apiModel || ''
  f.apiKey.value = ''
  f.apiKey.placeholder = c.apiKeySet ? t('secret.saved') : ''
  f.command.value = c.command || ''
  f.language.value = c.language || 'auto'
  if (!f.language.value) f.language.value = 'auto'
  $$('input[name=autoMode]', f).forEach((r) => { r.checked = r.value === (c.auto ? 'all' : 'asked') })
  voiceLocalRender(c)
  $('#voiceTestOut').textContent = ''
  voiceShow()
}
$('#voiceForm').addEventListener('change', (e) => { if (['engine', 'provider', 'autoMode'].includes(e.target.name)) voiceShow() })
$('#voiceForm').addEventListener('submit', run(async (e) => {
  e.preventDefault()
  const f = e.target
  const engine = f.querySelector('input[name=engine]:checked')?.value || 'off'
  const body = {
    engine, model: f.model.value, provider: f.provider.value, apiUrl: f.apiUrl.value.trim(), apiModel: f.apiModel.value.trim(), command: f.command.value.trim(), language: f.language.value,
    auto: f.querySelector('input[name=autoMode]:checked')?.value !== 'asked',
  }
  if (f.apiKey.value.trim()) body.apiKey = f.apiKey.value.trim()
  await api('PUT', '/v1/admin/voice', body)
  toast(t('saved'))
  await loadVoice()
}))
// one click: TeleOps installs faster-whisper in its own folder, then uses it with the chosen model
$('#voiceInstall').addEventListener('click', run(async () => {
  const c = (voiceCfg = await api('POST', '/v1/admin/voice/install', { model: $('#voiceForm').model.value }))
  voiceLocalRender(c)
}))
$('#voiceTest').addEventListener('click', run(async () => {
  const b = $('#voiceTest'), out = $('#voiceTestOut')
  b.disabled = true
  out.className = 'small muted'
  out.textContent = t('voice.testing')
  try {
    const r = await api('POST', '/v1/admin/voice/test')
    out.className = 'small'
    out.innerHTML = r.sample
      ? `<span class="ok-text">✓ ${esc(t('voice.testOk', r.engine, r.sample.chat, r.sample.seconds ?? '?', (r.sample.ms / 1000).toFixed(1)))}</span><br>“${esc(r.sample.text || t('voice.noWords'))}”`
      : `<span class="ok-text">✓ ${esc(t('voice.testReady', r.engine))}</span>`
  } catch (x) {
    out.className = 'small err-text'
    out.textContent = x.message
  } finally { b.disabled = false; if (voiceCfg?.engine === 'local') loadVoice().catch(() => {}) }
}))
// ---------------------------------------------------------------- backup (Settings → Backup)
let bakPickPath = null
const fmtSize = (n) => (n >= 1e9 ? (n / 1e9).toFixed(1) + ' GB' : n >= 1e6 ? (n / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1e3)) + ' KB')
function bakRender(c) {
  const f = $('#bakForm')
  $$('input[name=every]', f).forEach((r) => { r.checked = r.value === c.every })
  f.folder.value = c.folder
  f.keep.value = c.keep
  f.password.value = ''
  f.password.placeholder = c.passwordSet ? t('secret.saved') : ''
  $('#bakNewName').placeholder = t('bak.newName')
  $('#bakFilePw').placeholder = t('bak.filePw')
  $('#bakPwRemove').hidden = !c.passwordSet
  $('#bakPwHint').textContent = t(c.passwordSet ? 'bak.pwOn' : 'bak.pwOff')
  $('#bakFolderHint').textContent = c.folder === c.defaultFolder ? t('bak.folderDefault') : ''
  const s = c.state
  const lines = []
  if (s.busy) lines.push(`<span class="muted">⏳ ${esc(t(s.busy === 'restore' ? 'bak.restoring' : 'bak.working'))}</span>`)
  lines.push(s.lastAt ? `<span class="ok-text">✓ ${esc(t('bak.last', fmtDate(s.lastAt), s.lastSize ? fmtSize(s.lastSize) : '?'))}</span>` : `<span class="muted">${esc(t('bak.never'))}</span>`)
  if (s.lastError && (!s.lastAt || s.lastErrorAt > s.lastAt)) lines.push(`<span class="err-text">${esc(t('bak.error', fmtDate(s.lastErrorAt), s.lastError))}</span>`)
  lines.push(`<span class="muted">${esc(c.every === 'off' ? t('bak.autoOff') : t('bak.next', fmtDate(Math.max(s.nextAt || 0, Date.now()))))}</span>`)
  $('#bakStatus').innerHTML = lines.join('<br>')
  $('#bakFiles').innerHTML = c.files.length
    ? `<table><tr><th>${esc(t('bak.th.date'))}</th><th>${esc(t('bak.th.kind'))}</th><th>${esc(t('bak.th.size'))}</th><th></th></tr>${c.files.map((x) => `<tr><td>${esc(fmtDate(x.createdAt))}${x.encrypted ? ` <span title="${esc(t('bak.locked'))}">🔒</span>` : ''}</td><td>${esc(t('bak.kind.' + (x.kind || 'manual')))}</td><td>${esc(fmtSize(x.size))}</td><td class="nowrap"><button type="button" class="small ghost" data-bak-dl="${esc(x.name)}">${esc(t('bak.dl'))}</button> <button type="button" class="small danger" data-bak-restore="${esc(x.name)}">${esc(t('bak.restoreOne'))}</button></td></tr>`).join('')}</table>`
    : `<p class="muted small">${esc(t('bak.none'))}</p>`
}
async function loadBackup() { bakRender(await api('GET', '/v1/admin/backup')) }
// downloads go through fetch so an error shows here instead of an error page
const bakFetchFile = (url, btn) => fetchFile(url, btn, 'teleops-backup.teleops')
async function fetchFile(url, btn, fallbackName) {
  const label = btn.textContent
  btn.disabled = true
  btn.textContent = t('bak.preparing')
  try {
    const r = await fetch(url, { credentials: 'same-origin', headers: { 'accept-language': TELEOPS_LANG } })
    if (!r.ok) { let j = null; try { j = await r.json() } catch {} ; throw new Error(j?.error?.message || `HTTP ${r.status}`) }
    const name = (r.headers.get('content-disposition') || '').match(/filename="([^"]+)"/)?.[1] || fallbackName
    const a = document.createElement('a')
    a.href = URL.createObjectURL(await r.blob())
    a.download = name
    document.body.appendChild(a)
    a.click()
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove() }, 1000)
  } finally { btn.disabled = false; btn.textContent = label }
}
function bakRestored(r) {
  const out = $('#bakOut')
  out.className = 'small'
  out.innerHTML = `<span class="ok-text">✓ ${esc(t('bak.restored', fmtDate(r.manifest.createdAt), r.counts.accounts ?? 0, r.counts.messages ?? 0, r.safetyCopy))}</span><br>${esc(t(r.restarting ? 'bak.restarting' : 'bak.restartNeeded'))}`
  if (!r.restarting) return
  // the old process answers for a moment: wait, then until the new one is up
  const t0 = Date.now()
  const poll = () => fetch('/healthz', { cache: 'no-store' }).then((x) => (x.ok ? location.reload() : Promise.reject())).catch(() => { if (Date.now() - t0 < 180_000) setTimeout(poll, 2000) })
  setTimeout(poll, 5000)
}
function bakBusy(on) { $$('#bakForm button').forEach((b) => { b.disabled = on }) }
$('#bakForm').addEventListener('submit', run(async (e) => {
  e.preventDefault()
  const f = e.target
  const body = { every: f.querySelector('input[name=every]:checked')?.value || 'off', folder: f.folder.value.trim(), keep: Number(f.keep.value) || 10 }
  if (f.password.value) body.password = f.password.value
  bakRender(await api('PUT', '/v1/admin/backup', body))
  toast(t('saved'))
}))
$('#bakPwRemove').addEventListener('click', run(async () => { bakRender(await api('PUT', '/v1/admin/backup', { removePassword: true })); toast(t('saved')) }))
$('#bakNow').addEventListener('click', run(async () => {
  bakBusy(true)
  try { const r = await api('POST', '/v1/admin/backup/now'); bakRender(r); toast(t('bak.saved', r.file)) } finally { bakBusy(false) }
}))
$('#bakDownload').addEventListener('click', run(async () => { await bakFetchFile('/v1/admin/backup/download', $('#bakDownload')); loadBackup().catch(() => {}) }))
$('#bakFiles').addEventListener('click', run(async (e) => {
  const dl = e.target.closest('[data-bak-dl]')
  if (dl) return bakFetchFile('/v1/admin/backup/files/' + encodeURIComponent(dl.dataset.bakDl), dl)
  const rs = e.target.closest('[data-bak-restore]')
  if (!rs || !confirm(t('bak.confirm'))) return
  bakBusy(true)
  try { bakRestored(await api('POST', '/v1/admin/backup/files/' + encodeURIComponent(rs.dataset.bakRestore) + '/restore', { password: $('#bakFilePw').value })) } finally { bakBusy(false) }
}))
$('#bakRestore').addEventListener('click', run(async () => {
  const file = $('#bakFile').files[0]
  if (!file) throw new Error(t('bak.pickFile'))
  if (!confirm(t('bak.confirm'))) return
  bakBusy(true)
  const out = $('#bakOut')
  out.className = 'small muted'
  out.textContent = t('bak.restoring')
  try {
    const r = await fetch('/v1/admin/backup/restore', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/octet-stream', 'accept-language': TELEOPS_LANG, 'x-backup-password': encodeURIComponent($('#bakFilePw').value) }, body: file })
    let j = null
    try { j = await r.json() } catch {}
    if (!r.ok) throw new Error(j?.error?.message || `HTTP ${r.status}`)
    bakRestored(j)
  } catch (x) { out.className = 'small err-text'; out.textContent = x.message; throw x } finally { bakBusy(false) }
}))
// folder picker: the folders of the server
async function bakPick(p) {
  const l = await api('GET', '/v1/admin/backup/folders' + (p ? '?path=' + encodeURIComponent(p) : ''))
  bakPickPath = l.path
  $('#bakPath').textContent = l.path
  $('#bakUp').disabled = !l.parent
  $('#bakUp').dataset.to = l.parent || ''
  $('#bakRoots').innerHTML = l.roots.length > 1 ? l.roots.map((r) => `<button type="button" class="ghost small" data-pick="${esc(r)}">${esc(r)}</button>`).join('') : ''
  $('#bakDirs').innerHTML = l.dirs.length ? l.dirs.map((d) => `<li><button type="button" data-pick-sub="${esc(d)}">📁 ${esc(d)}</button></li>`).join('') : `<li class="muted">${esc(t('bak.empty'))}</li>`
}
$('#bakBrowse').addEventListener('click', run(async () => {
  const pk = $('#bakPicker')
  if (!pk.hidden) { pk.hidden = true; return }
  await bakPick($('#bakForm').folder.value.trim()).catch(() => bakPick(''))
  pk.hidden = false
}))
$('#bakUp').addEventListener('click', run(async (e) => { if (e.currentTarget.dataset.to) await bakPick(e.currentTarget.dataset.to) }))
$('#bakPicker').addEventListener('click', run(async (e) => {
  const sub = e.target.closest('[data-pick-sub]')
  if (sub) return bakPick(bakPickPath.replace(/[\\/]+$/, '') + (bakPickPath.includes('\\') ? '\\' : '/') + sub.dataset.pickSub)
  const root = e.target.closest('[data-pick]')
  if (root) return bakPick(root.dataset.pick)
}))
$('#bakMkdir').addEventListener('click', run(async () => {
  const name = $('#bakNewName').value.trim()
  if (!name) return
  const l = await api('POST', '/v1/admin/backup/folders', { parent: bakPickPath, name })
  $('#bakNewName').value = ''
  await bakPick(l.path)
}))
$('#bakUse').addEventListener('click', run(async () => {
  bakRender(await api('PUT', '/v1/admin/backup', { folder: bakPickPath }))
  $('#bakPicker').hidden = true
  toast(t('bak.folderSet', bakPickPath))
}))
async function loadSettings() {
  loadSessions().catch(() => {})
  loadOwner().catch((e) => { $('#ownerState').textContent = e.message })
  const s = await api('GET', '/v1/admin/settings')
  const f = $('#setForm')
  for (const [k, v] of Object.entries(s)) { const el = f.elements[k]; if (!el) continue; if (el.type === 'checkbox') el.checked = !!v; else el.value = v }
  const me = await api('GET', '/auth/me')
  $('#pwState').textContent = t(me.passwordSet ? 'pw.set' : 'pw.unset')
  if (!state.overview) await loadOverview()
  const o = state.overview
  showAppearance(s.appearance, o.theme)
  $('#svcInfo').textContent = t('svc.info', o.versionLabel || o.version, Math.round(o.uptimeSec / 60), o.database.dialect, o.language?.server === 'it' ? 'Italiano' : 'English')
}
function showAppearance(value, th) {
  $$('#appearCard input[name=appearance]').forEach((r) => { r.checked = r.value === value })
  $('#appearInfo').innerHTML = th && th.desktop ? t('appear.sysDesktop', esc(th.desktop)) : t('appear.sysOs')
}
$$('#appearCard input[name=appearance]').forEach((r) => r.addEventListener('change', run(async () => {
  const s = await api('PUT', '/v1/admin/settings', { appearance: r.value })
  window.TELEOPS_THEME_CHECK?.()
  state.overview = null
  await loadOverview()
  showAppearance(s.appearance, state.overview.theme)
  toast(t('saved'))
})))
$('#setForm').addEventListener('submit', run(async (e) => {
  e.preventDefault()
  const f = e.target
  const body = {}
  for (const el of f.elements) { if (!el.name) continue; body[el.name] = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value }
  await api('PUT', '/v1/admin/settings', body)
  toast(t('saved'))
  await loadOverview()
  loadSettings()
}))
$('#pwForm').addEventListener('submit', run(async (e) => { e.preventDefault(); await api('PUT', '/v1/admin/password', { password: e.target.password.value }); e.target.reset(); toast(t('pw.done')); loadSettings() }))
$('#pwClear').addEventListener('click', run(async () => { if (!confirm(t('confirm.pwClear'))) return; await api('DELETE', '/v1/admin/password'); loadSettings() }))
$('#mkLink').addEventListener('click', run(async () => { const r = await api('POST', '/v1/admin/login-link'); $('#linkOut').hidden = false; $('#linkOut').innerHTML = `<code>${esc(r.url)}</code><button class="small" data-copy="${esc(r.url)}">${esc(t('copy'))}</button>` }))
$('#restart').addEventListener('click', run(async () => { if (!confirm(t('confirm.restart'))) return; await api('POST', '/v1/admin/restart'); toast(t('svc.restarting')); setTimeout(() => location.reload(), 5000) }))

// ---------------------------------------------------------------- boot
const loaders = { bots: loadOverview, 'connect/mcp': loadConnect, 'connect/api': loadApi, 'connect/hooks': loadHooks, 'settings/general': loadSettings, 'settings/db': loadDb, 'settings/log': loadLogs, 'settings/voice': () => loadVoice().catch((e) => { $('#voiceTestOut').textContent = e.message }), 'settings/updates': loadUpdates, 'settings/feedback': loadFeedback, 'settings/backup': loadBackup, 'settings/license': loadLicense }
;(async () => {
  try { await loadOverview() } catch (e) { toast(e.message, true) }
  startEvents()
  let route = location.hash.slice(1)
  route = LEGACY[route] ?? route
  const [tab, sub, item] = route.split('/')
  if (tab && $('#' + tab)?.classList.contains('tab')) showTab(tab, sub, item)
})()
