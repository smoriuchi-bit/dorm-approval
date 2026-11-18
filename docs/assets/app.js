/* 寮の申請・承認システム 画面側の処理 */
(() => {
'use strict';

/* ---------- helpers ---------- */
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = n => String(n).padStart(2, '0');
const fmt = (s, time = true) => s ? String(s).slice(0, time ? 16 : 10).replace(/-/g, '/') : '';
const fmtJa = s => { if (!s) return ''; const [y, m, d] = String(s).slice(0, 10).split('-').map(Number); return `${y}年${m}月${d}日`; };
const fmtVal = (kind, v) => {
  if (v === undefined || v === null || v === '') return '—';
  if (kind === 'datetime') return String(v).replace('T', ' ').replace(/-/g, '/');
  if (kind === 'date') return String(v).replace(/-/g, '/');
  return String(v);
};
const surname = n => (String(n || '').trim().split(/[\s　]+/)[0] || '').slice(0, 3);
const ROLE = { student: '寮生', staff: '職員', guardian: '保護者' };
const KIND = { text: '1行テキスト', textarea: '複数行テキスト', date: '日付', datetime: '日時', tel: '電話番号', number: '数値' };
const STATUS = { pending: '承認待ち', approved: '許可', rejected: '非承認', withdrawn: '取り下げ' };
const STEP = { pending: '承認待ち', approved: '承認', rejected: '非承認', closed: '—' };
const MAILST = { sent: '送信済み', logged: '記録のみ', failed: '送信失敗', skipped: '宛先なし', sending: '送信中' };
let toastT;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 3600); }

/* ---------- server ---------- */
const S = { org: '', me: null, people: [], types: [], routes: [], requests: [], needsInstall: false, mailMode: '' };
const SESSION_KEY = 'dorm-session';
const getSession = () => { try { return localStorage.getItem(SESSION_KEY) || ''; } catch { return ''; } };
const setSession = t => { try { if (t) localStorage.setItem(SESSION_KEY, t); else localStorage.removeItem(SESSION_KEY); } catch {} };
async function api(a, data) {
  if (!window.DORM_API || /XXXX/.test(window.DORM_API)) throw new Error('config.js にApps ScriptのURLが書かれていません。管理者は README の手順4を確認してください。');
  const body = JSON.stringify(Object.assign({}, data || {}, { a, session: getSession() }));
  let res;
  // text/plain で送ると、Apps Script へ追加の確認なしで届きます
  try { res = await fetch(window.DORM_API, { method: 'POST', body, redirect: 'follow' }); }
  catch { throw new Error('サーバーにつながりません。通信状況を確かめてください。'); }
  let j = null;
  try { j = await res.json(); } catch {}
  if (!j) throw new Error('サーバーから正しい返事がありませんでした。Apps Script の公開設定（アクセスできるユーザー：全員）を確認してください。');
  if (j.error) {
    if (j.code === 401 && a !== 'login' && a !== 'change_password') { setSession(''); if (S.me) { S.me = null; render(); } }
    throw new Error(j.error);
  }
  if (j.token) setSession(j.token);
  return j;
}
async function load() {
  const d = await api('bootstrap');
  Object.assign(S, { people: [], types: [], routes: [], requests: [] }, d);
}
async function refresh(animate = true) {
  try { await load(); } catch (e) { toast(e.message); return; }
  render(animate);
}

const appBase = () => (location.origin + location.pathname.replace(/[^/]*$/, '')).replace(/\/+$/, '');

/* ---------- lookups ---------- */
const me = () => S.me;
const isStaff = () => S.me && S.me.role === 'staff';
const isAdmin = () => isStaff() && S.me.isAdmin;
const person = id => S.people.find(p => p.id === Number(id)) || null;
const staff = () => S.people.filter(p => p.role === 'staff' && p.active !== false);
const students = () => S.people.filter(p => p.role === 'student' && p.active !== false);
const reqById = id => S.requests.find(r => r.id === Number(id)) || null;
const pendingFor = pid => S.requests.filter(r => r.status === 'pending' && r.steps.some(s => s.approverId === pid && s.status === 'pending'));

/* ---------- routing ---------- */
let view = '';
const ap = { tab: 'pending', focus: 0 };
const hist = { status: '', type: '', q: '', open: 0 };
const cls = { student: '', type: '', status: '', from: '', to: '' };
const applyState = { typeId: 0, studentId: 0, values: {} };
const commentDraft = {};
let setupTab = 'types';
const mailState = { list: null, open: 0, loading: false };
const cfgState = { data: null, loading: false };
async function loadCfg() {
  cfgState.loading = true;
  try { cfgState.data = await api('get_settings'); } catch (e) { toast(e.message); cfgState.data = { org: S.org, appUrl: '', fromName: '', replyTo: '', quota: '—' }; }
  cfgState.loading = false; if (view === 'setup') renderMain();
}

function viewsFor() {
  if (!S.me) return [];
  if (S.me.role === 'student') return [['apply', '申請する'], ['history', '申請一覧']];
  if (S.me.role === 'guardian') return [['history', '申請一覧']];
  const v = [['inbox', '承認者画面'], ['apply', '代理申請'], ['history', '申請一覧']];
  if (S.me.isAdmin) v.push(['mails', '送信メール'], ['setup', '設定']);
  return v;
}
function readHash() {
  const h = location.hash.slice(1);
  const allowed = viewsFor().map(v => v[0]);
  ap.focus = 0;
  const m = h.match(/^r-(\d+)$/);
  if (m) {
    if (isStaff()) { view = 'inbox'; ap.focus = Number(m[1]); }
    else { view = 'history'; hist.open = Number(m[1]); }
    return;
  }
  if (allowed.includes(h)) view = h;
  else view = allowed[0] || '';
}
function go(v) { if (location.hash !== '#' + v) location.hash = v; else { readHash(); render(); } }
window.addEventListener('hashchange', () => { readHash(); render(); window.scrollTo(0, 0); });

/* ---------- top-level render ---------- */
const app = $('#app');
const seen = new Set(); let painted = false;
function render(animate = false) {
  const reset = new URLSearchParams(location.search).get('reset');
  document.title = `${S.org} 寮の申請・承認`;
  if (S.needsInstall) return renderInstall();
  if (reset) return renderReset(reset);
  if (!S.me) return renderLogin();
  if (!viewsFor().some(v => v[0] === view)) readHash();
  const cnt = pendingFor(S.me.id).length;
  app.innerHTML = `<header class="top"><div class="top-in">
      <div class="brand"><h1>寮の申請・承認</h1><p>${esc(S.org)}</p></div>
      <div class="userbox"><span><b>${esc(S.me.name)}</b>（${esc(S.me.title || ROLE[S.me.role])}${S.me.room ? '・' + esc(S.me.room) : ''}）</span>
        <button class="btn btn-sm" data-act="pw" type="button">パスワード変更</button><button class="btn btn-sm" data-act="logout" type="button">ログアウト</button></div>
    </div>
    <nav class="tabs" aria-label="画面の切り替え">${viewsFor().map(([k, l]) => `<button class="tab" type="button" data-act="go" data-view="${k}" aria-current="${view === k ? 'page' : 'false'}">${l}${k === 'inbox' && cnt ? ` <span class="count">${cnt}</span>` : ''}</button>`).join('')}</nav>
  </header><main id="main"></main>`;
  renderMain(animate);
}
function renderMain(animate = false) {
  const main = $('#main'); if (!main) return;
  const f = { apply: viewApply, inbox: viewInbox, history: viewHistory, mails: viewMails, setup: viewSetup }[view];
  main.innerHTML = f ? f() : '';
  main.querySelectorAll('.seal[data-k]').forEach(el => {
    const k = el.dataset.k;
    if (!seen.has(k)) { seen.add(k); if (animate && painted) el.classList.add('fresh'); }
  });
  painted = true;
}

