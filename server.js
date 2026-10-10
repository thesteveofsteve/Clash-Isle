#!/usr/bin/env node
// =====================================================================
//  CLASH ISLE - server per il gioco online
//  Nessuna dipendenza: serve solo Node.js (versione 16 o superiore).
//
//  Avvio:   node server.js            (porta 8080)
//           node server.js 3000       (porta a scelta)
//           PORT=3000 node server.js
//
//  Cosa fa:
//   - tiene l'elenco delle stanze (pubbliche o con password);
//   - mette in contatto i due giocatori di una stanza e inoltra i
//     messaggi di gioco fra loro (il gioco gira nei due browser);
//   - se nella stessa cartella c'e' il file index.html (o clash-isle.html)
//     lo serve anche, cosi' basta un solo indirizzo per giocare.
// =====================================================================
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');

const PORT = +(process.env.PORT || process.argv[2] || 8080);
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_ROOMS = 200, MAX_CLIENTS = 500, MAX_MSG = 8192, MAX_RATE = 600;

const rooms = new Map(), clients = new Set();
let nextId = 1;

const clean = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, n);
const hash = (salt, pw) => crypto.createHash('sha256').update(salt + ':' + pw).digest('hex');

// ---------------------------------------------------------------- HTTP
const server = http.createServer((req, res) => {
  const u = (req.url || '/').split('?')[0];
  if (u === '/' || u === '/index.html' || u === '/clash-isle.html') {
    const f = ['index.html', 'clash-isle.html'].map(n => path.join(__dirname, n)).find(p => fs.existsSync(p));
    if (f) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      fs.createReadStream(f).pipe(res);
      return;
    }
  }
  if (u === '/stato') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, giocatori: clients.size, stanze: rooms.size }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Clash Isle server attivo. Giocatori: ' + clients.size + ' - Stanze: ' + rooms.size + '\n');
});

// ---------------------------------------------------------------- WebSocket (RFC 6455, minimale)
server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key || String(req.headers.upgrade).toLowerCase() !== 'websocket' || clients.size >= MAX_CLIENTS) {
    socket.destroy();
    return;
  }
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  socket.setNoDelay(true);
  const c = { id: nextId++, socket, nick: 'Giocatore', room: null, buf: Buffer.alloc(0), frag: [], alive: true, rate: 0 };
  clients.add(c);
  socket.on('data', d => { c.buf = Buffer.concat([c.buf, d]); parse(c); });
  socket.on('close', () => drop(c));
  socket.on('error', () => drop(c));
});

function parse(c) {
  for (;;) {
    const b = c.buf;
    if (b.length < 2) return;
    const op = b[0] & 15, fin = !!(b[0] & 128), masked = !!(b[1] & 128);
    let len = b[1] & 127, off = 2;
    if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (b.length < 10) return; if (b.readUInt32BE(2) !== 0) return kill(c); len = b.readUInt32BE(6); off = 10; }
    if (len > MAX_MSG || !masked) return kill(c);
    if (b.length < off + 4 + len) return;
    const mask = b.slice(off, off + 4), pl = Buffer.alloc(len);
    for (let i = 0; i < len; i++) pl[i] = b[off + 4 + i] ^ mask[i & 3];
    c.buf = b.slice(off + 4 + len);
    if (op === 8) return kill(c);
    if (op === 9) { send(c, pl, 10); continue; }
    if (op === 10) { c.alive = true; continue; }
    if (op === 1 || op === 0) {
      c.frag.push(pl);
      if (fin) { const txt = Buffer.concat(c.frag).toString('utf8'); c.frag = []; msg(c, txt); }
    }
  }
}

function frame(data, op) {
  const p = Buffer.isBuffer(data) ? data : Buffer.from(String(data)), n = p.length;
  let h;
  if (n < 126) h = Buffer.from([128 | op, n]);
  else if (n < 65536) { h = Buffer.alloc(4); h[0] = 128 | op; h[1] = 126; h.writeUInt16BE(n, 2); }
  else { h = Buffer.alloc(10); h[0] = 128 | op; h[1] = 127; h.writeUInt32BE(n, 6); }
  return Buffer.concat([h, p]);
}
function send(c, data, op = 1) {
  if (c.socket.destroyed || !c.socket.writable) return;
  try { c.socket.write(frame(data, op)); } catch (e) { /* connessione chiusa */ }
}
const sj = (c, o) => send(c, JSON.stringify(o));
function kill(c) { try { c.socket.end(); } catch (e) { /* gia' chiusa */ } drop(c); }

