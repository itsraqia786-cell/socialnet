'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const db = require('./lib/db');
const ws = require('./lib/ws');
const { sign, verify, hashPassword, checkPassword, parseMultipart, sniffMedia } = require('./lib/util');

const PORT = +process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const UPLOADS = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');
fs.mkdirSync(UPLOADS, { recursive: true });
const MAX_MEDIA = 25 * 1024 * 1024;
const VIS = ['public', 'friends', 'private'];

// ---------- helpers ----------
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const bad = (m) => new HttpError(400, m), forbidden = (m = 'Forbidden') => new HttpError(403, m), notFound = (m = 'Not found') => new HttpError(404, m);
const q = (sql, ...a) => db.prepare(sql).get(...a);
const qa = (sql, ...a) => db.prepare(sql).all(...a);
const run = (sql, ...a) => db.prepare(sql).run(...a);
const now = () => Math.floor(Date.now() / 1000);

const limits = new Map();
function rateLimit(key, max, windowMs) {
  const t = Date.now(); const e = limits.get(key);
  if (!e || t > e.reset) { limits.set(key, { n: 1, reset: t + windowMs }); return; }
  if (++e.n > max) throw new HttpError(429, 'Too many requests, slow down');
}
setInterval(() => { const t = Date.now(); for (const [k, v] of limits) if (t > v.reset) limits.delete(k); }, 60000).unref();

function areFriends(a, b) {
  return !!q(`SELECT 1 FROM friendships WHERE status='accepted' AND ((requester_id=? AND addressee_id=?) OR (requester_id=? AND addressee_id=?))`, a, b, b, a);
}
function friendIds(uid) {
  return qa(`SELECT CASE WHEN requester_id=? THEN addressee_id ELSE requester_id END AS id FROM friendships WHERE status='accepted' AND (requester_id=? OR addressee_id=?)`, uid, uid, uid).map(r => r.id);
}
function friendStatus(me, other) {
  if (me === other) return 'self';
  const f = q(`SELECT requester_id, status FROM friendships WHERE (requester_id=? AND addressee_id=?) OR (requester_id=? AND addressee_id=?)`, me, other, other, me);
  if (!f) return 'none';
  if (f.status === 'accepted') return 'friends';
  return f.requester_id === me ? 'pending_out' : 'pending_in';
}
function canViewProfile(viewerId, u) {
  if (viewerId === u.id || u.profile_visibility === 'public') return true;
  return u.profile_visibility === 'friends' && areFriends(viewerId, u.id);
}
function canViewPost(viewerId, p) {
  if (p.user_id === viewerId) return true;
  if (p.visibility === 'private') return false;
  if (areFriends(viewerId, p.user_id)) return true;
  if (p.visibility === 'friends') return false;
  return q('SELECT profile_visibility FROM users WHERE id=?', p.user_id)?.profile_visibility === 'public';
}
const media = (f) => (f ? '/uploads/' + f : null);
const brief = (u) => u && ({ id: u.id, username: u.username, display_name: u.display_name, avatar: media(u.avatar) });
const userById = (id) => q('SELECT * FROM users WHERE id=?', id);

function serializePost(p, viewerId) {
  const a = userById(p.user_id);
  return {
    id: p.id, author: brief(a), body: p.body, media: media(p.media), media_type: p.media_type, visibility: p.visibility,
    created_at: p.created_at, mine: p.user_id === viewerId,
    like_count: q('SELECT COUNT(*) c FROM likes WHERE post_id=?', p.id).c,
    comment_count: q('SELECT COUNT(*) c FROM comments WHERE post_id=?', p.id).c,
    liked: !!q('SELECT 1 FROM likes WHERE post_id=? AND user_id=?', p.id, viewerId),
  };
}
function serializeComment(c, viewerId) {
  return { id: c.id, post_id: c.post_id, author: brief(userById(c.user_id)), body: c.body, created_at: c.created_at, mine: c.user_id === viewerId };
}
function serializeNotification(n) {
  const post = n.post_id ? q('SELECT body, media_type FROM posts WHERE id=?', n.post_id) : null;
  return { id: n.id, type: n.type, actor: brief(userById(n.actor_id)), post_id: n.post_id, read: !!n.read, created_at: n.created_at,
    excerpt: post ? (post.body.slice(0, 60) || (post.media_type ? '[' + post.media_type + ']' : '')) : null };
}
function ownProfile(u) {
  return { id: u.id, username: u.username, email: u.email, display_name: u.display_name, bio: u.bio, location: u.location,
    avatar: media(u.avatar), cover: media(u.cover), profile_visibility: u.profile_visibility, default_post_visibility: u.default_post_visibility,
    allow_friend_requests: !!u.allow_friend_requests, show_online: !!u.show_online, searchable: !!u.searchable, created_at: u.created_at };
}

