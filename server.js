// Pi Bilardo — sunucu (Node 18+, harici paket yok)
// Görevleri: oyunu sunmak, Pi kullanıcısını doğrulamak, Pi ödemelerini onaylamak/tamamlamak,
// çevrimiçi odaları yönetmek (SSE ile canlı), sıra gelince Pi bildirimi göndermek, istatistik saklamak.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Yerelde .env dosyasını oku (varsa). Barındırma sağlayıcısındaki gerçek ortam değişkenleri önceliklidir.
try {
  for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
} catch (_) {}

const PORT = Number(process.env.PORT || 3000);
const PI_API = 'https://api.minepi.com/v2';
const PI_NETWORK_API_KEY = process.env.PI_NETWORK_API_KEY || ''; // Pi Developers > Settings > API key (sadece sunucuda!)
const PI_VALIDATION_KEY = process.env.PI_VALIDATION_KEY || '';   // alan adı doğrulama anahtarı
const PI_APP_URL = process.env.PI_APP_URL || '';                 // https://<isim>.pinet.com (davet linkleri için)
const ALLOW_GUEST = process.env.ALLOW_GUEST === '1';             // yalnızca geliştirme: Pi girişi olmadan çevrimiçi test
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'data.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

// Satılan ürünler: fiyat sunucuda tanımlı, istemciye güvenilmez
const ITEMS = { gold_cue: 0.5, blue_table: 0.3, red_table: 0.3 };
const ROOM_TTL = 7 * 24 * 3600 * 1000;

/* ---------- basit JSON veritabanı ---------- */
let db = {};
try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (_) {}
for (const k of ['users', 'payments', 'sessions', 'rooms']) db[k] = db[k] || {};
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, DB_FILE);
  }, 200);
}
function user(uid) { return db.users[uid] || (db.users[uid] = { items: [] }); }
function userItems(uid) { return (db.users[uid] && db.users[uid].items) || []; }
function grant(uid, itemId) { const u = user(uid); if (!u.items.includes(itemId)) u.items.push(itemId); save(); }

