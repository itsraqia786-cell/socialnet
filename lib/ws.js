'use strict';
// Minimal RFC 6455 WebSocket server (text frames, ping/pong, close, fragmentation).
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_PAYLOAD = 1 << 20;

class Socket extends EventEmitter {
  constructor(sock) {
    super();
    this.sock = sock; this.buf = Buffer.alloc(0); this.frags = []; this.alive = true; this.closed = false;
    sock.on('data', d => this._data(d));
    sock.on('close', () => this._end());
    sock.on('error', () => this._end());
  }
  _end() { if (this.closed) return; this.closed = true; this.emit('close'); }
  _data(d) {
    this.buf = Buffer.concat([this.buf, d]);
    if (this.buf.length > MAX_PAYLOAD + 14) return this.close(1009);
    for (;;) {
      const b = this.buf;
      if (b.length < 2) return;
      const fin = !!(b[0] & 0x80), op = b[0] & 0x0f, masked = !!(b[1] & 0x80);
      let len = b[1] & 0x7f, off = 2;
      if (!masked) return this.close(1002); // clients must mask
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (b.length < 10) return; const big = b.readBigUInt64BE(2); if (big > BigInt(MAX_PAYLOAD)) return this.close(1009); len = Number(big); off = 10; }
      if (len > MAX_PAYLOAD) return this.close(1009);
      if (b.length < off + 4 + len) return;
      const mask = b.subarray(off, off + 4);
      const payload = Buffer.from(b.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      this.buf = b.subarray(off + 4 + len);
      if (op === 0x8) { this.close(1000); return; }
      if (op === 0x9) { this._frame(0xA, payload); continue; }
      if (op === 0xA) { this.alive = true; continue; }
      if (op === 0x1 || op === 0x2 || op === 0x0) {
        this.frags.push(payload);
        if (fin) { const msg = Buffer.concat(this.frags); this.frags = []; this.emit('message', msg.toString('utf8')); }
      }
    }
  }
  _frame(op, payload) {
    if (this.closed || this.sock.destroyed) return;
    const len = payload.length; let h;
    if (len < 126) h = Buffer.from([0x80 | op, len]);
    else if (len < 65536) { h = Buffer.alloc(4); h[0] = 0x80 | op; h[1] = 126; h.writeUInt16BE(len, 2); }
    else { h = Buffer.alloc(10); h[0] = 0x80 | op; h[1] = 127; h.writeBigUInt64BE(BigInt(len), 2); }
    this.sock.write(Buffer.concat([h, payload]));
  }
  send(data) { this._frame(0x1, Buffer.from(typeof data === 'string' ? data : JSON.stringify(data))); }
  ping() { this.alive = false; this._frame(0x9, Buffer.alloc(0)); }
  close(code = 1000) {
    if (!this.closed && !this.sock.destroyed) { const p = Buffer.alloc(2); p.writeUInt16BE(code); this._frame(0x8, p); this.sock.end(); }
    this._end();
  }
}

function attach(server, onConnection, verify) {
  const clients = new Set();
  server.on('upgrade', (req, sock, head) => {
    const key = req.headers['sec-websocket-key'];
    if (!key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') return sock.destroy();
    const ctx = verify ? verify(req) : {};
    if (!ctx) { sock.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return sock.destroy(); }
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const ws = new Socket(sock); ws.ctx = ctx; clients.add(ws);
    ws.on('close', () => clients.delete(ws));
    if (head && head.length) ws._data(head);
    onConnection(ws, req);
  });
  const timer = setInterval(() => { for (const c of clients) { if (!c.alive) { c.close(1001); sock_destroy(c); } else c.ping(); } }, 30000);
  timer.unref();
  return { clients };
}
function sock_destroy(c) { try { c.sock.destroy(); } catch {} }
module.exports = { attach };