/* ---------- login / install / reset ---------- */
function authShell(inner) {
  app.innerHTML = `<div class="auth"><h1>寮の申請・承認</h1><p class="org">${esc(S.org)}</p><div class="panel">${inner}</div></div>`;
}
let authMode = 'login';
function renderLogin() {
  if (authMode === 'forgot') {
    authShell(`<form id="forgotForm"><p class="small" style="margin-top:0">登録されたメールアドレスを入力してください。パスワードを決めるためのメールを送ります。初めて使うときも、ここから設定できます。</p>
      <label class="fld"><span>メールアドレス</span><input type="email" name="email" autocomplete="username" required></label>
      <p class="err" id="authErr"></p><button class="btn btn-primary btn-wide">メールを送る</button></form>
      <p class="sub"><button class="btn-link" type="button" data-act="toLogin">ログイン画面にもどる</button></p>`);
  } else {
    authShell(`<form id="loginForm"><label class="fld"><span>メールアドレス</span><input type="email" name="email" autocomplete="username" required></label>
      <label class="fld"><span>パスワード</span><input type="password" name="password" autocomplete="current-password" required></label>
      <p class="err" id="authErr"></p><button class="btn btn-primary btn-wide">ログイン</button></form>
      <p class="sub"><button class="btn-link" type="button" data-act="toForgot">パスワードを忘れた・初めて使う</button></p>`);
  }
  setTimeout(() => { const i = $('#app input'); i && i.focus(); }, 0);
}
function renderReset(token) {
  authShell(`<form id="resetForm" data-token="${esc(token)}"><p class="small" style="margin-top:0">新しいパスワードを決めてください（8文字以上）。</p>
    <label class="fld"><span>新しいパスワード</span><input type="password" name="password" autocomplete="new-password" minlength="8" required></label>
    <label class="fld"><span>もう一度</span><input type="password" name="password2" autocomplete="new-password" minlength="8" required></label>
    <p class="err" id="authErr"></p><button class="btn btn-primary btn-wide">パスワードを設定してログイン</button></form>`);
}
function renderInstall() {
  app.innerHTML = `<div class="auth" style="max-width:520px"><h1>初期設定</h1><p class="org">最初の管理者（職員）を登録します。この画面は最初の1回だけ表示されます。</p><div class="panel">
    <form id="installForm">
      <label class="fld"><span>学校・寮の名前</span><input type="text" name="org" value="創志学園高校" required></label>
      <div class="grid2"><label class="fld"><span>あなたの氏名（姓と名のあいだに空白）</span><input type="text" name="name" required></label>
      <label class="fld"><span>役職</span><input type="text" name="title" placeholder="例：寮監"></label></div>
      <label class="fld"><span>メールアドレス（ログインに使います）</span><input type="email" name="email" autocomplete="username" required></label>
      <label class="fld"><span>パスワード（8文字以上）</span><input type="password" name="password" autocomplete="new-password" minlength="8" required></label>
      <p class="err" id="authErr"></p><button class="btn btn-primary btn-wide">登録して始める</button>
    </form></div></div>`;
}
document.addEventListener('submit', async e => {
  const f = e.target; if (!['loginForm', 'forgotForm', 'resetForm', 'installForm'].includes(f.id)) return;
  e.preventDefault();
  const fd = Object.fromEntries(new FormData(f).entries());
  const err = $('#authErr'); const btn = f.querySelector('button'); err.textContent = ''; btn.disabled = true;
  try {
    if (f.id === 'loginForm') await api('login', fd);
    if (f.id === 'installForm') await api('install', { ...fd, appUrl: appBase() });
    if (f.id === 'forgotForm') { const r = await api('forgot', fd); f.innerHTML = `<p>${esc(r.message)}</p><p class="small muted">メールが届かないときは、迷惑メールフォルダも確認してください。</p>`; return; }
    if (f.id === 'resetForm') {
      if (fd.password !== fd.password2) throw new Error('2つのパスワードが一致しません。');
      await api('setpw', { token: f.dataset.token, password: fd.password });
      history.replaceState(null, '', location.pathname);
    }
    await load(); readHash(); render();
  } catch (x) { err.textContent = x.message; btn.disabled = false; }
});

/* ---------- seals ---------- */
function sealHtml(s, rid) {
  let seal;
  const md = s.decidedAt ? `${Number(s.decidedAt.slice(5, 7))}/${Number(s.decidedAt.slice(8, 10))}` : '';
  if (s.status === 'approved') seal = `<span class="seal" data-k="${rid}:${s.approverId}:${esc(s.decidedAt)}" title="${esc(s.name)} 承認 ${esc(fmt(s.decidedAt))}">${esc(surname(s.name))}<span class="d">${md}</span></span>`;
  else if (s.status === 'rejected') seal = `<span class="seal rejected" title="非承認">否<span class="d">${esc(surname(s.name))}</span></span>`;
  else if (s.status === 'pending') seal = `<span class="seal pending">承認待ち</span>`;
  else seal = `<span class="seal closed">—</span>`;
  return `<div class="step"><span class="ttl">${esc(s.title || '')}</span>${seal}<span class="nm">${esc(s.name)}</span></div>`;
}
function routeHtml(steps, rid = 0) {
  if (!steps.length) return '<p class="muted small">承認者が登録されていません。</p>';
  return `<p class="route-mode">全員に同時に依頼・全員の承認がそろえば許可</p><div class="route">${steps.map(s => sealHtml(s, rid)).join('')}</div>`;
}
const mini = r => `<span class="mini">${r.steps.map(s => `<i class="${s.status}" title="${esc(s.name)}：${STEP[s.status] || ''}"></i>`).join('')}</span>`;
const sumText = r => esc(r.fields.slice(0, 2).map(f => fmtVal(f.kind, f.value)).join('／'));
const table = (heads, rows) => `<div class="tablewrap"><table class="list"><thead><tr>${heads.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>`;

/* ---------- 申請する ---------- */
function viewApply() {
  const cur = me();
  const head = `<h2 class="view-title">${isStaff() ? '代理申請' : '申請する'}</h2><p class="lead">申請の種類を選び、必要な項目を入力してください。送信すると承認者全員にメールが届きます。</p>`;
  const ts = S.types.filter(t => t.active);
  if (!ts.length) return head + `<div class="panel">申請の種類がまだ登録されていません。${isAdmin() ? '「設定」から追加してください。' : '寮の先生に連絡してください。'}</div>`;
  if (!ts.find(t => t.id === applyState.typeId)) { applyState.typeId = ts[0].id; applyState.values = {}; }
  const t = ts.find(x => x.id === applyState.typeId);
  let who;
  if (cur.role === 'student') { applyState.studentId = cur.id; who = `<div class="fld"><span>申請者</span><div style="padding:9px 0">${esc(cur.name)}${cur.room ? '（' + esc(cur.room) + '）' : ''}</div></div>`; }
  else {
    const ss = students();
    if (!ss.find(s => s.id === applyState.studentId)) applyState.studentId = ss[0] ? ss[0].id : 0;
    who = `<label class="fld"><span>申請する寮生</span><select data-ap="student">${ss.map(s => `<option value="${s.id}"${s.id === applyState.studentId ? ' selected' : ''}>${esc(s.name)}${s.room ? '（' + esc(s.room) + '）' : ''}</option>`).join('')}</select></label>`;
  }
  const route = S.routes.find(r => r.id === t.routeId);
  const steps = route ? route.steps.filter(s => s.active).map(s => ({ ...s, status: 'pending' })) : [];
  const fields = t.fields.map((f, i) => {
    const v = applyState.values[i] ?? '';
    const lab = `<span>${esc(f.label)}${f.required ? '<b class="req" aria-hidden="true">*</b>' : ''}</span>`;
    const req = f.required ? ' required aria-required="true"' : '';
    if (f.kind === 'textarea') return `<label class="fld">${lab}<textarea rows="3" data-fv="${i}"${req}>${esc(v)}</textarea></label>`;
    const ty = { date: 'date', datetime: 'datetime-local', tel: 'tel', number: 'number' }[f.kind] || 'text';
    return `<label class="fld">${lab}<input type="${ty}" data-fv="${i}" value="${esc(v)}"${req}></label>`;
  }).join('');
  return head + `<div class="panel"><div class="grid2">
      <label class="fld"><span>申請の種類</span><select data-ap="type">${ts.map(x => `<option value="${x.id}"${x.id === t.id ? ' selected' : ''}>${esc(x.name)}</option>`).join('')}</select></label>${who}</div>
      ${fields || '<p class="muted small">入力する項目はありません。</p>'}</div>
    <div class="panel"><h3 style="margin:0 0 8px;font-size:15px">承認者</h3>${route ? routeHtml(steps) : '<p class="err">承認ルートが設定されていません。</p>'}
      <p class="err" id="applyErr"></p>
      <div class="actions"><button class="btn btn-primary" type="button" data-act="submit"${!steps.length ? ' disabled' : ''}>申請する</button></div></div>`;
}

