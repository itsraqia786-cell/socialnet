'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DATA = path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA, { recursive: true });

function getSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const f = path.join(DATA, '.secret');
  try { return fs.readFileSync(f, 'utf8'); } catch {}
  const s = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(f, s, { mode: 0o600 });
  return s;
}
const SECRET = getSecret();
const b64 = b => Buffer.from(b).toString('base64url');

function sign(payload, ttlSec = 7 * 86400) {
  const body = b64(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSec }));
  const sig = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}
function verify(token) {
  if (typeof token !== 'string') return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const exp = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  const a = Buffer.from(sig), b = Buffer.from(exp);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try { const p = JSON.parse(Buffer.from(body, 'base64url').toString()); return p.exp > Date.now() / 1000 ? p : null; } catch { return null; }
}
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(pw, salt, 64);
  return `${salt.toString('hex')}:${h.toString('hex')}`;
}
function checkPassword(pw, stored) {
  const [s, h] = String(stored).split(':');
  if (!s || !h) return false;
  const calc = crypto.scryptSync(pw, Buffer.from(s, 'hex'), 64);
  const hb = Buffer.from(h, 'hex');
  return hb.length === calc.length && crypto.timingSafeEqual(calc, hb);
}

// Multipart/form-data parser (buffers whole body; size limited by caller).
function parseMultipart(buf, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!m) throw new Error('No boundary');
  const boundary = Buffer.from('--' + (m[1] || m[2]));
  const fields = {}, files = {};
  let pos = buf.indexOf(boundary);
  while (pos !== -1) {
    const start = pos + boundary.length;
    if (buf.subarray(start, start + 2).toString() === '--') break;
    const next = buf.indexOf(boundary, start);
    if (next === -1) break;
    const part = buf.subarray(start + 2, next - 2); // strip CRLF
    const he = part.indexOf('\r\n\r\n');
    if (he !== -1) {
      const head = part.subarray(0, he).toString('utf8');
      const body = part.subarray(he + 4);
      const name = /name="([^"]*)"/i.exec(head)?.[1];
      const filename = /filename="([^"]*)"/i.exec(head)?.[1];
      const type = /content-type:\s*([^\r\n;]+)/i.exec(head)?.[1]?.trim().toLowerCase();
      if (name) { if (filename !== undefined) { if (filename) files[name] = { filename, type, data: body }; } else fields[name] = body.toString('utf8'); }
    }
    pos = next;
  }
  return { fields, files };
}

// Detect real media type from magic bytes (never trust client content-type).
function sniffMedia(b) {
  if (b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { ext: 'jpg', kind: 'image', mime: 'image/jpeg' };
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { ext: 'png', kind: 'image', mime: 'image/png' };
  if (b.subarray(0, 4).toString() === 'GIF8') return { ext: 'gif', kind: 'image', mime: 'image/gif' };
  if (b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP') return { ext: 'webp', kind: 'image', mime: 'image/webp' };
  if (b.subarray(4, 8).toString() === 'ftyp') return { ext: 'mp4', kind: 'video', mime: 'video/mp4' };
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return { ext: 'webm', kind: 'video', mime: 'video/webm' };
  return null;
}
module.exports = { sign, verify, hashPassword, checkPassword, parseMultipart, sniffMedia, DATA };
