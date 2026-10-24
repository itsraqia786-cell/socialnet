'use strict';
// End-to-end test: boots the server on a temp DB and exercises REST + WebSocket flows.
const os = require('node:os'), path = require('node:path'), fs = require('node:fs'), assert = require('node:assert/strict');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-'));
process.env.DB_PATH = path.join(tmp, 't.db'); process.env.UPLOAD_DIR = path.join(tmp, 'up');
const { server } = require('../server');

let base; let passed = 0;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
async function api(method, url, token, body) {
  const opts = { method, headers: {} };
  if (token) opts.headers.Authorization = 'Bearer ' + token;
  if (body instanceof FormData) opts.body = body; else if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const r = await fetch(base + url, opts); let j = {}; try { j = await r.json(); } catch {}
  return { status: r.status, ...j };
}
function connect(token) {
  return new Promise((res, rej) => {
    const w = new WebSocket(base.replace('http', 'ws') + '/?token=' + token); const events = [];
    w.onmessage = e => events.push(JSON.parse(e.data)); w.onerror = () => rej(new Error('ws error'));
    w.onopen = () => res({ w, events, wait: async (pred, ms = 2000) => { const t = Date.now(); for (;;) { const f = events.find(pred); if (f) return f; if (Date.now() - t > ms) throw new Error('timeout waiting for event; got ' + JSON.stringify(events.map(e => e.type))); await new Promise(r => setTimeout(r, 20)); } } });
  });
}
async function t(name, fn) { try { await fn(); passed++; console.log('  ✓', name); } catch (e) { console.error('  ✗', name, '\n   ', e.message); process.exitCode = 1; } }