// ---------- realtime ----------
const conns = new Map(); // userId -> Set<ws>
const online = (id) => conns.has(id);
function pushTo(userId, event) { const s = conns.get(userId); if (s) for (const c of s) c.send(event); }
function broadcastPost(post, buildEvent) { // send to every connected user who may view the post
  for (const uid of conns.keys()) if (canViewPost(uid, post)) pushTo(uid, buildEvent(uid));
}
function unreadCount(uid) { return q('SELECT COUNT(*) c FROM notifications WHERE user_id=? AND read=0', uid).c; }
function notify(userId, actorId, type, postId = null) {
  if (userId === actorId) return;
  const r = run('INSERT INTO notifications(user_id, actor_id, type, post_id) VALUES(?,?,?,?)', userId, actorId, type, postId);
  const n = q('SELECT * FROM notifications WHERE id=?', r.lastInsertRowid);
  pushTo(userId, { type: 'notification', notification: serializeNotification(n), unread: unreadCount(userId) });
}
function presence(uid, isOnline) {
  const u = userById(uid);
  if (!u || !u.show_online) return;
  for (const f of friendIds(uid)) pushTo(f, { type: 'presence', user_id: uid, online: isOnline });
}

// ---------- request plumbing ----------
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => { size += c.length; if (size > limit) { reject(new HttpError(413, 'Payload too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJson(req) {
  const b = await readBody(req, 100 * 1024);
  if (!b.length) return {};
  try { const j = JSON.parse(b.toString()); if (j && typeof j === 'object') return j; } catch {}
  throw bad('Invalid JSON');
}
function parseCookies(h = '') { const o = {}; for (const p of h.split(';')) { const i = p.indexOf('='); if (i > 0) o[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); } return o; }
function authUser(req, allowCookie = false) {
  let tok = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!tok && allowCookie) tok = parseCookies(req.headers.cookie).sn_token;
  const p = verify(tok);
  return p ? userById(p.uid) : null;
}
function send(res, status, data, headers = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}
function saveMedia(file, allowVideo = true) {
  if (file.data.length > MAX_MEDIA) throw new HttpError(413, 'File too large (max 25MB)');
  const info = sniffMedia(file.data);
  if (!info || (info.kind === 'video' && !allowVideo)) throw bad('Unsupported file type (JPEG, PNG, GIF, WebP, MP4, WebM)');
  const name = crypto.randomBytes(16).toString('hex') + '.' + info.ext;
  fs.writeFileSync(path.join(UPLOADS, name), file.data);
  return { name, kind: info.kind };
}
function rmMedia(name) { if (name) fs.promises.unlink(path.join(UPLOADS, name)).catch(() => {}); }
function sessionCookie(req, token, maxAge) {
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  return `sn_token=${token}; Path=/uploads; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}
function str(v, min, max, label) {
  if (typeof v !== 'string') throw bad(`${label} is required`);
  v = v.trim();
  if (v.length < min || v.length > max) throw bad(`${label} must be ${min}-${max} characters`);
  return v;
}
const paging = (url) => ({ before: Math.max(0, +url.searchParams.get('before') || 0), limit: 20 });

// ---------- routes ----------
const routes = [];
const route = (method, pattern, handler, opts = {}) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), handler, ...opts });

route('POST', '/api/register', async (ctx) => {
  rateLimit('reg:' + ctx.ip, 10, 3600e3);
  const b = await readJson(ctx.req);
  const username = str(b.username, 3, 20, 'Username');
  if (!/^[A-Za-z0-9_]+$/.test(username)) throw bad('Username may contain letters, numbers and underscores only');
  const email = str(b.email, 5, 120, 'Email').toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw bad('Invalid email address');
  if (typeof b.password !== 'string' || b.password.length < 8 || b.password.length > 200) throw bad('Password must be at least 8 characters');
  const display = b.display_name ? str(b.display_name, 1, 50, 'Display name') : username;
  if (q('SELECT 1 FROM users WHERE username=?', username)) throw new HttpError(409, 'Username already taken');
  if (q('SELECT 1 FROM users WHERE email=?', email)) throw new HttpError(409, 'Email already registered');
  const r = run('INSERT INTO users(username,email,password_hash,display_name) VALUES(?,?,?,?)', username, email, hashPassword(b.password), display);
  const token = sign({ uid: +r.lastInsertRowid });
  return [201, { token, user: ownProfile(userById(r.lastInsertRowid)) }, { 'Set-Cookie': sessionCookie(ctx.req, token, 7 * 86400) }];
}, { public: true });

route('POST', '/api/login', async (ctx) => {
  rateLimit('login:' + ctx.ip, 20, 600e3);
  const b = await readJson(ctx.req);
  const id = String(b.login || '').trim();
  const u = q('SELECT * FROM users WHERE username=? OR email=?', id, id);
  // constant-ish work even when user missing
  const ok = checkPassword(String(b.password || ''), u ? u.password_hash : 'aa:bb') && u;
  if (!ok) throw new HttpError(401, 'Invalid credentials');
  const token = sign({ uid: u.id });
  return [200, { token, user: ownProfile(u) }, { 'Set-Cookie': sessionCookie(ctx.req, token, 7 * 86400) }];
}, { public: true });

route('POST', '/api/logout', async (ctx) => [200, { ok: true }, { 'Set-Cookie': sessionCookie(ctx.req, '', 0) }], { public: true });

route('POST', '/api/session', (ctx) => [200, { ok: true }, { 'Set-Cookie': sessionCookie(ctx.req, sign({ uid: ctx.user.id }), 7 * 86400) }]); // refresh media cookie
route('GET', '/api/me', (ctx) => [200, { user: ownProfile(ctx.user), unread: unreadCount(ctx.user.id) }]);

route('PATCH', '/api/me', async (ctx) => {
  const b = await readJson(ctx.req); const u = ctx.user; const set = {};
  if ('display_name' in b) set.display_name = str(b.display_name, 1, 50, 'Display name');
  if ('bio' in b) set.bio = str(String(b.bio ?? ''), 0, 300, 'Bio');
  if ('location' in b) set.location = str(String(b.location ?? ''), 0, 60, 'Location');
  for (const k of ['profile_visibility', 'default_post_visibility']) if (k in b) { if (!VIS.includes(b[k])) throw bad('Invalid ' + k); set[k] = b[k]; }
  for (const k of ['allow_friend_requests', 'show_online', 'searchable']) if (k in b) set[k] = b[k] ? 1 : 0;
  const keys = Object.keys(set);
  if (keys.length) run(`UPDATE users SET ${keys.map(k => k + '=?').join(',')} WHERE id=?`, ...keys.map(k => set[k]), u.id);
  if ('show_online' in set && set.show_online !== u.show_online) {
    if (set.show_online) presence(u.id, online(u.id));
    else for (const f of friendIds(u.id)) pushTo(f, { type: 'presence', user_id: u.id, online: false });
  }
  return [200, { user: ownProfile(userById(u.id)) }];
});

route('POST', '/api/me/password', async (ctx) => {
  rateLimit('pw:' + ctx.user.id, 10, 600e3);
  const b = await readJson(ctx.req);
  if (!checkPassword(String(b.current || ''), ctx.user.password_hash)) throw forbidden('Current password is incorrect');
  if (typeof b.next !== 'string' || b.next.length < 8) throw bad('New password must be at least 8 characters');
  run('UPDATE users SET password_hash=? WHERE id=?', hashPassword(b.next), ctx.user.id);
  return [200, { ok: true }];
});

route('POST', '/api/me/image/:kind', async (ctx) => {
  const kind = ctx.params.kind; if (!['avatar', 'cover'].includes(kind)) throw notFound();
  const { files } = parseMultipart(await readBody(ctx.req, MAX_MEDIA + 4096), ctx.req.headers['content-type']);
  if (!files.file) throw bad('No file uploaded');
  const saved = saveMedia(files.file, false);
  rmMedia(ctx.user[kind]);
  run(`UPDATE users SET ${kind}=? WHERE id=?`, saved.name, ctx.user.id);
  return [200, { user: ownProfile(userById(ctx.user.id)) }];
});

route('DELETE', '/api/me', async (ctx) => {
  const b = await readJson(ctx.req);
  if (!checkPassword(String(b.password || ''), ctx.user.password_hash)) throw forbidden('Password is incorrect');
  const files = [ctx.user.avatar, ctx.user.cover, ...qa('SELECT media FROM posts WHERE user_id=?', ctx.user.id).map(r => r.media)];
  const fr = friendIds(ctx.user.id);
  run('DELETE FROM users WHERE id=?', ctx.user.id);
  files.forEach(rmMedia);
  fr.forEach(f => pushTo(f, { type: 'friend:update' }));
  for (const c of [...(conns.get(ctx.user.id) || [])]) c.close(1000);
  return [200, { ok: true }, { 'Set-Cookie': sessionCookie(ctx.req, '', 0) }];
});

// users
route('GET', '/api/users/search', (ctx) => {
  const term = (ctx.url.searchParams.get('q') || '').trim().slice(0, 50);
  if (term.length < 1) return [200, { users: [] }];
  const like = '%' + term.replace(/[\\%_]/g, '\\$&') + '%';
  const rows = qa(`SELECT * FROM users WHERE searchable=1 AND id!=? AND (username LIKE ? ESCAPE '\\' OR display_name LIKE ? ESCAPE '\\') ORDER BY username LIMIT 20`, ctx.user.id, like, like);
  return [200, { users: rows.map(u => ({ ...brief(u), friend_status: friendStatus(ctx.user.id, u.id) })) }];
});
route('GET', '/api/users/suggestions', (ctx) => {
  const me = ctx.user.id;
  const rows = qa(`SELECT * FROM users u WHERE u.id!=? AND u.searchable=1 AND u.allow_friend_requests=1
    AND NOT EXISTS(SELECT 1 FROM friendships f WHERE (f.requester_id=u.id AND f.addressee_id=?) OR (f.requester_id=? AND f.addressee_id=u.id))
    ORDER BY u.id DESC LIMIT 8`, me, me, me);
  return [200, { users: rows.map(u => ({ ...brief(u), friend_status: 'none' })) }];
});
route('GET', '/api/users/:username', (ctx) => {
  const u = q('SELECT * FROM users WHERE username=?', ctx.params.username);
  if (!u) throw notFound('User not found');
  const me = ctx.user.id, fs_ = friendStatus(me, u.id), can = canViewProfile(me, u);
  const out = { ...brief(u), cover: media(u.cover), created_at: u.created_at, friend_status: fs_, can_view: can, allow_friend_requests: !!u.allow_friend_requests, profile_visibility: u.profile_visibility };
  if (can) {
    out.bio = u.bio; out.location = u.location; out.friend_count = friendIds(u.id).length;
    out.post_count = qa('SELECT * FROM posts WHERE user_id=?', u.id).filter(p => canViewPost(me, p)).length;
  }
  if (u.show_online && (fs_ === 'friends' || fs_ === 'self')) out.online = online(u.id);
  return [200, { user: out }];
});
route('GET', '/api/users/:username/posts', (ctx) => {
  const u = q('SELECT * FROM users WHERE username=?', ctx.params.username);
  if (!u) throw notFound('User not found');
  if (!canViewProfile(ctx.user.id, u)) return [200, { posts: [], more: false }];
  const { before, limit } = paging(ctx.url); const out = []; let cursor = before, more = false;
  for (;;) { // scan in pages, skipping posts the viewer cannot see
    const rows = qa('SELECT * FROM posts WHERE user_id=? AND (?=0 OR id<?) ORDER BY id DESC LIMIT 50', u.id, cursor, cursor);
    for (const p of rows) { if (canViewPost(ctx.user.id, p)) { if (out.length === limit) { more = true; break; } out.push(p); } }
    if (more || rows.length < 50) break; cursor = rows[rows.length - 1].id;
  }
  return [200, { posts: out.map(p => serializePost(p, ctx.user.id)), more }];
});

// posts
route('GET', '/api/feed', (ctx) => {
  const me = ctx.user.id, { before, limit } = paging(ctx.url), scope = ctx.url.searchParams.get('scope') === 'friends' ? 'friends' : 'all';
  const rows = qa(`SELECT p.* FROM posts p WHERE (?=0 OR p.id<?) AND (
      p.user_id=?
      OR (p.visibility!='private' AND p.user_id IN (SELECT CASE WHEN requester_id=? THEN addressee_id ELSE requester_id END FROM friendships WHERE status='accepted' AND (requester_id=? OR addressee_id=?)))
      OR (?='all' AND p.visibility='public' AND EXISTS(SELECT 1 FROM users u WHERE u.id=p.user_id AND u.profile_visibility='public')))
    ORDER BY p.id DESC LIMIT ?`, before, before, me, me, me, me, scope, limit + 1);
  return [200, { posts: rows.slice(0, limit).map(p => serializePost(p, me)), more: rows.length > limit }];
});
route('POST', '/api/posts', async (ctx) => {
  rateLimit('post:' + ctx.user.id, 30, 600e3);
  const ct = ctx.req.headers['content-type'] || '';
  let body = '', visibility = ctx.user.default_post_visibility, file = null;
  if (ct.startsWith('multipart/form-data')) {
    const { fields, files } = parseMultipart(await readBody(ctx.req, MAX_MEDIA + 8192), ct);
    body = fields.body || ''; visibility = fields.visibility || visibility; file = files.media;
  } else { const b = await readJson(ctx.req); body = b.body || ''; visibility = b.visibility || visibility; }
  body = String(body).trim();
  if (!VIS.includes(visibility)) throw bad('Invalid visibility');
  if (body.length > 2000) throw bad('Post is too long (max 2000 characters)');
  if (!body && !file) throw bad('Post cannot be empty');
  const saved = file ? saveMedia(file) : null;
  const r = run('INSERT INTO posts(user_id, body, media, media_type, visibility) VALUES(?,?,?,?,?)', ctx.user.id, body, saved?.name || null, saved?.kind || null, visibility);
  const post = q('SELECT * FROM posts WHERE id=?', r.lastInsertRowid);
  if (visibility !== 'private') for (const f of friendIds(ctx.user.id)) pushTo(f, { type: 'post:new', post: serializePost(post, f) });
  return [201, { post: serializePost(post, ctx.user.id) }];
});
function loadPost(ctx) {
  const p = q('SELECT * FROM posts WHERE id=?', +ctx.params.id);
  if (!p || !canViewPost(ctx.user.id, p)) throw notFound('Post not found');
  return p;
}
route('GET', '/api/posts/:id', (ctx) => [200, { post: serializePost(loadPost(ctx), ctx.user.id) }]);
route('PATCH', '/api/posts/:id', async (ctx) => {
  const p = loadPost(ctx); if (p.user_id !== ctx.user.id) throw forbidden();
  const b = await readJson(ctx.req);
  const body = 'body' in b ? String(b.body).trim() : p.body, vis = 'visibility' in b ? b.visibility : p.visibility;
  if (!VIS.includes(vis)) throw bad('Invalid visibility');
  if (body.length > 2000) throw bad('Post is too long');
  if (!body && !p.media) throw bad('Post cannot be empty');
  run('UPDATE posts SET body=?, visibility=? WHERE id=?', body, vis, p.id);
  const np = q('SELECT * FROM posts WHERE id=?', p.id);
  broadcastPost(np, uid => ({ type: 'post:edit', post: serializePost(np, uid) }));
  if (vis !== p.visibility) for (const uid of conns.keys()) if (!canViewPost(uid, np)) pushTo(uid, { type: 'post:delete', post_id: p.id });
  return [200, { post: serializePost(np, ctx.user.id) }];
});
route('DELETE', '/api/posts/:id', (ctx) => {
  const p = loadPost(ctx); if (p.user_id !== ctx.user.id) throw forbidden();
  run('DELETE FROM posts WHERE id=?', p.id); rmMedia(p.media);
  for (const uid of conns.keys()) pushTo(uid, { type: 'post:delete', post_id: p.id });
  return [200, { ok: true }];
});
route('POST', '/api/posts/:id/like', (ctx) => {
  rateLimit('like:' + ctx.user.id, 120, 60e3);
  const p = loadPost(ctx), me = ctx.user.id;
  if (q('SELECT 1 FROM likes WHERE user_id=? AND post_id=?', me, p.id)) {
    run('DELETE FROM likes WHERE user_id=? AND post_id=?', me, p.id);
    run(`DELETE FROM notifications WHERE type='like' AND actor_id=? AND post_id=?`, me, p.id);
  } else { run('INSERT INTO likes(user_id, post_id) VALUES(?,?)', me, p.id); notify(p.user_id, me, 'like', p.id); }
  const s = serializePost(p, me);
  broadcastPost(p, uid => ({ type: 'post:update', post_id: p.id, like_count: s.like_count, comment_count: s.comment_count, actor_id: me, liked: uid === me ? s.liked : undefined }));
  return [200, { liked: s.liked, like_count: s.like_count }];
});
route('GET', '/api/posts/:id/comments', (ctx) => {
  const p = loadPost(ctx);
  return [200, { comments: qa('SELECT * FROM comments WHERE post_id=? ORDER BY id', p.id).map(c => serializeComment(c, ctx.user.id)) }];
});
route('POST', '/api/posts/:id/comments', async (ctx) => {
  rateLimit('cmt:' + ctx.user.id, 60, 600e3);
  const p = loadPost(ctx), b = await readJson(ctx.req), me = ctx.user.id;
  const body = str(b.body, 1, 500, 'Comment');
  const r = run('INSERT INTO comments(post_id, user_id, body) VALUES(?,?,?)', p.id, me, body);
  const c = q('SELECT * FROM comments WHERE id=?', r.lastInsertRowid);
  notify(p.user_id, me, 'comment', p.id);
  const count = q('SELECT COUNT(*) c FROM comments WHERE post_id=?', p.id).c;
  broadcastPost(p, uid => ({ type: 'comment:new', post_id: p.id, comment: serializeComment(c, uid), comment_count: count }));
  return [201, { comment: serializeComment(c, me) }];
});
route('DELETE', '/api/comments/:id', (ctx) => {
  const c = q('SELECT * FROM comments WHERE id=?', +ctx.params.id); if (!c) throw notFound();
  const p = q('SELECT * FROM posts WHERE id=?', c.post_id);
  if (c.user_id !== ctx.user.id && p.user_id !== ctx.user.id) throw forbidden();
  run('DELETE FROM comments WHERE id=?', c.id);
  const count = q('SELECT COUNT(*) c FROM comments WHERE post_id=?', p.id).c;
  broadcastPost(p, () => ({ type: 'comment:delete', post_id: p.id, comment_id: c.id, comment_count: count }));
  return [200, { ok: true }];
});

// friends
route('GET', '/api/friends', (ctx) => {
  const users = friendIds(ctx.user.id).map(userById).filter(Boolean).sort((a, b) => a.display_name.localeCompare(b.display_name));
  return [200, { friends: users.map(u => ({ ...brief(u), online: !!u.show_online && online(u.id) })) }];
});
route('GET', '/api/friends/requests', (ctx) => {
  const me = ctx.user.id;
  const inc = qa(`SELECT * FROM friendships WHERE addressee_id=? AND status='pending' ORDER BY id DESC`, me);
  const out = qa(`SELECT * FROM friendships WHERE requester_id=? AND status='pending' ORDER BY id DESC`, me);
  return [200, { incoming: inc.map(f => ({ ...brief(userById(f.requester_id)), created_at: f.created_at })), outgoing: out.map(f => ({ ...brief(userById(f.addressee_id)), created_at: f.created_at })) }];
});
route('POST', '/api/friends/request/:id', (ctx) => {
  rateLimit('fr:' + ctx.user.id, 40, 3600e3);
  const me = ctx.user.id, other = userById(+ctx.params.id);
  if (!other) throw notFound('User not found');
  if (other.id === me) throw bad("You can't befriend yourself");
  const st = friendStatus(me, other.id);
  if (st === 'friends') throw new HttpError(409, 'Already friends');
  if (st === 'pending_out') throw new HttpError(409, 'Request already sent');
  if (st === 'pending_in') { run(`UPDATE friendships SET status='accepted' WHERE requester_id=? AND addressee_id=?`, other.id, me); finalizeAccept(me, other.id); return [200, { friend_status: 'friends' }]; }
  if (!other.allow_friend_requests) throw forbidden('This user is not accepting friend requests');
  run('INSERT INTO friendships(requester_id, addressee_id) VALUES(?,?)', me, other.id);
  notify(other.id, me, 'friend_request'); pushTo(other.id, { type: 'friend:update' });
  return [201, { friend_status: 'pending_out' }];
});
function finalizeAccept(me, otherId) {
  run(`DELETE FROM notifications WHERE type='friend_request' AND user_id=? AND actor_id=?`, me, otherId);
  notify(otherId, me, 'friend_accept');
  pushTo(me, { type: 'friend:update' }); pushTo(otherId, { type: 'friend:update' });
  const m = userById(me), o = userById(otherId);
  if (o.show_online && online(otherId)) pushTo(me, { type: 'presence', user_id: otherId, online: true });
  if (m.show_online && online(me)) pushTo(otherId, { type: 'presence', user_id: me, online: true });
}
route('POST', '/api/friends/accept/:id', (ctx) => {
  const me = ctx.user.id, other = +ctx.params.id;
  const r = run(`UPDATE friendships SET status='accepted' WHERE requester_id=? AND addressee_id=? AND status='pending'`, other, me);
  if (!r.changes) throw notFound('No pending request from this user');
  finalizeAccept(me, other); return [200, { friend_status: 'friends' }];
});
route('POST', '/api/friends/decline/:id', (ctx) => { // decline incoming or cancel outgoing
  const me = ctx.user.id, other = +ctx.params.id;
  run(`DELETE FROM friendships WHERE status='pending' AND ((requester_id=? AND addressee_id=?) OR (requester_id=? AND addressee_id=?))`, other, me, me, other);
  run(`DELETE FROM notifications WHERE type='friend_request' AND ((user_id=? AND actor_id=?) OR (user_id=? AND actor_id=?))`, me, other, other, me);
  pushTo(me, { type: 'friend:update' }); pushTo(other, { type: 'friend:update' });
  return [200, { friend_status: 'none' }];
});
route('DELETE', '/api/friends/:id', (ctx) => {
  const me = ctx.user.id, other = +ctx.params.id;
  run(`DELETE FROM friendships WHERE status='accepted' AND ((requester_id=? AND addressee_id=?) OR (requester_id=? AND addressee_id=?))`, me, other, other, me);
  pushTo(me, { type: 'friend:update' }); pushTo(other, { type: 'friend:update' });
  return [200, { friend_status: 'none' }];
});

// private chats are available only between accepted friends
function chatFriend(ctx) {
  const id = +ctx.params.id;
  if (!Number.isSafeInteger(id) || !areFriends(ctx.user.id, id)) throw notFound('Chat is only available with a friend');
  return userById(id);
}
function serializeMessage(m, viewerId) {
  return { id: m.id, sender_id: m.sender_id, recipient_id: m.recipient_id, body: m.body, created_at: m.created_at,
    mine: m.sender_id === viewerId, sender: brief(userById(m.sender_id)) };
}
route('GET', '/api/chats', (ctx) => {
  const friends = friendIds(ctx.user.id).map(userById).filter(Boolean).map(u => {
    const last = q('SELECT * FROM messages WHERE (sender_id=? AND recipient_id=?) OR (sender_id=? AND recipient_id=?) ORDER BY id DESC LIMIT 1', ctx.user.id, u.id, u.id, ctx.user.id);
    return { ...brief(u), online: !!u.show_online && online(u.id), last_message: last ? { body: last.body, created_at: last.created_at, mine: last.sender_id === ctx.user.id } : null };
  }).sort((a, b) => (b.last_message?.created_at || 0) - (a.last_message?.created_at || 0) || a.display_name.localeCompare(b.display_name));
  return [200, { friends }];
});
route('GET', '/api/chats/:id/messages', (ctx) => {
  const friend = chatFriend(ctx), before = Math.max(0, +ctx.url.searchParams.get('before') || 0);
  const rows = qa('SELECT * FROM messages WHERE ((sender_id=? AND recipient_id=?) OR (sender_id=? AND recipient_id=?)) AND (?=0 OR id<?) ORDER BY id DESC LIMIT 100', ctx.user.id, friend.id, friend.id, ctx.user.id, before, before).reverse();
  return [200, { messages: rows.map(m => serializeMessage(m, ctx.user.id)), more: rows.length === 100 }];
});
route('POST', '/api/chats/:id/messages', async (ctx) => {
  rateLimit('chat:' + ctx.user.id, 120, 600e3);
  const friend = chatFriend(ctx), b = await readJson(ctx.req), body = str(b.body, 1, 2000, 'Message');
  const r = run('INSERT INTO messages(sender_id, recipient_id, body) VALUES(?,?,?)', ctx.user.id, friend.id, body);
  const message = serializeMessage(q('SELECT * FROM messages WHERE id=?', r.lastInsertRowid), ctx.user.id);
  pushTo(friend.id, { type: 'chat:message', message }); pushTo(ctx.user.id, { type: 'chat:message', message });
  return [201, { message }];
});

// notifications
route('GET', '/api/notifications', (ctx) => {
  const rows = qa('SELECT * FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT 50', ctx.user.id);
  return [200, { notifications: rows.map(serializeNotification), unread: unreadCount(ctx.user.id) }];
});
route('POST', '/api/notifications/read', (ctx) => { run('UPDATE notifications SET read=1 WHERE user_id=?', ctx.user.id); pushTo(ctx.user.id, { type: 'notification:read' }); return [200, { unread: 0 }]; });

// ---------- static + uploads ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.jpg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.mp4': 'video/mp4', '.webm': 'video/webm' };
const SEC_HEADERS = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' ws: wss:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'" };

function serveFile(req, res, file, extra = {}) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, SEC_HEADERS); return res.end('Not found'); }
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const h = { 'Content-Type': type, 'Accept-Ranges': 'bytes', ...SEC_HEADERS, ...extra };
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (range) {
      let start = range[1] === '' ? Math.max(0, st.size - +range[2]) : +range[1];
      let end = range[1] === '' || range[2] === '' ? st.size - 1 : Math.min(+range[2], st.size - 1);
      if (start > end || start >= st.size) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
      res.writeHead(206, { ...h, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { ...h, 'Content-Length': st.size });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}
function serveUpload(req, res, name) {
  const u = authUser(req, true);
  if (!u) { res.writeHead(401); return res.end('Unauthorized'); }
  if (!/^[a-f0-9]{32}\.(jpg|png|gif|webp|mp4|webm)$/.test(name)) { res.writeHead(404); return res.end(); }
  let allowed = !!q('SELECT 1 FROM users WHERE avatar=? OR cover=?', name, name);
  if (!allowed) { const p = q('SELECT * FROM posts WHERE media=?', name); allowed = !!p && canViewPost(u.id, p); }
  if (!allowed) { res.writeHead(404); return res.end(); }
  serveFile(req, res, path.join(UPLOADS, name), { 'Cache-Control': 'private, max-age=3600' });
}

// ---------- server ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const ip = req.socket.remoteAddress;
  try {
    if (url.pathname.startsWith('/api/')) {
      const m = routes.find(r => r.method === req.method && r.re.test(url.pathname));
      if (!m) throw notFound('Unknown endpoint');
      const ctx = { req, res, url, ip, params: url.pathname.match(m.re).groups || {} };
      if (!m.public) { ctx.user = authUser(req); if (!ctx.user) throw new HttpError(401, 'Authentication required'); rateLimit('api:' + ctx.user.id, 600, 60e3); }
      const [status, data, headers] = await m.handler(ctx);
      return send(res, status, data, { ...SEC_HEADERS, ...headers });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
    if (url.pathname.startsWith('/uploads/')) return serveUpload(req, res, path.basename(url.pathname));
    let rel = decodeURIComponent(url.pathname); if (rel === '/') rel = '/index.html';
    const file = path.normalize(path.join(PUBLIC, rel));
    if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end(); }
    serveFile(req, res, file, { 'Cache-Control': 'no-cache' });
  } catch (e) {
    if (!(e instanceof HttpError)) console.error(e);
    if (!res.headersSent) send(res, e.status || 500, { error: e.status ? e.message : 'Internal server error' }, SEC_HEADERS);
  }
});

ws.attach(server, (sock) => {
  const uid = sock.ctx.user.id;
  if (!conns.has(uid)) { conns.set(uid, new Set()); presence(uid, true); }
  conns.get(uid).add(sock);
  sock.send({ type: 'hello', unread: unreadCount(uid), online: friendIds(uid).filter(f => online(f) && userById(f)?.show_online) });
  sock.on('message', m => { try { if (JSON.parse(m).type === 'ping') sock.send({ type: 'pong' }); } catch {} });
  sock.on('close', () => {
    const s = conns.get(uid); if (!s) return; s.delete(sock);
    if (!s.size) { conns.delete(uid); presence(uid, false); }
  });
}, (req) => {
  const origin = req.headers.origin;
  if (origin && new URL(origin).host !== req.headers.host) return null; // block cross-site WS hijacking
  const t = new URL(req.url, 'http://x').searchParams.get('token');
  const p = verify(t); const user = p && userById(p.uid);
  return user ? { user } : null;
});

if (require.main === module) server.listen(PORT, () => console.log(`SocialNet running on http://localhost:${PORT}`));
module.exports = { server };
