/**
 * 寮の申請・承認システム（Google Apps Script 版）
 *
 * このスクリプトはスプレッドシートに紐づけて使います。
 *   1. スプレッドシートの「拡張機能 → Apps Script」を開き、このファイルの中身を貼り付ける
 *   2. 関数「setup」を1回だけ実行する（シートが作られ、権限の確認が出ます）
 *   3. 「デプロイ → 新しいデプロイ → ウェブアプリ」で公開する
 *        次のユーザーとして実行：自分
 *        アクセスできるユーザー：全員
 *   4. 表示された「ウェブアプリのURL」を、GitHub 側の config.js に書く
 * 詳しくは README.md を見てください。
 */

/* ===================== 設定 ===================== */
var TZ = 'Asia/Tokyo';
var SESSION_DAYS = 30;          // ログインを保つ日数
var PW_ITER = 1000;             // パスワードのハッシュを重ねる回数

var SCHEMA = {
  users:       ['id', 'name', 'email', 'role', 'title', 'room', 'homeroom_id', 'is_admin', 'pw_hash', 'pw_salt', 'active', 'created_at'],
  guardians:   ['student_id', 'guardian_id'],
  routes:      ['id', 'name'],
  route_steps: ['route_id', 'sort', 'approver_id'],
  types:       ['id', 'name', 'cert_title', 'route_id', 'notify_guardians', 'active', 'sort', 'fields'],
  requests:    ['id', 'no', 'type_id', 'type_name', 'cert_title', 'student_id', 'student_name', 'room', 'submitted_by', 'fields', 'status', 'notify_guardians', 'created_at', 'closed_at'],
  steps:       ['id', 'request_id', 'sort', 'approver_id', 'approver_name', 'approver_title', 'status', 'decided_at', 'comment', 'token_hash'],
  mails:       ['id', 'request_id', 'to_addr', 'to_names', 'subject', 'body', 'html', 'status', 'error', 'created_at', 'sent_at'],
  sessions:    ['token_hash', 'user_id', 'expires_at'],
  tokens:      ['token_hash', 'user_id', 'purpose', 'expires_at'],
  settings:    ['k', 'v']
};

/* ===================== 初期設定（1回だけ手動で実行） ===================== */
function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  Object.keys(SCHEMA).forEach(function (name) {
    var sh = ss.getSheetByName(name) || ss.insertSheet(name);
    var head = SCHEMA[name];
    sh.getRange(1, 1, 1, head.length).setNumberFormat('@').setValues([head]).setFontWeight('bold');
    sh.getRange(1, 1, sh.getMaxRows(), head.length).setNumberFormat('@');
    sh.setFrozenRows(1);
  });
  var first = ss.getSheetByName('シート1') || ss.getSheetByName('Sheet1');
  if (first && ss.getSheets().length > 1) ss.deleteSheet(first);
  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty('PEPPER')) props.setProperty('PEPPER', Utilities.getUuid() + Utilities.getUuid());
  props.setProperty('SPREADSHEET_ID', ss.getId());
  try { clearCache(); } catch (e) {}
  // メール送信の権限確認のために残りの送信可能数を読む
  Logger.log('準備ができました。1日に送れるメールの残り：' + MailApp.getRemainingDailyQuota() + '通');
}

/* ===================== 入口 ===================== */
function doGet() {
  return json_({ ok: true, message: '寮の申請・承認システムのAPIです。画面はGitHub Pagesのページから開いてください。' });
}

function doPost(e) {
  var input = {};
  try { input = JSON.parse((e && e.postData && e.postData.contents) || '{}'); } catch (x) { return json_({ error: '送られたデータを読めませんでした。' }); }
  var a = String(input.a || '');
  var fn = ACTIONS[a];
  if (!fn) return json_({ error: '不明な操作です。' });
  DB_ = {}; DIRTY_ = {}; SS_ = null; HAS_LOCK_ = false;
  try {
    if (WRITE_ACTIONS[a]) lock_();
    loadCached_();
    var ctx = { input: input, token: String(input.session || ''), me: null };
    ctx.me = currentUser_(ctx.token);
    var out = fn(ctx) || { ok: true };
    // 書き込みのあとは最新の状態もいっしょに返し、画面が読み直さなくて済むようにする
    if (STATE_ACTIONS[a] && ctx.me && !out.error) out.state = ACTIONS.bootstrap(ctx);
    saveCache_();
    return json_(out);
  } catch (err) {
    dropCache_();
    if (err && err.userMessage) return json_({ error: err.userMessage, code: err.code || 400 });
    console.error(err && err.stack || err);
    return json_({ error: 'サーバーでエラーが起きました。管理者に連絡してください。（' + (err && err.message || err) + '）', code: 500 });
  } finally {
    if (HAS_LOCK_) try { LockService.getScriptLock().releaseLock(); } catch (x) {}
    HAS_LOCK_ = false;
  }
}

function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
function fail_(msg, code) { var e = new Error(msg); e.userMessage = msg; e.code = code || 400; throw e; }

/**
 * スプレッドシートを直接書き換えたときに実行してください（キャッシュを捨てて読み直します）。
 * 管理者は画面の「設定 → 基本設定 → スプレッドシートから読み直す」でも同じことができます。
 */
function clearCache() { CacheService.getScriptCache().removeAll(CACHED_TABLES.map(function (n) { return CKEY + n; })); Logger.log('キャッシュを消しました。'); }

/* ===================== スプレッドシートを表として使う =====================
 * 速さのため、よく使う表は Apps Script のキャッシュに丸ごと置き、1回の呼び出しでまとめて読みます。
 * 書き込みは必ずスプレッドシートに行い、そのあとキャッシュも新しくします。
 * 送信メールの記録（mails）は大きくなるため、キャッシュせず必要な行だけ読み書きします。 */
var CACHED_TABLES = ['users', 'guardians', 'routes', 'route_steps', 'types', 'requests', 'steps', 'sessions', 'tokens', 'settings'];
var CKEY = 'dorm2:';
var CACHE_TTL = 21600;      // キャッシュを保つ秒数（最大6時間）
var CHUNK = 25000;          // キャッシュ1件に入れる文字数
var DB_ = {}, DIRTY_ = {}, SS_ = null, HAS_LOCK_ = false;