// ---------------------------------------------------------------- logica delle stanze
function newCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (;;) {
    let s = '';
    for (let i = 0; i < 4; i++) s += A[crypto.randomInt(A.length)];
    if (![...rooms.values()].some(r => r.code === s)) return s;
  }
}
function info(r, c) {
  const o = r.m.find(x => x !== c);
  return { id: r.id, code: r.code, name: r.name, lock: r.lock, you: r.m.indexOf(c), host: r.m[0].nick, peer: o ? o.nick : null };
}
function list() {
  return [...rooms.values()]
    .sort((a, b) => a.m.length - b.m.length || b.created - a.created)
    .slice(0, 50)
    .map(r => ({ id: r.id, name: r.name, n: r.m.length, lock: r.lock, host: r.m[0].nick }));
}
function create(c, m) {
  if (c.room) leave(c);
  if (rooms.size >= MAX_ROOMS) return sj(c, { t: 'err', m: 'Il server e\' pieno: riprova piu\' tardi.' });
  const name = clean(m.name, 24) || ('Stanza di ' + c.nick), pw = String(m.pw || '').slice(0, 24);
  const r = { id: 'r' + (nextId++), code: newCode(), name, m: [c], salt: crypto.randomBytes(8).toString('hex'), h: null, lock: false, created: Date.now() };
  if (pw) { r.lock = true; r.h = hash(r.salt, pw); }
  rooms.set(r.id, r);
  c.room = r;
  sj(c, { t: 'joined', room: info(r, c) });
}
function join(c, m) {
  const r = m.code ? [...rooms.values()].find(x => x.code === String(m.code).toUpperCase().trim()) : rooms.get(String(m.id));
  if (!r) return sj(c, { t: 'err', m: 'Stanza non trovata.' });
  if (r.m.includes(c)) return;
  if (r.m.length >= 2) return sj(c, { t: 'err', m: 'La stanza e\' piena.' });
  if (r.lock) {
    const a = Buffer.from(r.h), b = Buffer.from(hash(r.salt, String(m.pw || '').slice(0, 24)));
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return sj(c, { t: 'err', m: 'Password errata.', pw: 1 });
  }
  if (c.room) leave(c);
  r.m.push(c);
  c.room = r;
  sj(c, { t: 'joined', room: info(r, c) });
  sj(r.m[0], { t: 'peer', nick: c.nick });
}
function leave(c) {
  const r = c.room;
  if (!r) return;
  c.room = null;
  if (r.m[0] === c) {                       // se esce chi ha creato la stanza, la stanza si chiude
    r.m.slice(1).forEach(o => { o.room = null; sj(o, { t: 'closed' }); });
    rooms.delete(r.id);
  } else {
    r.m = r.m.filter(x => x !== c);
    if (r.m[0]) sj(r.m[0], { t: 'left' });
  }
}
function drop(c) {
  if (!clients.has(c)) return;
  clients.delete(c);
  leave(c);
  try { c.socket.destroy(); } catch (e) { /* gia' chiusa */ }
}

function msg(c, txt) {
  let m;
  try { m = JSON.parse(txt); } catch (e) { return; }
  if (!m || typeof m.t !== 'string') return;
  if (++c.rate > MAX_RATE) return kill(c);
  switch (m.t) {
    case 'hello': c.nick = clean(m.nick, 16) || 'Giocatore'; sj(c, { t: 'welcome', id: c.id }); break;
    case 'ping': sj(c, { t: 'pong', ts: m.ts }); break;
    case 'list': sj(c, { t: 'rooms', rooms: list() }); break;
    case 'create': create(c, m); break;
    case 'join': join(c, m); break;
    case 'leave': leave(c); break;
    case 'r': {                              // messaggio di gioco: va all'altro giocatore della stanza
      const r = c.room;
      if (!r) break;
      const o = r.m.find(x => x !== c);
      if (o) send(o, txt);
      break;
    }
  }
}

setInterval(() => { for (const c of clients) c.rate = 0; }, 1000);
setInterval(() => {                           // tiene vive le connessioni e toglie quelle morte
  for (const c of [...clients]) {
    if (!c.alive) { kill(c); continue; }
    c.alive = false;
    send(c, Buffer.alloc(0), 9);
  }
}, 25000);

server.listen(PORT, () => {
  console.log('Clash Isle server avviato sulla porta ' + PORT);
  console.log('  Apri il gioco su:  http://localhost:' + PORT + '/   (se index.html e\' in questa cartella)');
  console.log('  Indirizzo per il client online:  ws://localhost:' + PORT);
});