(async () => {
  await new Promise(r => server.listen(0, r)); base = 'http://localhost:' + server.address().port;
  let A, B, C;
  console.log('Auth');
  await t('register + validation', async () => {
    assert.equal((await api('POST', '/api/register', null, { username: 'a!', email: 'x', password: '1' })).status, 400);
    A = await api('POST', '/api/register', null, { username: 'alice', email: 'alice@x.com', password: 'password1', display_name: 'Alice' });
    B = await api('POST', '/api/register', null, { username: 'bob', email: 'bob@x.com', password: 'password2' });
    C = await api('POST', '/api/register', null, { username: 'carol', email: 'carol@x.com', password: 'password3' });
    assert.equal(A.status, 201); assert.ok(A.token);
    assert.equal((await api('POST', '/api/register', null, { username: 'ALICE', email: 'z@x.com', password: 'password1' })).status, 409);
  });
  await t('login / bad login / auth required', async () => {
    assert.equal((await api('POST', '/api/login', null, { login: 'alice@x.com', password: 'password1' })).status, 200);
    assert.equal((await api('POST', '/api/login', null, { login: 'alice', password: 'wrong' })).status, 401);
    assert.equal((await api('GET', '/api/feed')).status, 401);
    assert.equal((await api('GET', '/api/me', 'garbage')).status, 401);
  });

  const wa = await connect(A.token), wb = await connect(B.token), wc = await connect(C.token);
  await t('websocket requires valid token', async () => {
    await new Promise((res, rej) => { const w = new WebSocket(base.replace('http', 'ws') + '/?token=bad'); w.onerror = () => res(); w.onopen = () => rej(new Error('should not open')); });
  });

  console.log('Friends + realtime');
  await t('friend request → live notification → accept → presence', async () => {
    assert.equal((await api('POST', `/api/friends/request/${B.user.id}`, A.token)).status, 201);
    assert.equal((await api('POST', `/api/friends/request/${B.user.id}`, A.token)).status, 409);
    const n = await wb.wait(e => e.type === 'notification' && e.notification.type === 'friend_request');
    assert.equal(n.notification.actor.username, 'alice'); assert.equal(n.unread, 1);
    assert.equal((await api('POST', `/api/friends/accept/${A.user.id}`, B.token)).friend_status, 'friends');
    await wa.wait(e => e.type === 'notification' && e.notification.type === 'friend_accept');
    const fl = await api('GET', '/api/friends', A.token); assert.equal(fl.friends.length, 1); assert.equal(fl.friends[0].online, true);
  });

  console.log('Posts, privacy, media');
  let friendsPost, publicPost, privatePost, imgPost;
  await t('post visibility rules + live feed delivery', async () => {
    friendsPost = (await api('POST', '/api/posts', A.token, { body: 'friends only', visibility: 'friends' })).post;
    publicPost = (await api('POST', '/api/posts', A.token, { body: 'hello world', visibility: 'public' })).post;
    privatePost = (await api('POST', '/api/posts', A.token, { body: 'secret', visibility: 'private' })).post;
    await wb.wait(e => e.type === 'post:new' && e.post.id === friendsPost.id);
    assert.ok(!wb.events.some(e => e.type === 'post:new' && e.post.id === privatePost.id), 'private post leaked via WS');
    assert.ok(!wc.events.some(e => e.type === 'post:new'), 'non-friend got post via WS');
    const ids = f => f.posts.map(p => p.id);
    const fb = ids(await api('GET', '/api/feed', B.token)), fc = ids(await api('GET', '/api/feed', C.token));
    assert.ok(fb.includes(friendsPost.id) && fb.includes(publicPost.id) && !fb.includes(privatePost.id));
    assert.deepEqual(fc, [publicPost.id]);
    assert.equal((await api('GET', `/api/posts/${friendsPost.id}`, C.token)).status, 404);
    assert.equal((await api('GET', `/api/posts/${privatePost.id}`, B.token)).status, 404);
    assert.equal((await api('GET', `/api/posts/${privatePost.id}`, A.token)).status, 200);
  });
  await t('image upload with access control', async () => {
    const fd = new FormData(); fd.set('body', 'pic'); fd.set('visibility', 'friends'); fd.set('media', new Blob([PNG], { type: 'image/png' }), 'x.png');
    const r = await api('POST', '/api/posts', A.token, fd); assert.equal(r.status, 201); imgPost = r.post; assert.equal(imgPost.media_type, 'image');
    const get = (tok) => fetch(base + imgPost.media, { headers: tok ? { Cookie: 'sn_token=' + tok } : {} });
    assert.equal((await get(B.token)).status, 200);
    assert.equal((await get(C.token)).status, 404);
    assert.equal((await get(null)).status, 401);
    const fake = new FormData(); fake.set('body', 'x'); fake.set('media', new Blob(['<script>alert(1)</script>'], { type: 'image/png' }), 'x.png');
    assert.equal((await api('POST', '/api/posts', A.token, fake)).status, 400);
  });
  await t('profile privacy', async () => {
    assert.equal((await api('GET', '/api/users/alice', C.token)).user.can_view, true);
    await api('PATCH', '/api/me', A.token, { profile_visibility: 'friends' });
    const pc = await api('GET', '/api/users/alice', C.token); assert.equal(pc.user.can_view, false); assert.equal(pc.user.bio, undefined);
    assert.equal((await api('GET', '/api/users/alice/posts', C.token)).posts.length, 0);
    assert.ok(!(await api('GET', '/api/feed', C.token)).posts.some(p => p.author.username === 'alice'));
    assert.equal((await api('GET', '/api/users/alice', B.token)).user.can_view, true);
    assert.equal((await api('GET', '/api/users/alice/posts', B.token)).posts.length, 3); // friends+public+image
    await api('PATCH', '/api/me', A.token, { profile_visibility: 'public' });
    assert.deepEqual((await api('GET', '/api/users/alice/posts', C.token)).posts.map(p => p.id), [publicPost.id]);
    assert.equal((await api('PATCH', '/api/me', A.token, { profile_visibility: 'nope' })).status, 400);
  });

  console.log('Likes + comments + notifications');
  await t('like toggles, notifies, broadcasts', async () => {
    const r = await api('POST', `/api/posts/${friendsPost.id}/like`, B.token); assert.equal(r.liked, true); assert.equal(r.like_count, 1);
    await wa.wait(e => e.type === 'notification' && e.notification.type === 'like');
    await wa.wait(e => e.type === 'post:update' && e.post_id === friendsPost.id && e.like_count === 1);
    assert.equal((await api('POST', `/api/posts/${friendsPost.id}/like`, B.token)).like_count, 0);
    assert.equal((await api('POST', `/api/posts/${friendsPost.id}/like`, C.token)).status, 404);
    await api('POST', `/api/posts/${friendsPost.id}/like`, B.token);
    const n = await api('GET', '/api/notifications', A.token); assert.equal(n.notifications.filter(x => x.type === 'like').length, 1);
  });
  await t('comments, live delivery, delete permissions', async () => {
    assert.equal((await api('POST', `/api/posts/${friendsPost.id}/comments`, B.token, { body: '' })).status, 400);
    const c = (await api('POST', `/api/posts/${friendsPost.id}/comments`, B.token, { body: 'nice <b>post</b>' })).comment;
    await wa.wait(e => e.type === 'comment:new' && e.comment.id === c.id && e.comment_count === 1);
    await wa.wait(e => e.type === 'notification' && e.notification.type === 'comment');
    assert.equal((await api('GET', `/api/posts/${friendsPost.id}/comments`, A.token)).comments[0].body, 'nice <b>post</b>');
    assert.equal((await api('DELETE', `/api/comments/${c.id}`, C.token)).status, 403);
    assert.equal((await api('DELETE', `/api/comments/${c.id}`, A.token)).status, 200); // post owner may moderate
    await wb.wait(e => e.type === 'comment:delete' && e.comment_id === c.id);
  });
  await t('mark notifications read', async () => {
    assert.ok((await api('GET', '/api/notifications', A.token)).unread > 0);
    await api('POST', '/api/notifications/read', A.token);
    assert.equal((await api('GET', '/api/notifications', A.token)).unread, 0);
  });
  await t('edit + delete post (owner only) with realtime', async () => {
    assert.equal((await api('PATCH', `/api/posts/${publicPost.id}`, B.token, { body: 'hax' })).status, 403);
    assert.equal((await api('PATCH', `/api/posts/${publicPost.id}`, A.token, { body: 'edited' })).post.body, 'edited');
    await wb.wait(e => e.type === 'post:edit' && e.post.body === 'edited');
    assert.equal((await api('DELETE', `/api/posts/${publicPost.id}`, B.token)).status, 403);
    assert.equal((await api('DELETE', `/api/posts/${publicPost.id}`, A.token)).status, 200);
    await wc.wait(e => e.type === 'post:delete' && e.post_id === publicPost.id);
  });

  console.log('Friends management, search, settings');
  await t('search, suggestions, decline, unfriend, request toggle', async () => {
    assert.equal((await api('GET', '/api/users/search?q=car', A.token)).users[0].username, 'carol');
    assert.equal((await api('GET', '/api/users/search?q=%25', A.token)).users.length, 0); // wildcard escaped
    assert.ok((await api('GET', '/api/users/suggestions', A.token)).users.some(u => u.username === 'carol'));
    await api('PATCH', '/api/me', C.token, { allow_friend_requests: false });
    assert.equal((await api('POST', `/api/friends/request/${C.user.id}`, A.token)).status, 403);
    await api('PATCH', '/api/me', C.token, { allow_friend_requests: true });
    await api('POST', `/api/friends/request/${C.user.id}`, A.token);
    assert.equal((await api('GET', '/api/friends/requests', C.token)).incoming.length, 1);
    assert.equal((await api('GET', '/api/friends/requests', A.token)).outgoing.length, 1);
    await api('POST', `/api/friends/decline/${A.user.id}`, C.token);
    assert.equal((await api('GET', '/api/friends/requests', C.token)).incoming.length, 0);
    assert.equal((await api('DELETE', `/api/friends/${B.user.id}`, A.token)).friend_status, 'none');
    assert.equal((await api('GET', `/api/posts/${friendsPost.id}`, B.token)).status, 404); // friends-only access revoked
  });
  await t('avatar upload, presence off, password change', async () => {
    const fd = new FormData(); fd.set('file', new Blob([PNG], { type: 'image/png' }), 'a.png');
    const r = await api('POST', '/api/me/image/avatar', A.token, fd); assert.ok(r.user.avatar.startsWith('/uploads/'));
    assert.equal((await fetch(base + r.user.avatar, { headers: { Cookie: 'sn_token=' + C.token } })).status, 200);
    assert.equal((await api('POST', '/api/me/password', A.token, { current: 'bad', next: 'newpassword' })).status, 403);
    assert.equal((await api('POST', '/api/me/password', A.token, { current: 'password1', next: 'newpassword' })).status, 200);
    assert.equal((await api('POST', '/api/login', null, { login: 'alice', password: 'newpassword' })).status, 200);
  });
  await t('presence offline broadcast to friends', async () => {
    await api('POST', `/api/friends/request/${B.user.id}`, A.token); await api('POST', `/api/friends/accept/${A.user.id}`, B.token);
    wb.events.length = 0; wa.w.close();
    await wb.wait(e => e.type === 'presence' && e.user_id === A.user.id && e.online === false);
  });
  await t('static files, path traversal, security headers', async () => {
    const r = await fetch(base + '/'); assert.equal(r.status, 200); assert.ok(r.headers.get('content-security-policy'));
    assert.notEqual((await fetch(base + '/..%2fserver.js')).status, 200);
    assert.notEqual((await fetch(base + '/%2e%2e/server.js')).status, 200);
  });
  await t('delete account cascades', async () => {
    assert.equal((await api('DELETE', '/api/me', C.token, { password: 'wrong' })).status, 403);
    assert.equal((await api('DELETE', '/api/me', C.token, { password: 'password3' })).status, 200);
    assert.equal((await api('GET', '/api/users/carol', B.token)).status, 404);
  });

  console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
  server.close(); setTimeout(() => process.exit(process.exitCode || 0), 100);
})();