/* ---------- Pi Platform API ---------- */
function httpErr(status, message) { const e = new Error(message); e.status = status; return e; }
async function piServer(method, p, body) {
  if (!PI_NETWORK_API_KEY) throw httpErr(500, 'PI_NETWORK_API_KEY tanımlı değil');
  const r = await fetch(PI_API + p, {
    method,
    headers: { Authorization: 'Key ' + PI_NETWORK_API_KEY, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw httpErr(502, 'Pi API ' + r.status + ': ' + (j.error_message || j.error || 'hata'));
  return j;
}
async function piMe(accessToken) {
  if (!accessToken) throw httpErr(401, 'accessToken eksik');
  const r = await fetch(PI_API + '/me', { headers: { Authorization: 'Bearer ' + accessToken } });
  if (!r.ok) throw httpErr(401, 'Pi oturumu doğrulanamadı');
  return r.json(); // { uid, username, ... }
}
// Pi Notification Center'a bildirim (kullanıcı in_app_notifications iznini vermiş olmalı)
async function notify(uid, title, body, subroute) {
  if (!PI_NETWORK_API_KEY || uid.startsWith('guest_')) return;
  try {
    await piServer('POST', '/in_app_notifications/notify', {
      notifications: [{ title: title.slice(0, 80), body: body.slice(0, 200), user_uid: uid, subroute }],
    });
  } catch (e) { console.warn('bildirim gönderilemedi:', e.message); }
}

/* ---------- oturumlar ---------- */
function newSession(uid, username, guest) {
  const sid = crypto.randomBytes(24).toString('base64url');
  db.sessions[sid] = { uid, username, guest: !!guest, at: Date.now() };
  save();
  return sid;
}
function auth(sid) {
  const s = sid && db.sessions[sid];
  if (!s) throw httpErr(401, 'Oturum yok, tekrar giriş yap');
  return s;
}

/* ---------- ödeme işlemleri ---------- */
async function approvePayment(paymentId, accessToken) {
  const me = await piMe(accessToken);
  const pay = await piServer('GET', '/payments/' + encodeURIComponent(paymentId));
  const itemId = pay.metadata && pay.metadata.itemId;
  if (pay.user_uid !== me.uid) throw httpErr(403, 'Ödeme bu kullanıcıya ait değil');
  if (!(itemId in ITEMS)) throw httpErr(400, 'Bilinmeyen ürün');
  if (Number(pay.amount) !== ITEMS[itemId]) throw httpErr(400, 'Tutar uyuşmuyor');
  if (userItems(me.uid).includes(itemId)) throw httpErr(409, 'Bu ürün zaten sende');
  await piServer('POST', '/payments/' + encodeURIComponent(paymentId) + '/approve');
  db.payments[paymentId] = { uid: me.uid, itemId, amount: pay.amount, status: 'approved', at: Date.now() };
  save();
  return { ok: true };
}
async function completePayment(paymentId, txid) {
  if (!txid) throw httpErr(400, 'txid eksik');
  const pay = await piServer('POST', '/payments/' + encodeURIComponent(paymentId) + '/complete', { txid });
  const itemId = pay.metadata && pay.metadata.itemId;
  if (itemId in ITEMS) grant(pay.user_uid, itemId);
  db.payments[paymentId] = { ...(db.payments[paymentId] || {}), uid: pay.user_uid, itemId, txid, status: 'completed', at: Date.now() };
  save();
  return { ok: true, items: userItems(pay.user_uid) };
}

/* ---------- çevrimiçi odalar ---------- */
const streams = new Map(); // roomId -> Set<{res, uid}>
function online(roomId, uid) { const s = streams.get(roomId); return !!s && [...s].some(c => c.uid === uid); }
function broadcast(roomId, event, data) {
  const s = streams.get(roomId); if (!s) return;
  const msg = 'event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n';
  for (const c of s) c.res.write(msg);
}
function roomView(room) {
  return { id: room.id, players: room.players.map(p => ({ name: p.name, online: online(room.id, p.uid) })), state: room.state, seq: room.seq };
}
function getRoom(id) {
  const room = db.rooms[String(id || '').toUpperCase()];
  if (!room) throw httpErr(404, 'Oda bulunamadı');
  return room;
}
function memberIndex(room, uid) { return room.players.findIndex(p => p.uid === uid); }
function validState(st) {
  return st && Array.isArray(st.balls) && st.balls.length === 16 &&
    st.balls.every(b => Array.isArray(b) && b.length === 4 && b.every(Number.isFinite)) &&
    (st.cur === 0 || st.cur === 1) && Array.isArray(st.groups) && st.groups.length === 2;
}
function newRoomId() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id; do { id = Array.from(crypto.randomBytes(6), b => A[b % A.length]).join(''); } while (db.rooms[id]);
  return id;
}
function pruneRooms() {
  const now = Date.now();
  for (const [id, r] of Object.entries(db.rooms)) if (now - r.updatedAt > ROOM_TTL) delete db.rooms[id];
  for (const [sid, s] of Object.entries(db.sessions)) if (now - s.at > 30 * 24 * 3600 * 1000) delete db.sessions[sid];
  save();
}
setInterval(pruneRooms, 3600 * 1000).unref();
function inviteUrl(id) { return (PI_APP_URL || '') + '/?room=' + id; }

/* ---------- HTTP yardımcıları ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.json': 'application/json' };
function securityHeaders(res) {
  // Pi Sandbox ve Pi Browser uygulamayı iframe içinde açar: X-Frame-Options GÖNDERMİYORUZ.
  res.setHeader('Content-Security-Policy',
    "frame-ancestors 'self' https://*.pinet.com https://*.minepi.com; " +
    "connect-src 'self' https://socialchain.app https://api.minepi.com");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
}
function send(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 2e5) { reject(httpErr(413, 'çok büyük')); req.destroy(); } });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(httpErr(400, 'geçersiz JSON')); } });
  });
}

/* ---------- API ---------- */
const routes = {
  'GET /api/config': async () => ({ allowGuest: ALLOW_GUEST, appUrl: PI_APP_URL }),

  // Giriş: Pi accessToken'ı sunucuda doğrula, oturum aç, ürün ve istatistikleri döndür
  'POST /api/login': async b => {
    const me = await piMe(b.accessToken);
    const u = user(me.uid); u.username = me.username; u.lastSeen = Date.now(); save();
    return { sid: newSession(me.uid, me.username), uid: me.uid, username: me.username, items: u.items, stats: u.stats || null };
  },
  'POST /api/guest': async b => {
    if (!ALLOW_GUEST) throw httpErr(403, 'Misafir girişi kapalı');
    const uid = 'guest_' + crypto.randomBytes(6).toString('hex');
    const name = String(b.name || 'Misafir').slice(0, 20) + '-' + uid.slice(-3);
    return { sid: newSession(uid, name, true), uid, username: name, items: [], stats: null };
  },
  'POST /api/stats': async b => {
    const s = auth(b.sid);
    if (b.stats && typeof b.stats === 'object' && JSON.stringify(b.stats).length < 4000) { user(s.uid).stats = b.stats; save(); }
    return { ok: true };
  },

  'POST /api/payments/approve': b => approvePayment(String(b.paymentId || ''), b.accessToken),
  'POST /api/payments/complete': b => completePayment(String(b.paymentId || ''), b.txid),
  // Yarım kalmış ödeme: blokzincire işlenmişse tamamla, değilse iptal et
  'POST /api/payments/incomplete': async b => {
    const p = b.payment || {};
    const id = p.identifier;
    if (!id) throw httpErr(400, 'payment.identifier eksik');
    const txid = p.transaction && p.transaction.txid;
    if (txid) return completePayment(id, txid);
    await piServer('POST', '/payments/' + encodeURIComponent(id) + '/cancel');
    return { ok: true, cancelled: true };
  },

  // Oda kur: kuran kişi ilk durumu (dizilmiş masa) gönderir ve açılışı yapar
  'POST /api/rooms': async b => {
    const s = auth(b.sid);
    if (!validState(b.state)) throw httpErr(400, 'Geçersiz oyun durumu');
    const id = newRoomId(), now = Date.now();
    db.rooms[id] = { id, players: [{ uid: s.uid, name: s.username }], state: b.state, seq: 0, createdAt: now, updatedAt: now, notified: -1 };
    save();
    return { ...roomView(db.rooms[id]), me: 0, invite: inviteUrl(id) };
  },
  'POST /api/rooms/join': async b => {
    const s = auth(b.sid), room = getRoom(b.room);
    let me = memberIndex(room, s.uid);
    if (me < 0) {
      if (room.players.length >= 2) throw httpErr(409, 'Oda dolu');
      room.players.push({ uid: s.uid, name: s.username }); me = 1;
      room.updatedAt = Date.now(); save();
      const host = room.players[0];
      if (!online(room.id, host.uid)) notify(host.uid, 'Rakibin geldi!', s.username + ' bilardo odana katıldı. Açılış sende.', '/?room=' + room.id);
    }
    broadcast(room.id, 'room', roomView(room));
    return { ...roomView(room), me, invite: inviteUrl(room.id) };
  },
  // Nişan/beyaz top konumu canlı aktarımı (saklanmaz)
  'POST /api/rooms/aim': async b => {
    const s = auth(b.sid), room = getRoom(b.room), me = memberIndex(room, s.uid);
    if (me < 0 || room.state.cur !== me) return { ok: false };
    broadcast(room.id, 'aim', { from: me, aim: Number(b.aim) || 0, cue: b.cue && { x: +b.cue.x || 0, y: +b.cue.y || 0 } });
    return { ok: true };
  },
  // Atış: sırası gelen oyuncu atışı yayınlar, rakip aynı atışı kendi ekranında oynatır
  'POST /api/rooms/shot': async b => {
    const s = auth(b.sid), room = getRoom(b.room), me = memberIndex(room, s.uid);
    if (me < 0) throw httpErr(403, 'Bu odada değilsin');
    if (room.players.length < 2) throw httpErr(409, 'Rakip bekleniyor');
    if (room.state.cur !== me || room.state.phase === 'over') throw httpErr(409, 'Sıra sende değil');
    if (b.seq !== room.seq) throw httpErr(409, 'Durum eski, yenileniyor');
    const sh = b.shot || {};
    broadcast(room.id, 'shot', { from: me, seq: room.seq, shot: { aim: +sh.aim || 0, power: +sh.power || 0, spin: sh.spin || { x: 0, y: 0 }, cue: sh.cue } });
    return { ok: true };
  },
  // Atış sonrası durum: atışı yapan oyuncu kuralları uygular ve sonucu gönderir
  'POST /api/rooms/state': async b => {
    const s = auth(b.sid), room = getRoom(b.room), me = memberIndex(room, s.uid);
    if (me < 0) throw httpErr(403, 'Bu odada değilsin');
    if (!validState(b.state)) throw httpErr(400, 'Geçersiz oyun durumu');
    const reset = !!b.reset;
    if (reset) { if (room.state.phase !== 'over') throw httpErr(409, 'Oyun sürüyor'); }
    else {
      if (room.state.cur !== me) throw httpErr(409, 'Sıra sende değil');
      if (b.seq !== room.seq) throw httpErr(409, 'Durum eski');
    }
    room.state = b.state; room.seq++; room.updatedAt = Date.now(); save();
    broadcast(room.id, 'state', { from: me, seq: room.seq, state: room.state, players: roomView(room).players });
    // Sıra rakibe geçtiyse ve çevrimiçi değilse Pi bildirimi gönder (her sıra değişiminde bir kez)
    const next = room.players[room.state.cur];
    if (room.players.length === 2 && next && room.state.phase !== 'over' && room.state.cur !== me && room.notified !== room.seq && !online(room.id, next.uid)) {
      room.notified = room.seq;
      notify(next.uid, 'Sıra sende! 🎱', s.username + ' atışını yaptı. Pi Bilardo\'da sıra sende.', '/?room=' + room.id);
    }
    if (room.state.phase === 'over') {
      const other = room.players[1 - me];
      if (other && !online(room.id, other.uid)) notify(other.uid, 'Oyun bitti', 'Pi Bilardo odasındaki oyun sona erdi. Rövanş?', '/?room=' + room.id);
    }
    return { ok: true, seq: room.seq };
  },
};

function sse(req, res, url) {
  let s, room;
  try { s = auth(url.searchParams.get('sid')); room = getRoom(url.searchParams.get('room')); }
  catch (e) { return send(res, e.status || 400, { error: e.message }); }
  if (memberIndex(room, s.uid) < 0) return send(res, 403, { error: 'Bu odada değilsin' });
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  const c = { res, uid: s.uid };
  if (!streams.has(room.id)) streams.set(room.id, new Set());
  streams.get(room.id).add(c);
  res.write('retry: 2000\n\n');
  res.write('event: room\ndata: ' + JSON.stringify(roomView(room)) + '\n\n');
  broadcast(room.id, 'presence', roomView(room).players);
  const ping = setInterval(() => res.write(': ping\n\n'), 20000);
  req.on('close', () => {
    clearInterval(ping);
    const set = streams.get(room.id); if (set) { set.delete(c); if (!set.size) streams.delete(room.id); }
    broadcast(room.id, 'presence', roomView(room).players);
  });
}

const server = http.createServer(async (req, res) => {
  securityHeaders(res);
  const url = new URL(req.url, 'http://x');
  const key = req.method + ' ' + url.pathname;

  if (key === 'GET /api/rooms/events') return sse(req, res, url);
  if (routes[key]) {
    try { send(res, 200, await routes[key](req.method === 'GET' ? {} : await readBody(req))); }
    catch (e) { if (!e.status || e.status >= 500) console.error(key, e.message); send(res, e.status || 500, { error: e.message }); }
    return;
  }
  if (req.method === 'GET' && url.pathname === '/validation-key.txt') {
    if (!PI_VALIDATION_KEY) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end(PI_VALIDATION_KEY);
  }
  if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true });
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 404, { error: 'bulunamadı' });

  // statik dosyalar
  const rel = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('bulunamadı'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
});

server.listen(PORT, () => {
  console.log('Pi Bilardo http://localhost:' + PORT);
  if (!PI_NETWORK_API_KEY) console.warn('Uyarı: PI_NETWORK_API_KEY yok — oyun çalışır, Pi ödemeleri ve bildirimleri çalışmaz.');
  if (ALLOW_GUEST) console.warn('Uyarı: ALLOW_GUEST=1 — misafir girişi açık (sadece geliştirme için).');
});