/* ---------- 承認者画面 ---------- */
function reqCard(r, canDecide, note = '') {
  const kv = `<dl class="kv"><dt>申請番号</dt><dd>${esc(r.no)}</dd><dt>申請者</dt><dd>${esc(r.studentName)}${r.room ? '（' + esc(r.room) + '）' : ''}</dd><dt>申請日時</dt><dd>${esc(fmt(r.createdAt))}</dd>${r.fields.map(f => `<dt>${esc(f.label)}</dt><dd>${esc(fmtVal(f.kind, f.value))}</dd>`).join('')}</dl>`;
  const dec = canDecide ? `<div class="decide">
      <label class="fld" style="margin:0"><span>コメント（任意・承認しないときは理由を書くと寮生に伝わります）</span><textarea rows="2" data-cm="${r.id}">${esc(commentDraft[r.id] || '')}</textarea></label>
      <div class="actions"><button class="btn btn-primary" type="button" data-act="ok" data-id="${r.id}">承認する</button><button class="btn btn-danger" type="button" data-act="ng" data-id="${r.id}">承認しない</button></div></div>` : '';
  return `<article class="reqcard"><div class="req-head"><div><h3>${esc(r.typeName)}　${esc(r.studentName)}</h3>${note}</div><span class="st st-${esc(r.status)}">${STATUS[r.status] || ''}</span></div>${kv}${routeHtml(r.steps, r.id)}${dec}</article>`;
}
const myStep = (r, pid) => r.steps.find(s => s.approverId === pid && s.decidedAt) || r.steps.find(s => s.approverId === pid);
function ago(s) {
  const t = new Date(String(s).replace(' ', 'T')); const m = Math.max(0, Math.floor((Date.now() - t) / 60000));
  if (m < 60) return `${m}分`; const h = Math.floor(m / 60); if (h < 24) return `${h}時間`; return `${Math.floor(h / 24)}日`;
}
function classRequests(cur) {
  const ids = students().filter(s => s.homeroomId === cur.id).map(s => s.id);
  let list = S.requests.filter(r => ids.includes(r.studentId));
  if (cls.student) list = list.filter(r => r.studentId === Number(cls.student));
  if (cls.type) list = list.filter(r => r.typeId === Number(cls.type));
  if (cls.status) list = list.filter(r => r.status === cls.status);
  if (cls.from) list = list.filter(r => r.createdAt.slice(0, 10) >= cls.from);
  if (cls.to) list = list.filter(r => r.createdAt.slice(0, 10) <= cls.to);
  return list;
}
function viewClass(cur) {
  const mine = students().filter(s => s.homeroomId === cur.id);
  const all = S.requests.filter(r => mine.some(s => s.id === r.studentId));
  const list = classRequests(cur);
  const filters = `<div class="filters">
    <select data-cf="student" aria-label="寮生で絞り込む"><option value="">担任クラスの全員</option>${mine.map(s => `<option value="${s.id}"${String(cls.student) === String(s.id) ? ' selected' : ''}>${esc(s.name)}${s.room ? '（' + esc(s.room) + '）' : ''}</option>`).join('')}</select>
    <select data-cf="type" aria-label="種類で絞り込む"><option value="">すべての種類</option>${S.types.map(t => `<option value="${t.id}"${String(cls.type) === String(t.id) ? ' selected' : ''}>${esc(t.name)}</option>`).join('')}</select>
    <select data-cf="status" aria-label="状態で絞り込む"><option value="">すべての状態</option>${Object.entries(STATUS).map(([k, v]) => `<option value="${k}"${cls.status === k ? ' selected' : ''}>${v}</option>`).join('')}</select>
    <label class="small muted" style="display:grid;gap:2px">申請日（から）<input type="date" data-cf="from" value="${esc(cls.from)}"></label>
    <label class="small muted" style="display:grid;gap:2px">申請日（まで）<input type="date" data-cf="to" value="${esc(cls.to)}"></label></div>`;
  const tally = `<p class="muted small" style="margin:0 0 10px">担任の寮生 ${mine.length}人・これまでの申請 ${all.length}件（承認待ち ${all.filter(r => r.status === 'pending').length}件・許可 ${all.filter(r => r.status === 'approved').length}件）　表示中 ${list.length}件</p>`;
  const tools = `<div class="actions" style="margin-bottom:12px"><button class="btn btn-sm" type="button" data-act="classCsv"${list.length ? '' : ' disabled'}>表示中の一覧をCSVで保存</button>${Object.values(cls).some(Boolean) ? '<button class="btn btn-sm" type="button" data-act="classClear">絞り込みを解除</button>' : ''}</div>`;
  if (!list.length) return filters + tally + tools + `<div class="panel empty"><h3>該当する申請はありません</h3><p>${all.length ? '絞り込みの条件を変えてください。' : '担任の寮生から申請があると、ここに一覧で表示されます。'}</p></div>`;
  return filters + tally + tools + table(['申請日時', '寮生', '種類', '申請内容', '承認', '状態', '完了日時'], list.map(r => `<tr class="row" data-act="apopen" data-id="${r.id}" tabindex="0">
    <td>${esc(fmt(r.createdAt))}</td><td>${esc(r.studentName)}${r.room ? '<br><span class="muted small">' + esc(r.room) + '</span>' : ''}</td><td>${esc(r.typeName)}</td>
    <td class="small">${r.fields.map(f => `<span class="muted">${esc(f.label)}</span>　${esc(fmtVal(f.kind, f.value))}`).join('<br>')}</td>
    <td>${mini(r)}<span class="muted small">${r.steps.filter(s => s.status === 'approved').length}/${r.steps.length}</span></td>
    <td><span class="st st-${esc(r.status)}">${STATUS[r.status]}</span></td><td>${r.closedAt ? esc(fmt(r.closedAt)) : '—'}</td></tr>`).join(''));
}
function viewInbox() {
  const cur = me();
  const title = `<h2 class="view-title">承認者画面</h2>`;
  const idCard = `<div class="me-card"><div><span class="me-name">${esc(cur.name)}</span>${cur.title ? '<span class="tag">' + esc(cur.title) + '</span>' : ''}<br><span class="muted small">承認依頼は ${esc(cur.email)} にメールで届きます。メールのボタンからも承認できます。</span></div></div>`;
  if (ap.focus) {
    const r = reqById(ap.focus);
    const back = `<button class="btn btn-sm" type="button" data-act="go" data-view="inbox" style="margin-bottom:14px">← 承認者画面の一覧にもどる</button>`;
    if (!r) return title + idCard + back + '<div class="panel">この申請は見つかりません。</div>';
    const can = r.status === 'pending' && r.steps.some(s => s.approverId === cur.id && s.status === 'pending');
    const st = myStep(r, cur.id);
    let note = '';
    if (!st) note = '<div class="banner">この申請の承認者にあなたは含まれていません。内容の確認だけできます。</div>';
    else if (!can && st.decidedAt) note = `<div class="banner">${esc(fmt(st.decidedAt))} に「${STEP[st.status]}」と回答済みです。</div>`;
    else if (!can && r.status !== 'pending') note = `<div class="banner">この申請は「${STATUS[r.status]}」になっているため、回答は不要です。</div>`;
    return title + idCard + back + note + reqCard(r, can) + (r.status === 'approved' ? `<div class="actions"><button class="btn btn-primary" type="button" data-act="cert" data-id="${r.id}">${esc(r.certTitle)}を見る・PDFで保存</button></div>` : '');
  }
  const mine = S.requests.filter(r => r.steps.some(s => s.approverId === cur.id));
  const pend = pendingFor(cur.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const flow = mine.filter(r => r.status === 'pending' && !r.steps.some(s => s.approverId === cur.id && s.status === 'pending'));
  const done = mine.filter(r => r.steps.some(s => s.approverId === cur.id && s.decidedAt)).sort((a, b) => (myStep(b, cur.id).decidedAt || '').localeCompare(myStep(a, cur.id).decidedAt || ''));
  const hasClass = students().some(s => s.homeroomId === cur.id);
  if (ap.tab === 'class' && !hasClass) ap.tab = 'pending';
  const items = [['pending', '承認待ち', pend.length], ['flow', '進行中', flow.length], ['done', '判断済み', done.length]];
  if (hasClass) items.push(['class', '担任クラスの申請', classRequests(cur).length]);
  const seg = `<div class="seg" role="tablist">${items.map(([k, l, n]) => `<button role="tab" type="button" aria-selected="${ap.tab === k}" data-act="aptab" data-k="${k}">${l}<b>${n}</b></button>`).join('')}</div>`;
  let body;
  if (ap.tab === 'pending') {
    body = pend.length ? pend.map(r => reqCard(r, true, `<span class="wait">申請から${ago(r.createdAt)}たっています</span>`)).join('')
      : `<div class="panel empty"><h3>承認待ちの申請はありません</h3><p>新しい申請が届くと ${esc(cur.email)} にメールでお知らせします。</p></div>`;
  } else if (ap.tab === 'flow') {
    body = flow.length ? table(['申請日時', '種類', '寮生', '内容', '承認', '承認待ちの人'], flow.map(r => `<tr class="row" data-act="apopen" data-id="${r.id}" tabindex="0"><td>${esc(fmt(r.createdAt))}</td><td>${esc(r.typeName)}</td><td>${esc(r.studentName)}</td><td>${sumText(r)}</td><td>${mini(r)}</td><td>${esc(r.steps.filter(s => s.status === 'pending').map(s => s.name).join('、') || '—')}</td></tr>`).join(''))
      : `<div class="panel empty"><h3>進行中の申請はありません</h3><p>あなたが承認したあと、ほかの承認者の回答を待っている申請がここに表示されます。</p></div>`;
  } else if (ap.tab === 'class') {
    body = viewClass(cur);
  } else {
    body = done.length ? table(['あなたの回答日時', '種類', '寮生', '内容', 'あなたの回答', '現在の状態'], done.map(r => { const s = myStep(r, cur.id); return `<tr class="row" data-act="apopen" data-id="${r.id}" tabindex="0"><td>${esc(fmt(s.decidedAt))}</td><td>${esc(r.typeName)}</td><td>${esc(r.studentName)}</td><td>${sumText(r)}</td><td><span class="st ${s.status === 'approved' ? 'st-approved' : 'st-rejected'}">${STEP[s.status]}</span>${s.comment ? '<br><span class="muted small">' + esc(s.comment) + '</span>' : ''}</td><td><span class="st st-${esc(r.status)}">${STATUS[r.status]}</span></td></tr>`; }).join(''))
      : `<div class="panel empty"><h3>回答した申請はまだありません</h3><p>承認・非承認をした申請がここに記録されます。</p></div>`;
  }
  return title + `<p class="lead">承認依頼をまとめて確認し、その場で承認・非承認を選べます。古い申請から順に並んでいます。</p>` + idCard + seg + body;
}

/* ---------- 申請一覧 ---------- */
function viewHistory() {
  const cur = me();
  const scope = cur.role === 'student' ? 'あなたの申請' : cur.role === 'guardian' ? 'お子さんの申請' : 'すべての申請';
  let list = S.requests;
  if (hist.status) list = list.filter(r => r.status === hist.status);
  if (hist.type) list = list.filter(r => r.typeId === Number(hist.type));
  if (hist.q) { const q = hist.q.toLowerCase(); list = list.filter(r => [r.studentName, r.no, r.room, r.typeName, ...r.fields.map(f => f.value)].join(' ').toLowerCase().includes(q)); }
  const filters = `<div class="filters">
    <select data-hf="status" aria-label="状態で絞り込む"><option value="">すべての状態</option>${Object.entries(STATUS).map(([k, v]) => `<option value="${k}"${hist.status === k ? ' selected' : ''}>${v}</option>`).join('')}</select>
    <select data-hf="type" aria-label="種類で絞り込む"><option value="">すべての種類</option>${S.types.map(t => `<option value="${t.id}"${String(hist.type) === String(t.id) ? ' selected' : ''}>${esc(t.name)}</option>`).join('')}</select>
    <input type="text" data-hf="q" placeholder="名前・申請番号・行き先で検索" value="${esc(hist.q)}" aria-label="検索"></div>`;
  const head = `<h2 class="view-title">申請一覧</h2><p class="lead">${scope}を新しい順に表示しています。行を選ぶと、いつ誰が承認したかを確認できます。</p>`;
  if (!list.length) return head + filters + `<div class="panel empty"><h3>該当する申請はありません</h3><p>${S.requests.length ? '絞り込みを変えてください。' : 'まだ申請はありません。'}</p></div>`;
  const rows = list.map(r => {
    const open = hist.open === r.id;
    let detail = '';
    if (open) {
      const tl = [`<li><time>${esc(fmt(r.createdAt))}</time><span>申請（${esc(r.studentName)}）</span></li>`]
        .concat(r.steps.filter(s => s.decidedAt).sort((a, b) => a.decidedAt.localeCompare(b.decidedAt)).map(s => `<li><time>${esc(fmt(s.decidedAt))}</time><span>${s.status === 'approved' ? '承認' : '非承認'}：${esc(s.name)}${s.title ? '（' + esc(s.title) + '）' : ''}${s.comment ? '<br><span class="muted small">' + esc(s.comment) + '</span>' : ''}</span></li>`))
        .concat(r.closedAt ? [`<li><time>${esc(fmt(r.closedAt))}</time><span>${r.status === 'approved' ? 'すべての承認がそろい、許可書を発行' : r.status === 'withdrawn' ? '取り下げ' : '非承認で終了'}</span></li>`] : []);
      const canW = r.status === 'pending' && (cur.id === r.studentId || cur.role === 'staff');
      detail = `<tr><td colspan="7" class="detail"><div class="grid2"><div><dl class="kv">${r.fields.map(f => `<dt>${esc(f.label)}</dt><dd>${esc(fmtVal(f.kind, f.value))}</dd>`).join('')}</dl>${routeHtml(r.steps, r.id)}</div>
        <div><ul class="timeline">${tl.join('')}</ul><div class="actions">${r.status === 'approved' ? `<button class="btn btn-primary btn-sm" type="button" data-act="cert" data-id="${r.id}">${esc(r.certTitle)}を見る・PDFで保存</button>` : ''}${canW ? `<button class="btn btn-sm btn-danger" type="button" data-act="withdraw" data-id="${r.id}">申請を取り下げる</button>` : ''}</div></div></div></td></tr>`;
    }
    return `<tr class="row" data-act="open" data-id="${r.id}" tabindex="0" aria-expanded="${open}"><td>${esc(fmt(r.createdAt))}</td><td>${esc(r.typeName)}</td><td>${esc(r.studentName)}${r.room ? '<br><span class="muted small">' + esc(r.room) + '</span>' : ''}</td><td>${sumText(r)}</td><td>${mini(r)}</td><td><span class="st st-${esc(r.status)}">${STATUS[r.status]}</span></td><td>${r.closedAt ? esc(fmt(r.closedAt)) : '—'}</td></tr>${detail}`;
  }).join('');
  return head + filters + table(['申請日時', '種類', '寮生', '内容', '承認', '状態', '完了日時'], rows);
}

/* ---------- 送信メール（管理者） ---------- */
function viewMails() {
  const head = `<h2 class="view-title">送信メール</h2><p class="lead">システムが送ったメールの記録です。送れなかったメールはここから送り直せます。</p>
    ${mailState.quota !== undefined ? `<p class="muted small" style="margin:0 0 10px">今日あと ${esc(mailState.quota)} 人に送れます（Google の1日の上限）。</p>` : ''}
    <div class="actions" style="margin-bottom:14px"><button class="btn btn-sm" type="button" data-act="testMail">自分にテストメールを送る</button><button class="btn btn-sm" type="button" data-act="reloadMails">最新の状態にする</button></div>`;
  if (!mailState.list) { if (!mailState.loading) loadMails(); return head + '<p class="muted">読み込み中…</p>'; }
  if (!mailState.list.length) return head + '<div class="panel empty"><h3>まだ送信したメールはありません</h3><p>申請や承認があると、ここに記録されます。</p></div>';
  return head + table(['作成日時', '宛先', '件名', '状態', ''], mailState.list.map(m => {
    const open = mailState.open === Number(m.id);
    return `<tr class="row" data-act="mailopen" data-id="${m.id}" tabindex="0"><td>${esc(fmt(m.created_at))}</td><td class="small">${esc((m.to_names || []).join('、'))}<br><span class="muted">${esc((m.to_addr || []).join(', '))}</span></td><td>${esc(m.subject)}</td>
      <td><span class="st st-${esc(m.status)}">${MAILST[m.status] || esc(m.status)}</span>${m.error ? '<br><span class="small" style="color:var(--shu)">' + esc(m.error) + '</span>' : ''}</td>
      <td>${m.status === 'failed' || m.status === 'sending' ? `<button class="btn btn-sm" type="button" data-act="resend" data-id="${m.id}">送り直す</button>` : ''}</td></tr>
      ${open ? `<tr><td colspan="5" class="detail"><pre class="mailtext">${esc(m.body)}</pre></td></tr>` : ''}`;
  }).join(''));
}
async function loadMails() {
  mailState.loading = true;
  try { const r = await api('mails'); mailState.list = r.mails; mailState.quota = r.quota; } catch (e) { toast(e.message); mailState.list = []; }
  mailState.loading = false; if (view === 'mails') renderMain();
}

/* ---------- 設定（管理者） ---------- */
function viewSetup() {
  const head = `<h2 class="view-title">設定</h2><p class="lead">申請の種類、承認ルート、名簿を登録します。申請の種類はあとから何件でも追加でき、入力項目も自由に決められます。</p>`;
  const nav = `<div class="subnav">${[['types', '申請の種類'], ['routes', '承認ルート'], ['people', '名簿'], ['basic', '基本設定']].map(([k, v]) => `<button class="btn btn-sm" type="button" data-act="stab" data-k="${k}" aria-pressed="${setupTab === k}">${v}</button>`).join('')}</div>`;
  let body = '';
  if (setupTab === 'types') {
    body = `<div class="panel"><div class="actions" style="justify-content:space-between;margin-bottom:6px"><h3 style="margin:0;font-size:16px">申請の種類</h3><button class="btn btn-primary btn-sm" type="button" data-act="editType">申請の種類を追加</button></div>
      <div class="rows">${S.types.length ? S.types.map(t => { const r = S.routes.find(x => x.id === t.routeId); return `<div class="rowi"><div><h4>${esc(t.name)}${t.active ? '' : '<span class="tag">非表示</span>'}</h4><p>入力項目 ${t.fields.length}件　承認ルート：${r ? esc(r.name) : '<b style="color:var(--shu)">未設定</b>'}　PDF：${esc(t.certTitle)}</p></div><div class="actions"><button class="btn btn-sm" type="button" data-act="editType" data-id="${t.id}">編集</button><button class="btn btn-sm btn-danger" type="button" data-act="delType" data-id="${t.id}">削除</button></div></div>`; }).join('')
        : `<p class="muted">まだありません。</p><button class="btn btn-sm" type="button" data-act="sample">外泊・外出・帰省のひな形を入れる</button>`}</div></div>`;
  } else if (setupTab === 'routes') {
    body = `<div class="panel"><div class="actions" style="justify-content:space-between;margin-bottom:6px"><h3 style="margin:0;font-size:16px">承認ルート</h3><button class="btn btn-primary btn-sm" type="button" data-act="editRoute">承認ルートを追加</button></div>
      <p class="muted small" style="margin:0 0 6px">申請すると、ルートに登録した全員に同時に承認依頼が届き、全員が承認すると許可になります。</p>
      <div class="rows">${S.routes.length ? S.routes.map(r => `<div class="rowi"><div><h4>${esc(r.name)}</h4><p>${r.steps.map(s => esc(s.name) + (s.active ? '' : '（利用停止）')).join('・') || '承認者なし'}</p></div><div class="actions"><button class="btn btn-sm" type="button" data-act="editRoute" data-id="${r.id}">編集</button><button class="btn btn-sm btn-danger" type="button" data-act="delRoute" data-id="${r.id}">削除</button></div></div>`).join('') : '<p class="muted">まだありません。先に名簿に職員を登録してください。</p>'}</div></div>`;
  } else if (setupTab === 'people') {
    body = `<div class="panel"><div class="actions" style="justify-content:space-between;margin-bottom:6px"><h3 style="margin:0;font-size:16px">名簿</h3><button class="btn btn-primary btn-sm" type="button" data-act="editPerson">人を追加</button></div>
      ${['student', 'staff', 'guardian'].map(role => { const g = S.people.filter(p => p.role === role); return `<h4 style="margin:14px 0 0;font-size:13px;color:var(--muted)">${ROLE[role]}（${g.length}人）</h4><div class="rows">${g.map(p => `<div class="rowi"><div><h4>${esc(p.name)}${p.title ? '<span class="tag">' + esc(p.title) + '</span>' : ''}${p.room ? '<span class="tag">' + esc(p.room) + '</span>' : ''}${p.isAdmin ? '<span class="tag">管理者</span>' : ''}${p.active === false ? '<span class="tag off">利用停止</span>' : !p.hasPassword ? '<span class="tag off">パスワード未設定</span>' : ''}</h4>
        <p>${esc(p.email)}${role === 'student' ? '　担任：' + esc((person(p.homeroomId) || {}).name || '未設定') + '　保護者：' + (p.guardianIds.map(id => esc((person(id) || {}).name || '')).filter(Boolean).join('、') || '未登録') : ''}</p></div>
        <div class="actions"><button class="btn btn-sm" type="button" data-act="editPerson" data-id="${p.id}">編集</button><button class="btn btn-sm btn-danger" type="button" data-act="delPerson" data-id="${p.id}">削除</button></div></div>`).join('') || '<p class="muted small">登録なし</p>'}</div>`; }).join('')}</div>`;
  } else {
    const c = cfgState.data;
    if (!c) { if (!cfgState.loading) loadCfg(); return head + nav + '<p class="muted">読み込み中…</p>'; }
    const here = appBase();
    body = `<div class="panel"><label class="fld"><span>学校・寮の名前（許可書とメールに入ります）</span><input type="text" data-cfg="org" value="${esc(c.org)}"></label>
      <label class="fld"><span>この画面のURL（メールのボタンのリンク先）</span><input type="text" data-cfg="appUrl" value="${esc(c.appUrl || here)}"></label>
      ${c.appUrl && c.appUrl !== here ? `<p class="banner">登録されているURLと、いま開いている画面のURL（${esc(here)}）が違います。メールのボタンが正しく開くよう、必要なら書き換えて保存してください。</p>` : ''}
      <div class="grid2"><label class="fld"><span>メールの送信者名</span><input type="text" data-cfg="fromName" value="${esc(c.fromName)}" placeholder="${esc(c.org)} 寮"></label>
      <label class="fld"><span>返信先のメールアドレス（任意）</span><input type="email" data-cfg="replyTo" value="${esc(c.replyTo)}" placeholder="例：dorm@soshigakuen.ed.jp"></label></div>
      <p class="muted small">メールは Apps Script を公開した Google アカウントから送られます。今日あと ${esc(c.quota)} 人に送れます。</p>
      <div class="actions"><button class="btn btn-primary" type="button" data-act="saveCfg">保存する</button><button class="btn" type="button" data-act="testMail">自分にテストメールを送る</button></div></div>`;
  }
  return head + nav + body;
}

/* ---------- modal ---------- */
let modal = null;
function openModal(m) {
  modal = m; $('#mErr').textContent = ''; $('#mBox').classList.toggle('wide', !!m.wide);
  $('#mSave').hidden = !m.save; $('#mSave').textContent = m.saveLabel || '保存する';
  $('#mTitle').textContent = m.title; $('#modal').hidden = false; drawModal();
  setTimeout(() => { const f = $('#mBody input, #mBody select, #mBody textarea'); f && f.focus(); }, 30);
}
function drawModal() { $('#mBody').innerHTML = modal.render(); if (modal.after) modal.after(); }
function closeModal() { $('#modal').hidden = true; modal = null; }
$('#mCancel').onclick = closeModal;
$('#modal').addEventListener('click', e => { if (e.target.id === 'modal') closeModal(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#modal').hidden) closeModal(); });
$('#mBody').addEventListener('input', e => modal && modal.onInput && modal.onInput(e));
$('#mBody').addEventListener('change', e => modal && modal.onInput && modal.onInput(e));
$('#mBody').addEventListener('click', e => { const b = e.target.closest('[data-m]'); if (b && modal && modal.onClick) modal.onClick(b); });
$('#mSave').onclick = async () => {
  if (!modal || !modal.save) return;
  const err = modal.validate ? modal.validate() : '';
  if (err) { $('#mErr').textContent = err; return; }
  $('#mSave').disabled = true;
  try { const keep = await modal.save(); if (!keep) closeModal(); }
  catch (e) { $('#mErr').textContent = e.message; }
  finally { $('#mSave').disabled = false; }
};

function editType(id) {
  const src = S.types.find(t => t.id === id);
  const t = src ? JSON.parse(JSON.stringify(src)) : { name: '', certTitle: '', routeId: S.routes[0] ? S.routes[0].id : 0, notifyGuardians: true, active: true, sort: S.types.length, fields: [{ label: '', kind: 'text', required: true }] };
  openModal({
    title: id ? '申請の種類を編集' : '申請の種類を追加', wide: true,
    render: () => `<div class="grid2">
        <label class="fld"><span>申請の名前</span><input type="text" data-k="name" value="${esc(t.name)}" placeholder="例：外泊"></label>
        <label class="fld"><span>許可書のタイトル（PDF）</span><input type="text" data-k="certTitle" value="${esc(t.certTitle)}" placeholder="例：外泊許可書"></label></div>
      <div class="grid2"><label class="fld"><span>承認ルート</span><select data-k="routeId"><option value="">選んでください</option>${S.routes.map(r => `<option value="${r.id}"${r.id === Number(t.routeId) ? ' selected' : ''}>${esc(r.name)}</option>`).join('')}</select></label>
        <label class="fld"><span>並び順（小さいほど上）</span><input type="number" data-k="sort" value="${esc(t.sort)}"></label></div>
      <label class="chk"><input type="checkbox" data-k="notifyGuardians"${t.notifyGuardians ? ' checked' : ''}> 全員が承認したら保護者にメールで知らせる</label>
      <label class="chk"><input type="checkbox" data-k="active"${t.active ? ' checked' : ''}> 申請画面の選択肢に表示する</label>
      <fieldset><legend>申請するときに入力する項目</legend>
        ${t.fields.map((f, i) => `<div class="frow"><input type="text" data-fk="label" data-i="${i}" value="${esc(f.label)}" placeholder="項目名（例：行き先）" aria-label="項目名">
          <select data-fk="kind" data-i="${i}" aria-label="入力の形式">${Object.entries(KIND).map(([k, v]) => `<option value="${k}"${f.kind === k ? ' selected' : ''}>${v}</option>`).join('')}</select>
          <label class="chk"><input type="checkbox" data-fk="required" data-i="${i}"${f.required ? ' checked' : ''}> 必須</label>
          <span class="ops"><button type="button" class="btn btn-sm" data-m="up" data-i="${i}" aria-label="上へ"${i === 0 ? ' disabled' : ''}>↑</button><button type="button" class="btn btn-sm" data-m="down" data-i="${i}" aria-label="下へ"${i === t.fields.length - 1 ? ' disabled' : ''}>↓</button><button type="button" class="btn btn-sm btn-danger" data-m="rm" data-i="${i}">削除</button></span></div>`).join('')}
        <button type="button" class="btn btn-sm" data-m="add" style="margin-top:8px">項目を追加</button>
        ${src ? '<p class="muted small" style="margin:8px 0 0">項目を変えても、これまでの申請の記録はそのまま残ります。</p>' : ''}</fieldset>`,
    onInput: e => { const el = e.target;
      if (el.dataset.k) t[el.dataset.k] = el.type === 'checkbox' ? el.checked : el.value;
      if (el.dataset.fk) t.fields[+el.dataset.i][el.dataset.fk] = el.type === 'checkbox' ? el.checked : el.value; },
    onClick: b => { const i = +b.dataset.i, a = b.dataset.m;
      if (a === 'add') t.fields.push({ label: '', kind: 'text', required: false });
      if (a === 'rm') t.fields.splice(i, 1);
      if (a === 'up' && i > 0) [t.fields[i - 1], t.fields[i]] = [t.fields[i], t.fields[i - 1]];
      if (a === 'down' && i < t.fields.length - 1) [t.fields[i + 1], t.fields[i]] = [t.fields[i], t.fields[i + 1]];
      drawModal(); },
    validate: () => !String(t.name).trim() ? '申請の名前を入力してください。' : !t.routeId ? '承認ルートを選んでください。' : t.fields.some(f => !String(f.label).trim()) ? '項目名が空の行があります。' : '',
    save: async () => { const r = await api('save_type', { ...t, id: id || 0 }); toast(r.message); await refresh(false); }
  });
}
function editRoute(id) {
  const st = staff();
  const src = S.routes.find(r => r.id === id);
  const r = src ? { name: src.name, steps: src.steps.map(s => s.approverId) } : { name: '', steps: st[0] ? [st[0].id] : [] };
  openModal({
    title: id ? '承認ルートを編集' : '承認ルートを追加',
    render: () => `<label class="fld"><span>ルートの名前</span><input type="text" data-k="name" value="${esc(r.name)}" placeholder="例：外泊（担任・寮監）"></label>
      <p class="muted small" style="margin:-4px 0 12px">申請すると、ここに並べた全員に同時に承認依頼のメールが届きます。全員が承認した時点で許可になります。</p>
      <fieldset><legend>承認者</legend>${!st.length ? '<p class="muted small">名簿に職員がいません。</p>' : ''}
        ${r.steps.map((pid, i) => `<div class="srow"><b>${i + 1}</b><select data-si="${i}" aria-label="${i + 1}人目の承認者">${st.map(p => `<option value="${p.id}"${p.id === pid ? ' selected' : ''}>${esc(p.name)}${p.title ? '（' + esc(p.title) + '）' : ''}</option>`).join('')}</select><button type="button" class="btn btn-sm btn-danger" data-m="rm" data-i="${i}">外す</button></div>`).join('')}
        ${st.length ? '<button type="button" class="btn btn-sm" data-m="add" style="margin-top:8px">承認者を追加</button>' : ''}</fieldset>`,
    onInput: e => { const el = e.target; if (el.dataset.k) r[el.dataset.k] = el.value; if (el.dataset.si !== undefined) r.steps[+el.dataset.si] = Number(el.value); },
    onClick: b => { const i = +b.dataset.i; if (b.dataset.m === 'add') r.steps.push(st[0].id); if (b.dataset.m === 'rm') r.steps.splice(i, 1); drawModal(); },
    validate: () => !r.name.trim() ? 'ルートの名前を入力してください。' : !r.steps.length ? '承認者を1人以上追加してください。' : new Set(r.steps).size !== r.steps.length ? '同じ職員が2回入っています。' : '',
    save: async () => { const x = await api('save_route', { id: id || 0, name: r.name, steps: r.steps }); toast(x.message); await refresh(false); }
  });
}
function editPerson(id) {
  const src = person(id);
  const p = src ? JSON.parse(JSON.stringify(src)) : { name: '', role: 'student', email: '', title: '', room: '', guardianIds: [], homeroomId: null, isAdmin: false, active: true, hasPassword: false };
  p.password = ''; p.invite = !p.hasPassword;
  openModal({
    title: id ? '名簿を編集' : '人を追加',
    render: () => {
      const gs = S.people.filter(x => x.role === 'guardian' && x.active !== false);
      return `<div class="grid2"><label class="fld"><span>氏名（姓と名のあいだに空白）</span><input type="text" data-k="name" value="${esc(p.name)}" placeholder="例：山田 太郎"></label>
          <label class="fld"><span>区分</span><select data-k="role">${Object.entries(ROLE).map(([k, v]) => `<option value="${k}"${p.role === k ? ' selected' : ''}>${v}</option>`).join('')}</select></label></div>
        <label class="fld"><span>メールアドレス（ログインと通知に使います）</span><input type="email" data-k="email" value="${esc(p.email)}" placeholder="name@soshigakuen.ed.jp"></label>
        ${p.role === 'staff' ? `<label class="fld"><span>役職（承認欄と許可書に表示）</span><input type="text" data-k="title" value="${esc(p.title)}" placeholder="例：寮監、担任"></label>
          <label class="chk"><input type="checkbox" data-k="isAdmin"${p.isAdmin ? ' checked' : ''}> 管理者（設定と送信メールを扱える）</label>` : ''}
        ${p.role === 'student' ? `<div class="grid2"><label class="fld"><span>部屋</span><input type="text" data-k="room" value="${esc(p.room)}" placeholder="例：201号室"></label>
          <label class="fld"><span>担任（クラスの申請一覧を見られる職員）</span><select data-k="homeroomId"><option value="">未設定</option>${staff().map(x => `<option value="${x.id}"${x.id === Number(p.homeroomId) ? ' selected' : ''}>${esc(x.name)}${x.title ? '（' + esc(x.title) + '）' : ''}</option>`).join('')}</select></label></div>
          <fieldset><legend>保護者（承認完了の連絡先）</legend>${gs.length ? gs.map(g => `<label class="chk"><input type="checkbox" data-g="${g.id}"${p.guardianIds.includes(g.id) ? ' checked' : ''}> ${esc(g.name)}　<span class="muted small">${esc(g.email)}</span></label>`).join('') : '<p class="muted small">保護者が未登録です。先に保護者を追加してください。</p>'}</fieldset>` : ''}
        <fieldset><legend>ログイン</legend>
          <label class="chk"><input type="checkbox" data-k="invite"${p.invite ? ' checked' : ''}> 保存したあと、パスワードを決めるための案内メールを送る</label>
          <label class="fld" style="margin-bottom:4px"><span>または、ここで仮のパスワードを決める（8文字以上・空欄なら変更しない）</span><input type="text" data-k="password" value="${esc(p.password)}" autocomplete="off"></label>
          ${src ? `<label class="chk" style="margin-top:10px"><input type="checkbox" data-k="active"${p.active !== false ? ' checked' : ''}> 利用中（外すとログインできなくなります）</label>` : ''}</fieldset>`;
    },
    onInput: e => { const el = e.target;
      if (el.dataset.k) { p[el.dataset.k] = el.type === 'checkbox' ? el.checked : el.value; if (el.dataset.k === 'role') drawModal(); }
      if (el.dataset.g) { const g = Number(el.dataset.g); p.guardianIds = el.checked ? [...new Set([...p.guardianIds, g])] : p.guardianIds.filter(x => x !== g); } },
    validate: () => !p.name.trim() ? '氏名を入力してください。' : !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.email) ? 'メールアドレスを正しく入力してください。' : (p.password && p.password.length < 8) ? '仮のパスワードは8文字以上にしてください。' : '',
    save: async () => { const r = await api('save_user', { ...p, id: id || 0 }); toast(r.message); await refresh(false); }
  });
}
function changePassword() {
  const v = { current: '', password: '', password2: '' };
  openModal({
    title: 'パスワード変更',
    render: () => `<label class="fld"><span>今のパスワード</span><input type="password" data-k="current" autocomplete="current-password"></label>
      <label class="fld"><span>新しいパスワード（8文字以上）</span><input type="password" data-k="password" autocomplete="new-password"></label>
      <label class="fld"><span>もう一度</span><input type="password" data-k="password2" autocomplete="new-password"></label>`,
    onInput: e => { if (e.target.dataset.k) v[e.target.dataset.k] = e.target.value; },
    validate: () => v.password.length < 8 ? '新しいパスワードは8文字以上にしてください。' : v.password !== v.password2 ? '2つのパスワードが一致しません。' : '',
    save: async () => { await api('change_password', v); toast('パスワードを変更しました'); }
  });
}

/* ---------- certificate / PDF / CSV ---------- */
function certHtml(r) {
  return `<div class="cert"><div class="no">第 ${esc(r.no)} 号<br>${esc(fmtJa(r.closedAt || r.createdAt))}</div>
    <h2>${esc(r.certTitle)}</h2><p class="intro">下記の者の${esc(r.typeName)}を許可します。</p>
    <table><tbody><tr><th>氏名</th><td>${esc(r.studentName)}</td></tr>${r.room ? `<tr><th>部屋</th><td>${esc(r.room)}</td></tr>` : ''}
      ${r.fields.map(f => `<tr><th>${esc(f.label)}</th><td>${esc(fmtVal(f.kind, f.value))}</td></tr>`).join('')}<tr><th>申請日時</th><td>${esc(fmt(r.createdAt))}</td></tr></tbody></table>
    <div class="stamps">${r.steps.map(s => `<div class="sbox"><div class="t">${esc(s.title || '承認者')}</div><div class="s"><div class="cseal">${esc(surname(s.name))}</div></div><div class="dt">${esc(fmt(s.decidedAt, false))}</div></div>`).join('')}</div>
    <div class="foot"><span>承認完了 ${esc(fmt(r.closedAt))}</span><span class="org">${esc(S.org)}</span></div></div>`;
}
function fitCert() {
  const el = $('#certScale'); if (!el) return;
  const s = Math.min(1, (el.parentElement.clientWidth - 32) / 794);
  el.style.transform = `scale(${s})`; el.style.width = (794 * s) + 'px'; el.style.height = (1123 * s) + 'px';
}
window.addEventListener('resize', fitCert);
function showCert(id) {
  const r = reqById(id); if (!r || r.status !== 'approved') return;
  openModal({ title: r.certTitle, wide: true, saveLabel: 'PDFで保存',
    render: () => `<div class="certwrap"><div class="certscale" id="certScale">${certHtml(r)}</div></div>`,
    after: () => requestAnimationFrame(fitCert),
    save: async () => { await savePdf(r); return true; } });
}
function download(blob, filename) {
  const url = URL.createObjectURL(blob); const a = document.createElement('a');
  a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 5000);
}
async function savePdf(r) {
  if (!window.html2canvas || !window.jspdf) throw new Error('PDFを作る部品を読み込めませんでした。インターネット接続を確認してください。');
  const stage = $('#certStage'); stage.innerHTML = certHtml(r);
  try {
    if (document.fonts && document.fonts.ready) await document.fonts.ready;
    const canvas = await window.html2canvas(stage.firstElementChild, { scale: 2, backgroundColor: '#ffffff' });
    const pdf = new window.jspdf.jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
    pdf.addImage(canvas.toDataURL('image/jpeg', 0.92), 'JPEG', 0, 0, 210, 297);
    download(pdf.output('blob'), `${r.certTitle}_${r.studentName.replace(/\s+/g, '')}_${r.no}.pdf`);
    toast('PDFを保存しました');
  } finally { stage.innerHTML = ''; }
}
function saveClassCsv() {
  const qv = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const lines = [['申請番号', '申請日時', '寮生', '部屋', '種類', '申請内容', '状態', '承認状況', '完了日時'].map(qv).join(',')]
    .concat(classRequests(me()).map(r => [r.no, fmt(r.createdAt), r.studentName, r.room, r.typeName, r.fields.map(f => `${f.label}：${fmtVal(f.kind, f.value)}`).join(' / '), STATUS[r.status],
      r.steps.map(s => `${s.name}：${STEP[s.status] || ''}${s.decidedAt ? '（' + fmt(s.decidedAt) + '）' : ''}`).join(' / '), r.closedAt ? fmt(r.closedAt) : ''].map(qv).join(',')));
  const d = new Date();
  download(new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv' }), `担任クラス申請一覧_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}.csv`);
}

/* ---------- events ---------- */
const typing = () => { const a = document.activeElement; return a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName); };
document.addEventListener('input', e => {
  const el = e.target; if (!$('#main') || !$('#main').contains(el)) return;
  if (el.dataset.fv !== undefined) applyState.values[+el.dataset.fv] = el.value;
  if (el.dataset.cm) commentDraft[el.dataset.cm] = el.value;
  if (el.dataset.hf === 'q') { hist.q = el.value; clearTimeout(window._qt); window._qt = setTimeout(() => { const pos = el.selectionStart; renderMain(); const n = $('[data-hf="q"]'); if (n) { n.focus(); n.setSelectionRange(pos, pos); } }, 250); }
});
document.addEventListener('change', e => {
  const el = e.target; if (!$('#main') || !$('#main').contains(el)) return;
  if (el.dataset.ap === 'type') { applyState.typeId = Number(el.value); applyState.values = {}; renderMain(); }
  if (el.dataset.ap === 'student') applyState.studentId = Number(el.value);
  if (el.dataset.hf === 'status' || el.dataset.hf === 'type') { hist[el.dataset.hf] = el.value; renderMain(); }
  if (el.dataset.cf) { cls[el.dataset.cf] = el.value; renderMain(); }
});
document.addEventListener('keydown', e => { if ((e.key === 'Enter' || e.key === ' ') && e.target.matches && e.target.matches('tr.row')) { e.preventDefault(); e.target.click(); } });
document.addEventListener('click', async e => {
  const b = e.target.closest('[data-act]'); if (!b || !app.contains(b)) return;
  const a = b.dataset.act, id = Number(b.dataset.id || 0);
  const busy = async fn => { b.disabled = true; try { await fn(); } catch (x) { toast(x.message); } finally { b.disabled = false; } };
  switch (a) {
    case 'go': go(b.dataset.view); break;
    case 'toForgot': authMode = 'forgot'; renderLogin(); break;
    case 'toLogin': authMode = 'login'; renderLogin(); break;
    case 'logout': await api('logout', {}).catch(() => {}); setSession(''); S.me = null; authMode = 'login'; await load().catch(() => {}); render(); break;
    case 'pw': changePassword(); break;
    case 'submit': await busy(async () => {
      const t = S.types.find(x => x.id === applyState.typeId);
      const missing = t.fields.filter((f, i) => f.required && !String(applyState.values[i] ?? '').trim()).map(f => f.label);
      if (missing.length) { $('#applyErr').textContent = `次の項目を入力してください：${missing.join('、')}`; return; }
      const r = await api('submit', { typeId: t.id, studentId: applyState.studentId, values: t.fields.map((f, i) => applyState.values[i] ?? '') });
      applyState.values = {}; toast(r.message); hist.open = r.request.id; await load(); go('history');
    }); break;
    case 'ok': case 'ng':
      if (a === 'ng' && !confirm('この申請を「承認しない」にしますか？寮生とほかの承認者に通知されます。')) return;
      await busy(async () => { const r = await api('decide', { requestId: id, ok: a === 'ok', comment: commentDraft[id] || '' }); delete commentDraft[id]; toast(r.message); await refresh(true); });
      break;
    case 'withdraw':
      if (!confirm('この申請を取り下げますか？')) return;
      await busy(async () => { const r = await api('withdraw', { requestId: id }); toast(r.message); await refresh(true); }); break;
    case 'open': hist.open = hist.open === id ? 0 : id; renderMain(); break;
    case 'apopen': go('r-' + id); break;
    case 'aptab': ap.tab = b.dataset.k; renderMain(); break;
    case 'cert': showCert(id); break;
    case 'classCsv': saveClassCsv(); break;
    case 'classClear': Object.keys(cls).forEach(k => cls[k] = ''); renderMain(); break;
    case 'mailopen': mailState.open = mailState.open === id ? 0 : id; renderMain(); break;
    case 'reloadMails': mailState.list = null; renderMain(); break;
    case 'resend': e.stopPropagation(); await busy(async () => { const r = await api('resend', { id }); toast(r.message); mailState.list = null; renderMain(); }); break;
    case 'testMail': await busy(async () => { const r = await api('test_mail', {}); toast(r.message); mailState.list = null; if (view === 'mails') renderMain(); }); break;
    case 'stab': setupTab = b.dataset.k; if (setupTab === 'basic') cfgState.data = null; renderMain(); break;
    case 'editType': if (!S.routes.length) { toast('先に「承認ルート」を登録してください。'); setupTab = 'routes'; renderMain(); return; } editType(id); break;
    case 'editRoute': editRoute(id); break;
    case 'editPerson': editPerson(id); break;
    case 'delType': case 'delRoute': case 'delPerson': {
      const label = a === 'delType' ? (S.types.find(t => t.id === id) || {}).name : a === 'delRoute' ? (S.routes.find(r => r.id === id) || {}).name : (person(id) || {}).name;
      if (!confirm(`「${label}」を削除しますか？`)) return;
      await busy(async () => { const r = await api({ delType: 'delete_type', delRoute: 'delete_route', delPerson: 'delete_user' }[a], { id }); toast(r.message); await refresh(false); }); break;
    }
    case 'sample': await busy(async () => { const r = await api('sample', {}); toast(r.message); await refresh(false); }); break;
    case 'saveCfg': await busy(async () => {
      const v = k => $(`[data-cfg="${k}"]`).value.trim();
      await api('save_settings', { org: v('org'), appUrl: v('appUrl').replace(/\/+$/, ''), fromName: v('fromName'), replyTo: v('replyTo') });
      toast('保存しました'); cfgState.data = null; await refresh(false);
    }); break;
  }
});

/* keep data fresh while the page is open */
setInterval(() => {
  if (document.visibilityState !== 'visible' || !S.me || !$('#modal').hidden || typing()) return;
  load().then(() => { if (!typing() && $('#modal').hidden) { const y = window.scrollY; render(true); window.scrollTo(0, y); } }).catch(() => {});
}, 60000);

/* ---------- start ---------- */
load().then(() => { readHash(); render(); }).catch(e => { app.innerHTML = `<div class="auth"><div class="panel"><p class="err">${esc(e.message)}</p><button class="btn" onclick="location.reload()">読み込み直す</button></div></div>`; });
})();