function lock_() { if (!HAS_LOCK_) { LockService.getScriptLock().waitLock(30000); HAS_LOCK_ = true; } }
function ss_() {
  if (SS_) return SS_;
  var id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  SS_ = id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
  return SS_;
}
function sheet_(t) {
  if (!t.sh) {
    t.sh = ss_().getSheetByName(t.name);
    if (!t.sh) fail_('シート「' + t.name + '」がありません。Apps Script で setup を実行してください。', 500);
  }
  return t.sh;
}
function makeTable_(name, last, rowsArr) {
  var head = SCHEMA[name];
  var rows = rowsArr.map(function (v) { var o = { _row: Number(v[0]) }; head.forEach(function (h, j) { o[h] = v[j + 1]; }); return o; });
  return { name: name, sh: null, head: head, rows: rows, last: last };
}
/** キャッシュにある表を、まとめて2回の呼び出しで読む */
function loadCached_() {
  var cache = CacheService.getScriptCache();
  var metas = cache.getAll(CACHED_TABLES.map(function (n) { return CKEY + n; }));
  var want = [], info = {};
  CACHED_TABLES.forEach(function (n) {
    var m = metas[CKEY + n]; if (!m) return;
    try { m = JSON.parse(m); } catch (e) { return; }
    info[n] = m;
    for (var i = 0; i < m.n; i++) want.push(CKEY + n + ':' + m.v + ':' + i);
  });
  if (!want.length) return;
  var parts = cache.getAll(want);
  Object.keys(info).forEach(function (n) {
    var m = info[n], str = '';
    for (var i = 0; i < m.n; i++) { var p = parts[CKEY + n + ':' + m.v + ':' + i]; if (p === undefined || p === null) return; str += p; }
    try { DB_[n] = makeTable_(n, m.last, JSON.parse(str)); } catch (e) {}
  });
}
function table_(name) {
  if (DB_[name]) return DB_[name];
  // キャッシュにないときは、書き込みと重ならないよう鍵をかけてからシートを読む
  lock_();
  var t = { name: name, sh: null, head: SCHEMA[name], rows: [], last: 1 };
  var sh = sheet_(t);
  var n = sh.getLastRow();
  var vals = n > 1 ? sh.getRange(2, 1, n - 1, t.head.length).getDisplayValues() : [];
  t.rows = vals.map(function (v, i) {
    var o = { _row: i + 2 };
    t.head.forEach(function (h, j) { o[h] = v[j]; });
    return o;
  }).filter(function (o) { return o[t.head[0]] !== ''; });
  t.last = Math.max(n, 1);
  DB_[name] = t;
  if (CACHED_TABLES.indexOf(name) >= 0) DIRTY_[name] = true;
  return t;
}
function saveCache_() {
  var names = Object.keys(DIRTY_);
  if (!names.length) return;
  var put = {};
  var ver = String(Date.now());
  names.forEach(function (n) {
    var t = DB_[n];
    var str = JSON.stringify(t.rows.map(function (r) { return [r._row].concat(t.head.map(function (h) { return r[h]; })); }));
    var k = 0;
    for (var i = 0; i < str.length || i === 0; i += CHUNK) { put[CKEY + n + ':' + ver + ':' + k] = str.substring(i, i + CHUNK); k++; if (!str.length) break; }
    put[CKEY + n] = JSON.stringify({ n: k, last: t.last, v: ver });
  });
  try { CacheService.getScriptCache().putAll(put, CACHE_TTL); } catch (e) { dropCache_(); }
}
function dropCache_() {
  var names = Object.keys(DIRTY_);
  if (names.length) try { CacheService.getScriptCache().removeAll(names.map(function (n) { return CKEY + n; })); } catch (e) {}
}

function all_(name) { return table_(name).rows; }
function find_(name, pred) { var r = all_(name); for (var i = 0; i < r.length; i++) if (pred(r[i])) return r[i]; return null; }
function where_(name, pred) { return all_(name).filter(pred); }
function byId_(name, id) { id = String(id); return find_(name, function (r) { return r.id === id; }); }
function str_(v) { return v === null || v === undefined ? '' : (typeof v === 'boolean' ? (v ? '1' : '0') : String(v)); }
function rowVals_(head, o) { return head.map(function (h) { return str_(o[h]); }); }
function nextId_(name) { var m = 0; all_(name).forEach(function (r) { var n = Number(r.id) || 0; if (n > m) m = n; }); return m + 1; }
function writeRow_(sh, row, head, o) {
  var rg = sh.getRange(row, 1, 1, head.length);
  if (row > 1000) rg.setNumberFormat('@');   // setup で1000行目までは文字列の書式にしてある
  rg.setValues([rowVals_(head, o)]);
}
function insert_(name, o) {
  var t = table_(name);
  lock_();
  if (t.head[0] === 'id' && !o.id) o.id = nextId_(name);
  var row = t.last + 1;
  writeRow_(sheet_(t), row, t.head, o);
  t.last = row;
  var copy = { _row: row }; t.head.forEach(function (h) { copy[h] = str_(o[h]); });
  t.rows.push(copy);
  DIRTY_[name] = true;
  return copy;
}
function update_(name, rowObj, changes) {
  var t = table_(name);
  lock_();
  Object.keys(changes).forEach(function (k) { rowObj[k] = str_(changes[k]); });
  writeRow_(sheet_(t), rowObj._row, t.head, rowObj);
  DIRTY_[name] = true;
  return rowObj;
}
/** 条件に合う行を消して、表を書き直す（行数の少ない表で使う） */
function removeWhere_(name, pred) {
  var t = table_(name);
  var keep = t.rows.filter(function (r) { return !pred(r); });
  if (keep.length === t.rows.length) return 0;
  lock_();
  var sh = sheet_(t);
  if (t.last > 1) sh.getRange(2, 1, t.last - 1, t.head.length).clearContent();
  if (keep.length) sh.getRange(2, 1, keep.length, t.head.length).setValues(keep.map(function (r) { return rowVals_(t.head, r); }));
  keep.forEach(function (r, i) { r._row = i + 2; });
  var removed = t.rows.length - keep.length;
  t.rows = keep;
  t.last = keep.length + 1;
  DIRTY_[name] = true;
  return removed;
}

/* 送信メールの記録：番号＝行番号−1。全体は読まずに1行ずつ書く */
var MAIL_HEAD = SCHEMA.mails;
function mailSheet_() { return sheet_(DB_.__mails || (DB_.__mails = { name: 'mails', sh: null })); }
function mailInsert_(o) {
  lock_();
  var sh = mailSheet_();
  var row = Math.max(sh.getLastRow(), 1) + 1;
  o.id = row - 1;
  writeRow_(sh, row, MAIL_HEAD, o);
  var copy = { _row: row }; MAIL_HEAD.forEach(function (h) { copy[h] = str_(o[h]); });
  return copy;
}
function mailUpdate_(m, changes) {
  lock_();
  Object.keys(changes).forEach(function (k) { m[k] = str_(changes[k]); });
  writeRow_(mailSheet_(), m._row, MAIL_HEAD, m);
}
function mailRows_(fromRow, count) {
  var sh = mailSheet_();
  if (count <= 0) return [];
  return sh.getRange(fromRow, 1, count, MAIL_HEAD.length).getDisplayValues().map(function (v, i) {
    var o = { _row: fromRow + i }; MAIL_HEAD.forEach(function (h, j) { o[h] = v[j]; }); return o;
  }).filter(function (o) { return o.id !== ''; });
}

/* ===================== 小さな道具 ===================== */
function now_() { return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm:ss'); }
function later_(ms) { return Utilities.formatDate(new Date(Date.now() + ms), TZ, 'yyyy-MM-dd HH:mm:ss'); }
function hex_(bytes) { return bytes.map(function (b) { var v = (b < 0 ? b + 256 : b).toString(16); return v.length === 1 ? '0' + v : v; }).join(''); }
function sha_(s) { return hex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(s), Utilities.Charset.UTF_8)); }
function randToken_() { return (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, ''); }
function pepper_() { return PropertiesService.getScriptProperties().getProperty('PEPPER') || ''; }
function hashPw_(pw, salt) {
  var key = Utilities.newBlob(salt + pepper_()).getBytes();
  var h = Utilities.computeHmacSha256Signature(Utilities.newBlob(String(pw)).getBytes(), key);
  for (var i = 0; i < PW_ITER; i++) h = Utilities.computeHmacSha256Signature(h, key);
  return hex_(h);
}
function safeEq_(a, b) { a = String(a); b = String(b); if (a.length !== b.length) return false; var d = 0; for (var i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; }
function clip_(v, max) { return String(v === undefined || v === null ? '' : v).trim().substring(0, max || 200); }
function validEmail_(e) { return /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(String(e || '')); }
function esc_(s) { return String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
function setting_(k, d) { var r = find_('settings', function (x) { return x.k === k; }); return r ? r.v : (d || ''); }
function setSetting_(k, v) { var r = find_('settings', function (x) { return x.k === k; }); if (r) update_('settings', r, { v: v }); else insert_('settings', { k: k, v: v }); }
function org_() { return setting_('org_name') || '学生寮'; }
function appUrl_() { return String(setting_('app_url') || '').replace(/\/+$/, ''); }

/* ===================== ログイン ===================== */
function currentUser_(token) {
  if (!token) return null;
  var h = sha_(token);
  var s = find_('sessions', function (x) { return x.token_hash === h; });
  if (!s || s.expires_at < now_()) return null;
  var u = byId_('users', s.user_id);
  return u && u.active === '1' ? u : null;
}
function startSession_(uid) {
  var t = randToken_();
  var n = now_();
  removeWhere_('sessions', function (x) { return x.expires_at < n; });
  insert_('sessions', { token_hash: sha_(t), user_id: uid, expires_at: later_(SESSION_DAYS * 86400000) });
  return t;
}
function needLogin_(ctx) { if (!ctx.me) fail_('ログインしてください。', 401); return ctx.me; }
function needStaff_(ctx) { var m = needLogin_(ctx); if (m.role !== 'staff') fail_('職員のみ操作できます。', 403); return m; }
function needAdmin_(ctx) { var m = needStaff_(ctx); if (m.is_admin !== '1') fail_('管理者のみ操作できます。', 403); return m; }
function setPassword_(u, pw) { var salt = randToken_().substring(0, 24); update_('users', u, { pw_salt: salt, pw_hash: hashPw_(pw, salt) }); }
function makeToken_(uid, purpose, days) {
  removeWhere_('tokens', function (x) { return x.user_id === String(uid) && x.purpose === purpose; });
  var t = randToken_();
  insert_('tokens', { token_hash: sha_(t), user_id: uid, purpose: purpose, expires_at: later_(days * 86400000) });
  return t;
}

/* ===================== 読み出し ===================== */
function guardiansOf_(sid) {
  sid = String(sid);
  return where_('guardians', function (g) { return g.student_id === sid; })
    .map(function (g) { return byId_('users', g.guardian_id); })
    .filter(function (u) { return u && u.active === '1'; });
}
function stepsOf_(rid) { rid = String(rid); return where_('steps', function (s) { return s.request_id === rid; }).sort(function (a, b) { return Number(a.sort) - Number(b.sort); }); }
function fields_(r) { try { return JSON.parse(r.fields || '[]'); } catch (e) { return []; } }
function requestPublic_(r, steps) {
  return {
    id: Number(r.id), no: r.no, typeId: Number(r.type_id), typeName: r.type_name, certTitle: r.cert_title,
    studentId: Number(r.student_id), studentName: r.student_name, room: r.room, fields: fields_(r),
    status: r.status, createdAt: r.created_at, closedAt: r.closed_at || null,
    steps: (steps || stepsOf_(r.id)).map(function (s) {
      return { approverId: Number(s.approver_id), name: s.approver_name, title: s.approver_title, status: s.status, decidedAt: s.decided_at || null, comment: s.comment || '' };
    })
  };
}
function userPublic_(u, full) {
  var o = { id: Number(u.id), name: u.name, role: u.role, title: u.title, room: u.room, homeroomId: u.homeroom_id ? Number(u.homeroom_id) : null, isAdmin: u.is_admin === '1' };
  if (full) {
    o.email = u.email; o.active = u.active === '1'; o.hasPassword = !!u.pw_hash;
    o.guardianIds = where_('guardians', function (g) { return g.student_id === u.id; }).map(function (g) { return Number(g.guardian_id); });
  }
  return o;
}
function visibleRequests_(me) {
  var list = all_('requests');
  if (me.role === 'student') list = list.filter(function (r) { return r.student_id === me.id; });
  else if (me.role === 'guardian') {
    var kids = where_('guardians', function (g) { return g.guardian_id === me.id; }).map(function (g) { return g.student_id; });
    list = list.filter(function (r) { return kids.indexOf(r.student_id) >= 0; });
  }
  var byReq = {};
  all_('steps').forEach(function (s) { (byReq[s.request_id] = byReq[s.request_id] || []).push(s); });
  return list.slice().sort(function (a, b) { return (b.created_at + b.id).localeCompare(a.created_at + a.id); })
    .map(function (r) { return requestPublic_(r, (byReq[r.id] || []).sort(function (a, b) { return Number(a.sort) - Number(b.sort); })); });
}
function fmtVal_(kind, v) {
  if (v === undefined || v === null || v === '') return '—';
  if (kind === 'datetime') return String(v).replace('T', ' ').replace(/-/g, '/');
  if (kind === 'date') return String(v).replace(/-/g, '/');
  return String(v);
}
function fmtDt_(s) { return s ? String(s).substring(0, 16).replace(/-/g, '/') : ''; }
function detail_(r) { return fields_(r).map(function (f) { return f.label + '：' + fmtVal_(f.kind, f.value); }).join('\n'); }
function approversText_(steps) { return steps.map(function (s) { return s.approver_name + (s.approver_title ? '（' + s.approver_title + '）' : ''); }).join('・'); }

/* ===================== メール ===================== */
function sendMail_(to, subject, body, opt) {
  opt = opt || {};
  var addrs = [], names = [];
  to.forEach(function (u) { if (u) { names.push(u.name); if (validEmail_(u.email) && addrs.indexOf(u.email) < 0) addrs.push(u.email); } });
  var org = org_();
  var buttons = opt.buttons || [];
  var text = body;
  buttons.forEach(function (b) { text += '\n\n▼' + b[0] + '\n' + b[1]; });
  text += '\n\n――\n' + org + ' 申請・承認システムからの自動送信です。';
  var html = '<div style="font-family:\'Hiragino Sans\',\'Yu Gothic\',Meiryo,sans-serif;font-size:14px;line-height:1.8;color:#1E2B3A;max-width:600px">'
    + '<div style="white-space:pre-wrap">' + esc_(body) + '</div>';
  if (buttons.length) {
    html += '<p style="margin:26px 0 10px">';
    buttons.forEach(function (b) {
      html += '<a href="' + esc_(b[1]) + '" style="background:' + (b[2] || '#27466B') + ';color:#ffffff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:bold;display:inline-block;margin:0 8px 8px 0">' + esc_(b[0]) + '</a>';
    });
    html += '</p><p style="font-size:12px;color:#5B6874;margin:0">ボタンが押せない場合は、テキスト版のメールにあるアドレスを開いてください。</p>';
  }
  html += '<p style="font-size:12px;color:#5B6874;border-top:1px solid #D3DAD9;padding-top:10px;margin-top:26px">' + esc_(org) + ' 申請・承認システムからの自動送信です。</p></div>';
  var m = mailInsert_({
    request_id: opt.request_id || '', to_addr: JSON.stringify(addrs), to_names: JSON.stringify(names),
    subject: subject, body: text, html: html, status: addrs.length ? 'sending' : 'skipped',
    error: addrs.length ? '' : '送り先のメールアドレスが登録されていません', created_at: now_(), sent_at: ''
  });
  if (!addrs.length) return 'skipped';
  return deliver_(m);
}
function deliver_(m) {
  var to = JSON.parse(m.to_addr || '[]');
  try {
    if (MailApp.getRemainingDailyQuota() < to.length) throw new Error('今日送れるメールの上限に達しました。明日になると送れます。');
    var o = { to: to.join(','), subject: m.subject, body: m.body, htmlBody: m.html, name: setting_('mail_from_name') || (org_() + ' 寮') };
    var reply = setting_('mail_reply_to'); if (validEmail_(reply)) o.replyTo = reply;
    MailApp.sendEmail(o);
    mailUpdate_(m, { status: 'sent', error: '', sent_at: now_() });
    return 'sent';
  } catch (e) {
    mailUpdate_(m, { status: 'failed', error: String(e && e.message || e).substring(0, 300) });
    return 'failed';
  }
}
function tally_(res, st) { if (st === 'sent') res.sent++; else if (st === 'failed') res.failed++; }
function mailNote_(res) {
  var t = '';
  if (res.sent) t += 'メールを' + res.sent + '通送りました。';
  if (res.failed) t += res.failed + '通は送れませんでした（管理者が「送信メール」で確認できます）。';
  return t;
}
function needAppUrl_() { if (!appUrl_()) fail_('画面のURLが登録されていません。管理者が「設定 → 基本設定」で保存し直してください。', 500); }
function link_(hash) { return appUrl_() + '/#' + hash; }
function approveLink_(token, d) { return appUrl_() + '/approve.html?t=' + token + '&d=' + d; }

/* ===================== 承認の流れ ===================== */
function createRequest_(type, student, values, by) {
  needAppUrl_();
  var route = where_('route_steps', function (s) { return s.route_id === type.route_id; })
    .sort(function (a, b) { return Number(a.sort) - Number(b.sort); })
    .map(function (s) { return byId_('users', s.approver_id); })
    .filter(function (u) { return u && u.active === '1'; });
  if (!route.length) fail_('この申請の承認者が登録されていません。管理者に連絡してください。');
  var defs = []; try { defs = JSON.parse(type.fields || '[]'); } catch (e) {}
  var missing = [];
  var fields = defs.map(function (f, i) {
    var v = clip_(values[i], 2000);
    if (f.required && v === '') missing.push(f.label);
    return { label: f.label, kind: f.kind, value: v };
  });
  if (missing.length) fail_('次の項目を入力してください：' + missing.join('、'));
  var no = Utilities.formatDate(new Date(), TZ, 'yyMMdd') + '-' + randToken_().substring(0, 4).toUpperCase();
  var r = insert_('requests', {
    no: no, type_id: type.id, type_name: type.name, cert_title: type.cert_title, student_id: student.id, student_name: student.name,
    room: student.room, submitted_by: by.id, fields: JSON.stringify(fields), status: 'pending', notify_guardians: type.notify_guardians,
    created_at: now_(), closed_at: ''
  });
  var tokens = {};
  var steps = route.map(function (u, i) {
    var t = randToken_(); tokens[u.id] = t;
    return insert_('steps', { request_id: r.id, sort: i, approver_id: u.id, approver_name: u.name, approver_title: u.title, status: 'pending', decided_at: '', comment: '', token_hash: sha_(t) });
  });
  var res = { sent: 0, failed: 0 };
  var info = '申請番号：' + r.no + '\n申請者：' + r.student_name + (r.room ? '（' + r.room + '）' : '') + '\n申請日時：' + fmtDt_(r.created_at) + '\n\n' + detail_(r);
  route.forEach(function (u) {
    tally_(res, sendMail_([u], '【承認依頼】' + r.type_name + '（' + r.student_name + (r.room ? '・' + r.room : '') + '）',
      u.name + ' 様\n\n' + r.student_name + 'さんから' + r.type_name + 'の申請が届きました。\n内容を確認し、下のボタンから「承認する」か「承認しない」を選んでください。\n\n' + info
      + '\n\n承認者：' + approversText_(steps) + '（全員の承認がそろうと許可になります）',
      { request_id: r.id, buttons: [['承認する', approveLink_(tokens[u.id], 'ok'), '#27466B'], ['承認しない', approveLink_(tokens[u.id], 'ng'), '#9A3A2E']] }));
  });
  tally_(res, sendMail_([student], '【受付】' + r.type_name + 'の申請を受け付けました',
    student.name + ' さん\n\n' + r.type_name + 'の申請を受け付けました。承認がそろうとメールでお知らせします。\n\n申請番号：' + r.no + '\n' + detail_(r) + '\n\n承認者：' + approversText_(steps),
    { request_id: r.id, buttons: [['申請一覧を開く', link_('history')]] }));
  return { r: r, res: res };
}

function decideStep_(step, ok, comment) {
  needAppUrl_();
  var r = byId_('requests', step.request_id);
  if (!r || r.status !== 'pending' || step.status !== 'pending') fail_('この申請はすでに処理されています。');
  comment = clip_(comment, 1000);
  var n = now_();
  update_('steps', step, { status: ok ? 'approved' : 'rejected', decided_at: n, comment: comment, token_hash: '' });
  var steps = stepsOf_(r.id);
  var final = null;
  if (!ok) {
    update_('requests', r, { status: 'rejected', closed_at: n });
    steps.forEach(function (s) { if (s.status === 'pending') update_('steps', s, { status: 'closed', token_hash: '' }); });
    final = 'rejected';
  } else if (steps.every(function (s) { return s.status === 'approved'; })) {
    update_('requests', r, { status: 'approved', closed_at: n });
    final = 'approved';
  }
  var student = byId_('users', r.student_id);
  var approvers = steps.map(function (s) { return byId_('users', s.approver_id); }).filter(Boolean);
  var res = { sent: 0, failed: 0 };
  var who = step.approver_name + (step.approver_title ? '（' + step.approver_title + '）' : '');
  if (final === 'rejected') {
    if (student) tally_(res, sendMail_([student], '【非承認】' + r.type_name + 'の申請は承認されませんでした',
      r.student_name + ' さん\n\n申請番号 ' + r.no + ' の' + r.type_name + 'は、' + who + 'により承認されませんでした。\n' + (comment ? '\nコメント：' + comment + '\n' : '') + '\n内容を見直して、必要であれば改めて申請してください。',
      { request_id: r.id, buttons: [['申請一覧を開く', link_('history')]] }));
    tally_(res, sendMail_(approvers, '【結果】' + r.type_name + '（' + r.student_name + '）は非承認になりました',
      '承認者の皆さま\n\n申請番号 ' + r.no + '（' + r.student_name + 'さんの' + r.type_name + '）は、' + who + 'の判断により非承認となりました。\n' + (comment ? 'コメント：' + comment + '\n' : '') + '\n' + detail_(r),
      { request_id: r.id }));
  } else if (final === 'approved') {
    if (student) tally_(res, sendMail_([student], '【許可】' + r.type_name + 'の申請が承認されました',
      r.student_name + ' さん\n\n申請番号 ' + r.no + ' の' + r.type_name + 'が、すべての承認者に承認されました。\n' + r.cert_title + 'は申請一覧からPDFで保存できます。\n\n' + detail_(r),
      { request_id: r.id, buttons: [['許可書を見る', link_('r-' + r.id)]] }));
    if (r.notify_guardians === '1') {
      var g = guardiansOf_(r.student_id);
      if (g.length) tally_(res, sendMail_(g, '【お知らせ】' + r.student_name + 'さんの' + r.type_name + 'が許可されました',
        '保護者の皆さま\n\n' + org_() + 'です。\n' + r.student_name + 'さんから申請のあった' + r.type_name + 'について、寮の承認がすべて完了しましたのでお知らせします。\n\n' + detail_(r) + '\n\n承認日時：' + fmtDt_(r.closed_at) + '\nご不明な点は寮までお問い合わせください。',
        { request_id: r.id }));
    }
    tally_(res, sendMail_(approvers, '【承認完了】' + r.type_name + '（' + r.student_name + '）',
      '承認者の皆さま\n\n申請番号 ' + r.no + '（' + r.student_name + 'さんの' + r.type_name + '）は、すべての承認がそろいました。\n' + r.cert_title + 'が発行されています。\n\n'
      + steps.map(function (s) { return s.approver_name + '：承認 ' + fmtDt_(s.decided_at) + (s.comment ? '（' + s.comment + '）' : ''); }).join('\n'),
      { request_id: r.id, buttons: [['申請を開く', link_('r-' + r.id)]] }));
  }
  return { r: r, res: res, final: final };
}

/* ===================== 操作の一覧 ===================== */
var WRITE_ACTIONS = { reload_data: 1, install: 1, login: 1, logout: 1, forgot: 1, setpw: 1, change_password: 1, submit: 1, decide: 1, withdraw: 1, approve_decide: 1,
  resend: 1, test_mail: 1, save_settings: 1, save_user: 1, delete_user: 1, save_route: 1, delete_route: 1, save_type: 1, delete_type: 1, sample: 1 };

var STATE_ACTIONS = { install: 1, login: 1, setpw: 1, submit: 1, decide: 1, withdraw: 1, save_settings: 1, save_user: 1, delete_user: 1,
  save_route: 1, delete_route: 1, save_type: 1, delete_type: 1, sample: 1, reload_data: 1 };

var ACTIONS = {
  /* ----- 起動・ログイン ----- */
  bootstrap: function (ctx) {
    var me = ctx.me;
    var base = { org: org_(), needsInstall: all_('users').length === 0, me: null };
    if (!me) return base;
    var people;
    if (me.role === 'staff') people = all_('users').slice().sort(function (a, b) { return (a.role + a.name).localeCompare(b.role + b.name, 'ja'); }).map(function (u) { return userPublic_(u, true); });
    else if (me.role === 'guardian') people = where_('guardians', function (g) { return g.guardian_id === me.id; }).map(function (g) { return byId_('users', g.student_id); }).filter(Boolean).map(function (u) { return userPublic_(u, false); }).concat([userPublic_(me, true)]);
    else people = [userPublic_(me, true)];
    var types = all_('types').slice().sort(function (a, b) { return Number(a.sort) - Number(b.sort) || Number(a.id) - Number(b.id); }).map(function (t) {
      var f = []; try { f = JSON.parse(t.fields || '[]'); } catch (e) {}
      return { id: Number(t.id), name: t.name, certTitle: t.cert_title, routeId: t.route_id ? Number(t.route_id) : null, notifyGuardians: t.notify_guardians === '1', active: t.active === '1', sort: Number(t.sort) || 0, fields: f };
    });
    // 1年より前に終わった申請は、頼まれたときだけ送る（画面を軽く保つため）
    var reqs = visibleRequests_(me), older = 0;
    if (!ctx.input.all) {
      var since = Utilities.formatDate(new Date(Date.now() - 365 * 86400000), TZ, 'yyyy-MM-dd');
      var recent = reqs.filter(function (r) { return r.status === 'pending' || String(r.createdAt) >= since; });
      older = reqs.length - recent.length; reqs = recent;
    }
    var routes = all_('routes').slice().sort(function (a, b) { return a.name.localeCompare(b.name, 'ja'); }).map(function (r) {
      return { id: Number(r.id), name: r.name, steps: where_('route_steps', function (s) { return s.route_id === r.id; }).sort(function (a, b) { return Number(a.sort) - Number(b.sort); })
        .map(function (s) { var u = byId_('users', s.approver_id) || {}; return { approverId: Number(s.approver_id), name: u.name || '（削除済み）', title: u.title || '', active: u.active === '1' }; }) };
    });
    return { org: base.org, needsInstall: false, me: userPublic_(me, true), people: people, types: types, routes: routes, requests: reqs, olderCount: older, mailMode: 'gmail', appUrl: appUrl_() };
  },

  install: function (ctx) {
    var i = ctx.input;
    if (all_('users').length) fail_('すでに初期設定が終わっています。');
    var name = clip_(i.name, 100), email = clip_(i.email, 255).toLowerCase(), pw = String(i.password || '');
    if (!name || !validEmail_(email)) fail_('氏名とメールアドレスを正しく入力してください。');
    if (pw.length < 8) fail_('パスワードは8文字以上にしてください。');
    setSetting_('org_name', clip_(i.org, 100));
    if (i.appUrl) setSetting_('app_url', clip_(i.appUrl, 300));
    var u = insert_('users', { name: name, email: email, role: 'staff', title: clip_(i.title, 50), room: '', homeroom_id: '', is_admin: 1, pw_hash: '', pw_salt: '', active: 1, created_at: now_() });
    setPassword_(u, pw);
    ctx.me = u;
    return { ok: true, token: startSession_(u.id) };
  },

  login: function (ctx) {
    var email = clip_(ctx.input.email, 255).toLowerCase();
    var cache = CacheService.getScriptCache(), key = 'fail_' + sha_(email).substring(0, 32);
    var fails = Number(cache.get(key) || 0);
    if (fails >= 10) fail_('ログインに続けて失敗したため、15分間ログインできません。', 429);
    var u = find_('users', function (x) { return x.email.toLowerCase() === email && x.active === '1'; });
    if (!u || !u.pw_hash || !safeEq_(hashPw_(String(ctx.input.password || ''), u.pw_salt), u.pw_hash)) {
      cache.put(key, String(fails + 1), 900);
      Utilities.sleep(800);
      fail_('メールアドレスかパスワードが違います。', 401);
    }
    cache.remove(key);
    ctx.me = u;
    return { ok: true, token: startSession_(u.id) };
  },

  logout: function (ctx) {
    if (ctx.token) { var h = sha_(ctx.token); removeWhere_('sessions', function (x) { return x.token_hash === h; }); }
    return { ok: true };
  },

  forgot: function (ctx) {
    var email = clip_(ctx.input.email, 255).toLowerCase();
    var u = find_('users', function (x) { return x.email.toLowerCase() === email && x.active === '1'; });
    if (u && appUrl_()) {
      var t = makeToken_(u.id, 'pw', 1);
      sendMail_([u], '【' + org_() + '】パスワードの設定', u.name + ' さん\n\n申請・承認システムのパスワードを設定するには、下のボタンを押してください。\nこのリンクの有効期限は24時間です。\n\n心当たりがない場合は、このメールを削除してください。',
        { buttons: [['パスワードを設定する', appUrl_() + '/?reset=' + t]] });
    } else Utilities.sleep(800);
    return { ok: true, message: '登録されているアドレスであれば、パスワード設定のメールを送りました。' };
  },

  setpw: function (ctx) {
    var h = sha_(String(ctx.input.token || ''));
    var tk = find_('tokens', function (x) { return x.token_hash === h && x.purpose === 'pw'; });
    if (!tk || tk.expires_at < now_()) fail_('リンクの有効期限が切れています。もう一度「パスワードを忘れた」から送ってください。');
    var pw = String(ctx.input.password || '');
    if (pw.length < 8) fail_('パスワードは8文字以上にしてください。');
    var u = byId_('users', tk.user_id);
    if (!u || u.active !== '1') fail_('このアカウントは使えません。管理者に連絡してください。');
    setPassword_(u, pw);
    removeWhere_('tokens', function (x) { return x.user_id === u.id && x.purpose === 'pw'; });
    ctx.me = u;
    return { ok: true, token: startSession_(u.id) };
  },

  change_password: function (ctx) {
    var m = needLogin_(ctx);
    if (!safeEq_(hashPw_(String(ctx.input.current || ''), m.pw_salt), m.pw_hash)) fail_('今のパスワードが違います。');
    if (String(ctx.input.password || '').length < 8) fail_('新しいパスワードは8文字以上にしてください。');
    setPassword_(m, ctx.input.password);
    return { ok: true };
  },

  /* ----- 申請・承認 ----- */
  submit: function (ctx) {
    var m = needLogin_(ctx), i = ctx.input;
    if (m.role === 'guardian') fail_('保護者は申請できません。', 403);
    var type = find_('types', function (t) { return t.id === String(i.typeId) && t.active === '1'; });
    if (!type) fail_('申請の種類が見つかりません。');
    var sid = m.role === 'student' ? m.id : String(i.studentId || '');
    var student = find_('users', function (u) { return u.id === sid && u.role === 'student' && u.active === '1'; });
    if (!student) fail_('申請する寮生を選んでください。');
    var out = createRequest_(type, student, i.values || [], m);
    return { request: requestPublic_(out.r), message: '申請しました（申請番号 ' + out.r.no + '）。' + mailNote_(out.res) };
  },

  decide: function (ctx) {
    var m = needStaff_(ctx), rid = String(ctx.input.requestId || '');
    var s = find_('steps', function (x) { return x.request_id === rid && x.approver_id === m.id && x.status === 'pending'; });
    if (!s) fail_('この申請はあなたの承認待ちではありません。');
    var out = decideStep_(s, !!ctx.input.ok, ctx.input.comment);
    return { message: (ctx.input.ok ? '承認しました。' : '非承認にしました。') + mailNote_(out.res) };
  },

  withdraw: function (ctx) {
    var m = needLogin_(ctx);
    var r = byId_('requests', ctx.input.requestId);
    if (!r || !(m.role === 'staff' || r.student_id === m.id)) fail_('この申請は取り下げできません。', 403);
    if (r.status !== 'pending') fail_('この申請は取り下げできません。');
    var n = now_();
    update_('requests', r, { status: 'withdrawn', closed_at: n });
    var steps = stepsOf_(r.id);
    steps.forEach(function (s) { if (s.status === 'pending') update_('steps', s, { status: 'closed', token_hash: '' }); });
    var res = { sent: 0, failed: 0 };
    tally_(res, sendMail_(steps.map(function (s) { return byId_('users', s.approver_id); }).filter(Boolean), '【取り下げ】' + r.type_name + '（' + r.student_name + '）',
      '承認者の皆さま\n\n申請番号 ' + r.no + '（' + r.student_name + 'さんの' + r.type_name + '）は取り下げられました。対応は不要です。', { request_id: r.id }));
    return { message: '取り下げました。' + mailNote_(res) };
  },

  /* メールのボタンから開く承認ページ用（ログイン不要・使い捨ての鍵で確認） */
  approve_info: function (ctx) {
    var t = String(ctx.input.t || '').replace(/[^a-f0-9]/g, '');
    var h = t ? sha_(t) : '';
    var s = h ? find_('steps', function (x) { return x.token_hash === h; }) : null;
    if (!s) return { org: org_(), valid: false, reason: 'used' };
    var r = byId_('requests', s.request_id);
    var pub = requestPublic_(r);
    return { org: org_(), valid: r.status === 'pending' && s.status === 'pending', reason: r.status, approverName: s.approver_name, request: pub };
  },
  approve_decide: function (ctx) {
    var t = String(ctx.input.t || '').replace(/[^a-f0-9]/g, '');
    var h = t ? sha_(t) : '';
    var s = h ? find_('steps', function (x) { return x.token_hash === h; }) : null;
    if (!s) fail_('このリンクは使えません。すでに回答済みか、取り下げられた申請です。');
    var ok = ctx.input.decision === 'ok';
    if (!ok && ctx.input.decision !== 'ng') fail_('「承認する」か「承認しない」を選んでください。');
    var out = decideStep_(s, ok, ctx.input.comment);
    return { ok: true, decision: ok ? 'ok' : 'ng', final: out.final, request: requestPublic_(out.r) };
  },

  /* ----- 管理者 ----- */
  mails: function (ctx) {
    needAdmin_(ctx);
    var last = mailSheet_().getLastRow(), from = Math.max(2, last - 299);
    var list = mailRows_(from, last - from + 1).reverse().map(function (m) {
      return { id: Number(m.id), request_id: m.request_id, to_addr: JSON.parse(m.to_addr || '[]'), to_names: JSON.parse(m.to_names || '[]'), subject: m.subject, body: m.body, status: m.status, error: m.error, created_at: m.created_at, sent_at: m.sent_at };
    });
    return { mails: list, quota: MailApp.getRemainingDailyQuota() };
  },
  resend: function (ctx) {
    needAdmin_(ctx);
    var mid = Number(ctx.input.id) || 0;
    var m = mid > 0 ? mailRows_(mid + 1, 1)[0] : null;
    if (!m) fail_('メールが見つかりません。');
    var st = deliver_(m);
    return { message: st === 'failed' ? '送れませんでした。エラー内容を確認してください。' : 'メールを送りました。' };
  },
  test_mail: function (ctx) {
    var m = needAdmin_(ctx);
    var st = sendMail_([m], '【テスト】' + org_() + ' 申請・承認システム', m.name + ' 様\n\nメール送信のテストです。このメールが届いていれば、通知メールは正しく送られます。');
    return { message: st === 'failed' ? '送れませんでした。「送信メール」でエラー内容を確認してください。' : m.email + ' にテストメールを送りました。' };
  },
  save_settings: function (ctx) {
    needAdmin_(ctx);
    setSetting_('org_name', clip_(ctx.input.org, 100));
    if (ctx.input.appUrl) setSetting_('app_url', clip_(ctx.input.appUrl, 300));
    setSetting_('mail_from_name', clip_(ctx.input.fromName, 100));
    setSetting_('mail_reply_to', validEmail_(ctx.input.replyTo) ? clip_(ctx.input.replyTo, 255) : '');
    return { ok: true };
  },
  reload_data: function (ctx) {
    needAdmin_(ctx);
    CacheService.getScriptCache().removeAll(CACHED_TABLES.map(function (n) { return CKEY + n; }));
    DB_ = {}; DIRTY_ = {};
    ctx.me = byId_('users', ctx.me.id);
    return { message: 'スプレッドシートから読み直しました。' };
  },
  get_settings: function (ctx) {
    needAdmin_(ctx);
    return { org: org_(), appUrl: appUrl_(), fromName: setting_('mail_from_name'), replyTo: setting_('mail_reply_to'), quota: MailApp.getRemainingDailyQuota() };
  },

  save_user: function (ctx) {
    var me = needAdmin_(ctx), i = ctx.input;
    var id = String(i.id || '');
    if (id === '0') id = '';
    var role = ['student', 'staff', 'guardian'].indexOf(i.role) >= 0 ? i.role : 'student';
    var name = clip_(i.name, 100), email = clip_(i.email, 255).toLowerCase();
    if (!name) fail_('氏名を入力してください。');
    if (!validEmail_(email)) fail_('メールアドレスを正しく入力してください。');
    if (find_('users', function (u) { return u.email.toLowerCase() === email && u.id !== id; })) fail_('このメールアドレスはすでに登録されています。');
    var vals = {
      name: name, email: email, role: role, title: role === 'staff' ? clip_(i.title, 50) : '', room: role === 'student' ? clip_(i.room, 50) : '',
      homeroom_id: role === 'student' && i.homeroomId ? String(i.homeroomId) : '', is_admin: role === 'staff' && i.isAdmin ? 1 : 0,
      active: i.active === false ? 0 : 1
    };
    var u;
    if (id) {
      u = byId_('users', id); if (!u) fail_('見つかりません。');
      if (id === me.id && (role !== 'staff' || !vals.is_admin || !vals.active)) fail_('自分自身の管理者権限は外せません。');
      update_('users', u, vals);
      if (!vals.active) removeWhere_('sessions', function (x) { return x.user_id === id; });
    } else {
      vals.pw_hash = ''; vals.pw_salt = ''; vals.created_at = now_();
      u = insert_('users', vals);
    }
    var pw = String(i.password || '');
    if (pw) { if (pw.length < 8) fail_('パスワードは8文字以上にしてください。'); setPassword_(u, pw); }
    removeWhere_('guardians', function (g) { return g.student_id === u.id; });
    if (role === 'student') {
      var seen = {};
      (i.guardianIds || []).forEach(function (g) { g = String(g); if (!seen[g] && byId_('users', g)) { seen[g] = 1; insert_('guardians', { student_id: u.id, guardian_id: g }); } });
    }
    var msg = '保存しました。';
    if (i.invite && vals.active) {
      needAppUrl_();
      var t = makeToken_(u.id, 'pw', 7);
      var st = sendMail_([u], '【' + org_() + '】申請・承認システムのご案内', u.name + ' さん\n\n' + org_() + 'の寮の申請・承認システムに登録しました。\n下のボタンからパスワードを決めると使えるようになります（有効期限7日）。\n\nログインに使うメールアドレス：' + u.email,
        { buttons: [['パスワードを決める', appUrl_() + '/?reset=' + t]] });
      msg += st === 'failed' ? '案内メールは送れませんでした。' : '案内メールを送りました。';
    }
    return { message: msg, id: Number(u.id) };
  },
  delete_user: function (ctx) {
    var me = needAdmin_(ctx), id = String(ctx.input.id || '');
    if (id === me.id) fail_('自分自身は削除できません。');
    if (find_('route_steps', function (s) { return s.approver_id === id; })) fail_('承認ルートで使われているため削除できません。先にルートから外してください。');
    var used = find_('requests', function (r) { return r.student_id === id || r.submitted_by === id; }) || find_('steps', function (s) { return s.approver_id === id; });
    var u = byId_('users', id); if (!u) fail_('見つかりません。');
    removeWhere_('sessions', function (x) { return x.user_id === id; });
    if (used) { update_('users', u, { active: 0, pw_hash: '', pw_salt: '' }); return { message: '申請の記録があるため、利用停止にしました（記録は残ります）。' }; }
    removeWhere_('guardians', function (g) { return g.student_id === id || g.guardian_id === id; });
    where_('users', function (x) { return x.homeroom_id === id; }).forEach(function (x) { update_('users', x, { homeroom_id: '' }); });
    removeWhere_('users', function (x) { return x.id === id; });
    return { message: '削除しました。' };
  },
  save_route: function (ctx) {
    needAdmin_(ctx);
    var name = clip_(ctx.input.name, 100);
    var steps = (ctx.input.steps || []).map(String).filter(function (s) { return s && s !== '0'; });
    if (!name) fail_('ルートの名前を入力してください。');
    if (!steps.length) fail_('承認者を1人以上追加してください。');
    var id = String(ctx.input.id || ''); if (id === '0') id = '';
    var r;
    if (id) { r = byId_('routes', id); if (!r) fail_('見つかりません。'); update_('routes', r, { name: name }); }
    else r = insert_('routes', { name: name });
    removeWhere_('route_steps', function (s) { return s.route_id === r.id; });
    steps.forEach(function (sid, i) { insert_('route_steps', { route_id: r.id, sort: i, approver_id: sid }); });
    return { message: '保存しました。' };
  },
  delete_route: function (ctx) {
    needAdmin_(ctx);
    var id = String(ctx.input.id || '');
    var t = find_('types', function (x) { return x.route_id === id; });
    if (t) fail_('申請の種類「' + t.name + '」で使われているため削除できません。');
    removeWhere_('route_steps', function (s) { return s.route_id === id; });
    removeWhere_('routes', function (x) { return x.id === id; });
    return { message: '削除しました。' };
  },
  save_type: function (ctx) {
    needAdmin_(ctx);
    var i = ctx.input, name = clip_(i.name, 100);
    if (!name) fail_('申請の名前を入力してください。');
    if (!i.routeId) fail_('承認ルートを選んでください。');
    var kinds = ['text', 'textarea', 'date', 'datetime', 'tel', 'number'];
    var fields = (i.fields || []).map(function (f) {
      var label = clip_(f.label, 100); if (!label) fail_('項目名が空の行があります。');
      return { label: label, kind: kinds.indexOf(f.kind) >= 0 ? f.kind : 'text', required: !!f.required };
    });
    var vals = { name: name, cert_title: clip_(i.certTitle, 100) || name + '許可書', route_id: String(i.routeId), notify_guardians: i.notifyGuardians ? 1 : 0, active: i.active ? 1 : 0, sort: Number(i.sort) || 0, fields: JSON.stringify(fields) };
    var id = String(i.id || ''); if (id === '0') id = '';
    if (id) { var t = byId_('types', id); if (!t) fail_('見つかりません。'); update_('types', t, vals); }
    else insert_('types', vals);
    return { message: '保存しました。' };
  },
  delete_type: function (ctx) {
    needAdmin_(ctx);
    var id = String(ctx.input.id || '');
    var t = byId_('types', id); if (!t) fail_('見つかりません。');
    if (find_('requests', function (r) { return r.type_id === id; })) { update_('types', t, { active: 0 }); return { message: '申請の記録があるため、非表示にしました。' }; }
    removeWhere_('types', function (x) { return x.id === id; });
    return { message: '削除しました。' };
  },
  sample: function (ctx) {
    var me = needAdmin_(ctx);
    if (all_('types').length) fail_('すでに申請の種類が登録されています。');
    var r = insert_('routes', { name: '寮の申請（承認者を追加してください）' });
    insert_('route_steps', { route_id: r.id, sort: 0, approver_id: me.id });
    var mk = function (name, cert, fields, sort) { insert_('types', { name: name, cert_title: cert, route_id: r.id, notify_guardians: 1, active: 1, sort: sort, fields: JSON.stringify(fields) }); };
    mk('外泊', '外泊許可書', [{ label: '外泊開始', kind: 'datetime', required: true }, { label: '帰寮予定', kind: 'datetime', required: true }, { label: '行き先（住所）', kind: 'text', required: true }, { label: '外泊先の連絡先', kind: 'tel', required: true }, { label: '理由', kind: 'textarea', required: true }], 0);
    mk('外出', '外出許可書', [{ label: '外出日時', kind: 'datetime', required: true }, { label: '帰寮予定', kind: 'datetime', required: true }, { label: '行き先', kind: 'text', required: true }, { label: '目的', kind: 'text', required: false }], 1);
    mk('帰省', '帰省許可書', [{ label: '出発日', kind: 'date', required: true }, { label: '帰寮日', kind: 'date', required: true }, { label: '帰省先', kind: 'text', required: true }, { label: '交通手段', kind: 'text', required: false }], 2);
    return { message: '外泊・外出・帰省の3種類と承認ルートを登録しました。承認ルートに承認者を追加してください。' };
  }
};
