'use strict';
/* Circle — single-page client. All user content is inserted via textContent (no innerHTML) to prevent XSS. */
const $ = (s, r = document) => r.querySelector(s);
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}
const store = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} } };

const S = { token: store.get('sn_token'), me: null, unread: 0, online: new Set(), cards: new Map(), view: null, pending: [], ws: null, wsTries: 0 };
const VIS = { public: ['🌐', 'Public'], friends: ['👥', 'Friends'], private: ['🔒', 'Only me'] };

async function api(method, url, body) {
  const o = { method, headers: {} };
  if (S.token) o.headers.Authorization = 'Bearer ' + S.token;
  if (body instanceof FormData) o.body = body; else if (body !== undefined) { o.headers['Content-Type'] = 'application/json'; o.body = JSON.stringify(body); }
  let r; try { r = await fetch(url, o); } catch { throw new Error('Network error'); }
  let j = {}; try { j = await r.json(); } catch {}
  if (r.status === 401 && S.me) { logout(true); throw new Error('Session expired'); }
  if (!r.ok) throw new Error(j.error || 'Request failed');
  return j;
}
function timeAgo(ts) {
  const s = Math.max(0, Date.now() / 1000 - ts);
  if (s < 60) return 'just now'; if (s < 3600) return Math.floor(s / 60) + 'm'; if (s < 86400) return Math.floor(s / 3600) + 'h';
  if (s < 604800) return Math.floor(s / 86400) + 'd'; return new Date(ts * 1000).toLocaleDateString();
}
function avatar(u, cls = '') {
  return u.avatar ? h('img', { class: 'avatar ' + cls, src: u.avatar, alt: '' }) : h('div', { class: 'avatar ' + cls }, (u.display_name || u.username || '?')[0].toUpperCase());
}
function toast(msg, href) {
  const t = h('div', { class: 'toast', onclick: () => { if (href) location.hash = href; t.remove(); } }, msg);
  $('#toasts').append(t); setTimeout(() => t.remove(), 5000);
}
const notifText = n => ({
  like: 'liked your post', comment: 'commented on your post', friend_request: 'sent you a friend request', friend_accept: 'accepted your friend request',
}[n.type] || n.type);
const notifHref = n => n.post_id ? '#/post/' + n.post_id : n.type === 'friend_request' ? '#/friends' : '#/u/' + n.actor.username;

// ---------- auth ----------
function logout(expired) {
  if (S.token && !expired) fetch('/api/logout', { method: 'POST' }).catch(() => {});
  S.token = null; S.me = null; store.set('sn_token', null);
  if (S.ws) { S.ws.onclose = null; S.ws.close(); S.ws = null; }
  location.hash = ''; renderAuth(expired ? 'Your session expired. Please sign in again.' : '');
}
function renderAuth(msg = '') {
  let mode = 'login';
  const err = h('div', { class: 'err' }, msg);
  const f = {};
  const form = h('form', { onsubmit: async e => {
    e.preventDefault(); err.textContent = '';
    try {
      const body = mode === 'login' ? { login: f.login.value, password: f.password.value }
        : { username: f.username.value, email: f.email.value, display_name: f.display.value || undefined, password: f.password.value };
      const r = await api('POST', mode === 'login' ? '/api/login' : '/api/register', body);
      S.token = r.token; store.set('sn_token', r.token); boot();
    } catch (ex) { err.textContent = ex.message; }
  } });
  const field = (key, label, type, extra = {}) => { f[key] = h('input', { type, required: !extra.optional, autocomplete: extra.ac, maxlength: 200 }); return h('div', { class: extra.cls }, h('label', {}, label), f[key]); };
  const fields = {
    login: [field('login', 'Username or email', 'text', { ac: 'username' })],
    register: [field('username', 'Username', 'text', { ac: 'username' }), field('display', 'Display name (optional)', 'text', { optional: true }), field('email', 'Email', 'email', { ac: 'email' })],
  };
  const pw = field('password', 'Password', 'password', { ac: 'current-password' });
  const submit = h('button', { class: 'btn primary', style: 'width:100%;margin-top:18px', type: 'submit' }, 'Sign in');
  const tabLogin = h('button', { type: 'button', class: 'on' }, 'Sign in'), tabReg = h('button', { type: 'button' }, 'Create account');
  const draw = () => {
    tabLogin.className = mode === 'login' ? 'on' : ''; tabReg.className = mode === 'register' ? 'on' : '';
    f.password.setAttribute('autocomplete', mode === 'login' ? 'current-password' : 'new-password');
    submit.textContent = mode === 'login' ? 'Sign in' : 'Create account';
    form.replaceChildren(...fields[mode], pw, err, submit); err.textContent = '';
  };
  tabLogin.onclick = () => { mode = 'login'; draw(); }; tabReg.onclick = () => { mode = 'register'; draw(); };
  draw();
  $('#app').replaceChildren(h('div', { class: 'auth' }, h('div', { class: 'auth-card' },
    h('div', { class: 'logo' }, h('i'), 'Circle'), h('p', { class: 'muted' }, 'Share moments with the people who matter.'),
    h('div', { class: 'tabs' }, tabLogin, tabReg), form)));
}

// ---------- shell ----------
let navBits = {};
function renderShell() {
  const searchBox = h('input', { type: 'text', placeholder: 'Search people…', 'aria-label': 'Search people' });
  const dd = h('div', { class: 'dropdown hidden' });
  let timer;
  searchBox.addEventListener('input', () => {
    clearTimeout(timer); const term = searchBox.value.trim();
    if (!term) return dd.classList.add('hidden');
    timer = setTimeout(async () => {
      try {
        const { users } = await api('GET', '/api/users/search?q=' + encodeURIComponent(term));
        dd.replaceChildren(...(users.length ? users.map(u => h('a', { href: '#/u/' + u.username, onclick: () => { dd.classList.add('hidden'); searchBox.value = ''; } }, avatar(u, 'sm'), h('span', {}, h('b', {}, u.display_name), ' ', h('span', { class: 'muted small' }, '@' + u.username)))) : [h('div', { class: 'row muted' }, 'No people found')]));
        dd.classList.remove('hidden');
      } catch {}
    }, 250);
  });
  document.addEventListener('click', e => { if (!e.target.closest('.search')) dd.classList.add('hidden'); });
  navBits.badge = h('span', { class: 'badge hidden' });
  navBits.links = {};
  const link = (key, href, icon, label, extra) => (navBits.links[key] = h('a', { href }, icon, ' ', h('span', {}, label), extra));
  $('#app').replaceChildren(
    h('div', { class: 'nav' }, h('div', { class: 'nav-in' },
      h('a', { href: '#/', class: 'logo' }, h('i'), 'Circle'), h('div', { class: 'search' }, searchBox, dd),
      h('div', { class: 'nav-links' }, link('feed', '#/', '🏠', 'Home'), link('friends', '#/friends', '👥', 'Friends'), link('chats', '#/chats', '💬', 'Chats'), link('notifications', '#/notifications', '🔔', 'Alerts', navBits.badge),
        link('me', '#/u/' + S.me.username, '', S.me.display_name.split(' ')[0]), link('settings', '#/settings', '⚙️', 'Settings')))),
    h('div', { id: 'view' }), h('div', { id: 'conn', class: 'conn hidden' }, 'Reconnecting…'));
  setUnread(S.unread);
}
function setUnread(n) { S.unread = n; if (navBits.badge) { navBits.badge.textContent = n > 99 ? '99+' : n; navBits.badge.classList.toggle('hidden', !n); } document.title = (n ? `(${n}) ` : '') + 'Circle'; }

// ---------- posts ----------
function visIcon(v) { return h('span', { title: VIS[v][1] }, VIS[v][0]); }
function postCard(p, opts = {}) {
  const body = h('div', { class: 'post-body' }, p.body);
  const like = h('button', { class: 'act' }), cmt = h('button', { class: 'act' });
  const meta = h('div', { class: 'small muted' }, timeAgo(p.created_at), ' · ', visIcon(p.visibility));
  const commentsBox = h('div', { class: 'comments hidden' });
  const el = h('article', { class: 'card post', 'data-id': p.id });
  const card = { el, post: p, body, like, cmt, meta, commentsBox };
  const draw = () => {
    like.className = 'act' + (card.post.liked ? ' on' : ''); like.textContent = (card.post.liked ? '♥ ' : '♡ ') + card.post.like_count;
    cmt.textContent = '💬 ' + card.post.comment_count;
    body.textContent = card.post.body; body.classList.toggle('hidden', !card.post.body);
    meta.replaceChildren(timeAgo(card.post.created_at), ' · ', visIcon(card.post.visibility));
  };
  card.draw = draw;
  like.onclick = async () => { try { const r = await api('POST', `/api/posts/${p.id}/like`); card.post.liked = r.liked; card.post.like_count = r.like_count; draw(); } catch (e) { toast(e.message); } };
  cmt.onclick = () => toggleComments(card);
  const menu = [];
  if (p.mine) {
    menu.push(h('button', { class: 'btn sm', onclick: () => { if (confirm('Edit this post?')) editPost(card); } }, 'Edit'), h('button', { class: 'btn sm danger', onclick: async () => { if (confirm('Delete this post?')) try { await api('DELETE', '/api/posts/' + p.id); removeCard(p.id); } catch (e) { toast(e.message); } } }, 'Delete'));
  }
  let mediaEl = null;
  if (p.media) mediaEl = p.media_type === 'video' ? h('video', { class: 'post-media', src: p.media, controls: true, preload: 'metadata' }) : h('img', { class: 'post-media', src: p.media, alt: 'Post image', loading: 'lazy' });
  el.append(
    h('div', { class: 'post-head' }, h('a', { href: '#/u/' + p.author.username }, avatar(p.author)),
      h('div', { class: 'grow' }, h('a', { href: '#/u/' + p.author.username }, h('b', {}, p.author.display_name)), meta), ...menu),
    body, mediaEl, h('div', { class: 'post-actions' }, like, cmt), commentsBox);
  draw();
  S.cards.set(p.id, card);
  if (opts.openComments) toggleComments(card);
  return el;
}
function removeCard(id) { const c = S.cards.get(id); if (c) { c.el.remove(); S.cards.delete(id); } }
function editPost(card) {
  const ta = h('textarea', { maxlength: 2000 }, card.post.body); ta.value = card.post.body;
  const sel = h('select', {}, ...Object.entries(VIS).map(([k, v]) => h('option', { value: k, selected: k === card.post.visibility }, v[0] + ' ' + v[1])));
  const form = h('div', {}, ta, h('div', { class: 'row-btns', style: 'margin-top:8px' }, sel,
    h('button', { class: 'btn primary sm', onclick: async () => { try { const r = await api('PATCH', '/api/posts/' + card.post.id, { body: ta.value, visibility: sel.value }); Object.assign(card.post, r.post); card.draw(); form.replaceWith(card.body); } catch (e) { toast(e.message); } } }, 'Save'),
    h('button', { class: 'btn sm', onclick: () => form.replaceWith(card.body) }, 'Cancel')));
  card.body.classList.remove('hidden'); card.body.replaceWith(form);
}
function commentEl(c, card) {
  const del = (c.mine || card.post.mine) ? h('button', { class: 'act small', onclick: async () => { try { await api('DELETE', '/api/comments/' + c.id); } catch (e) { toast(e.message); } } }, 'Delete') : null;
  return h('div', { class: 'comment', 'data-cid': c.id }, h('a', { href: '#/u/' + c.author.username }, avatar(c.author, 'sm')),
    h('div', {}, h('div', { class: 'bubble' }, h('a', { href: '#/u/' + c.author.username }, h('b', {}, c.author.display_name)), h('div', {}, c.body)), h('span', { class: 'small muted' }, timeAgo(c.created_at), ' '), del));
}
async function toggleComments(card) {
  const box = card.commentsBox;
  if (!box.classList.toggle('hidden')) {
    box.replaceChildren(h('div', { class: 'muted small' }, 'Loading…'));
    try {
      const { comments } = await api('GET', `/api/posts/${card.post.id}/comments`);
      const list = h('div', { class: 'clist' }, ...comments.map(c => commentEl(c, card)));
      const input = h('input', { type: 'text', placeholder: 'Write a comment…', maxlength: 500 });
      const form = h('form', { class: 'comment-form', onsubmit: async e => { e.preventDefault(); if (!input.value.trim()) return; try { await api('POST', `/api/posts/${card.post.id}/comments`, { body: input.value }); input.value = ''; } catch (ex) { toast(ex.message); } } }, input, h('button', { class: 'btn primary sm' }, 'Send'));
      box.replaceChildren(list, form); card.list = list; input.focus();
    } catch (e) { box.replaceChildren(h('div', { class: 'err' }, e.message)); }
  }
}
function pager(container, loader) {
  let before = 0, loading = false;
  const more = h('button', { class: 'btn hidden', style: 'display:block;margin:0 auto 20px' }, 'Load more');
  const empty = h('div', { class: 'card muted hidden', style: 'text-align:center' });
  const load = async () => {
    if (loading) return; loading = true; more.disabled = true;
    try {
      const r = await loader(before);
      r.posts.forEach(p => { if (!S.cards.has(p.id)) container.append(postCard(p)); });
      if (r.posts.length) before = r.posts[r.posts.length - 1].id;
      more.classList.toggle('hidden', !r.more);
      if (!container.children.length) { empty.textContent = r.emptyText || 'Nothing here yet.'; empty.classList.remove('hidden'); } else empty.classList.add('hidden');
    } catch (e) { toast(e.message); } finally { loading = false; more.disabled = false; }
  };
  more.onclick = load; load();
  return h('div', {}, container, empty, more);
}

// ---------- views ----------
function setView(name, ...nodes) {
  S.view = name; S.cards.clear(); S.pending = [];
  for (const [k, a] of Object.entries(navBits.links || {})) a.classList.toggle('on', k === name);
  $('#view').replaceChildren(...nodes);
}
function personRow(u, right) {
  return h('div', { class: 'person' }, h('a', { href: '#/u/' + u.username }, avatar(u)),
    h('a', { class: 'grow', href: '#/u/' + u.username }, h('b', {}, u.display_name, u.online && h('span', { class: 'dot', title: 'Online' })), h('span', { class: 'small muted' }, '@' + u.username)), right);
}
async function sidebar() {
  const box = h('aside', { class: 'side' });
  try {
    const [{ users }, { friends }] = await Promise.all([api('GET', '/api/users/suggestions'), api('GET', '/api/friends')]);
    const onl = friends.filter(f => f.online);
    box.append(h('div', { class: 'card' }, h('h3', {}, 'Online now'), ...(onl.length ? onl.map(f => personRow(f)) : [h('div', { class: 'muted small' }, 'No friends online right now.')])),
      h('div', { class: 'card' }, h('h3', {}, 'People you may know'), ...(users.length ? users.map(u => {
        const b = h('button', { class: 'btn sm' }, 'Add');
        b.onclick = async () => { try { await api('POST', '/api/friends/request/' + u.id); b.textContent = 'Sent'; b.disabled = true; } catch (e) { toast(e.message); } };
        return personRow(u, b);
      }) : [h('div', { class: 'muted small' }, 'No suggestions yet.')])));
  } catch {}
  return box;
}
async function viewFeed() {
  let scope = 'all'; const posts = h('div'); let pend = h('div', { class: 'newbar' });
  const composer = buildComposer(p => { posts.prepend(postCard(p)); });
  const tabs = h('div', { class: 'tabs', style: 'margin:0 0 16px' });
  const mk = (key, label) => h('button', { class: scope === key ? 'on' : '', onclick: () => { scope = key; draw(); } }, label);
  const feed = h('div');
  const draw = () => {
    tabs.replaceChildren(mk('all', 'Everyone'), mk('friends', 'Friends only'));
    S.cards.clear(); S.pending = []; pend.replaceChildren(); posts.replaceChildren();
    feed.replaceChildren(pend, pager(posts, async before => {
      const r = await api('GET', `/api/feed?scope=${scope}&before=${before}`); r.emptyText = 'Your feed is empty. Add some friends or write the first post!'; return r;
    }));
  };
  setView('feed', h('div', { class: 'wrap' }, h('main', {}, composer, tabs, feed), h('div', {})));
  S.feedPend = pend; S.feedPosts = posts; S.feedScope = () => scope; draw();
  const side = await sidebar(); if (S.view === 'feed') $('#view .wrap').lastChild.replaceWith(side);
}
function buildComposer(onPosted) {
  const ta = h('textarea', { placeholder: `What's on your mind, ${S.me.display_name.split(' ')[0]}?`, maxlength: 2000 });
  const sel = h('select', { 'aria-label': 'Audience' }, ...Object.entries(VIS).map(([k, v]) => h('option', { value: k, selected: k === S.me.default_post_visibility }, v[0] + ' ' + v[1])));
  const file = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/gif,image/webp,video/mp4,video/webm', class: 'hidden' });
  const prev = h('div', { class: 'preview hidden' });
  const btn = h('button', { class: 'btn primary', type: 'submit' }, 'Post');
  const clear = () => { file.value = ''; prev.replaceChildren(); prev.classList.add('hidden'); };
  file.onchange = () => {
    const f = file.files[0]; if (!f) return clear();
    if (f.size > 25 * 1024 * 1024) { toast('File too large (max 25MB)'); return clear(); }
    const url = URL.createObjectURL(f);
    prev.replaceChildren(f.type.startsWith('video') ? h('video', { src: url, controls: true }) : h('img', { src: url, alt: 'Preview' }), h('button', { type: 'button', class: 'btn sm', onclick: clear }, '✕'));
    prev.classList.remove('hidden');
  };
  return h('form', { class: 'card composer', onsubmit: async e => {
    e.preventDefault(); if (!ta.value.trim() && !file.files[0]) return;
    btn.disabled = true;
    try {
      const fd = new FormData(); fd.set('body', ta.value); fd.set('visibility', sel.value); if (file.files[0]) fd.set('media', file.files[0]);
      const { post } = await api('POST', '/api/posts', fd); ta.value = ''; clear(); onPosted(post);
    } catch (ex) { toast(ex.message); } finally { btn.disabled = false; }
  } }, ta, prev, h('div', { class: 'composer-bar' }, h('button', { type: 'button', class: 'btn sm', onclick: () => file.click() }, '📷 Photo / Video'), file, sel, h('span', { style: 'flex:1' }), btn));
}
async function viewProfile(username) {
  setView('profile', h('div', { class: 'wrap single' }, h('div', { class: 'muted' }, 'Loading…')));
  let u; try { u = (await api('GET', '/api/users/' + encodeURIComponent(username))).user; } catch (e) { return setView('profile', h('div', { class: 'wrap single' }, h('div', { class: 'card' }, e.message))); }
  if (S.me.username === u.username) navBits.links.me.classList.add('on');
  const act = h('div', { class: 'row-btns' });
  const refresh = () => viewProfile(username);
  const call = (m, url) => async () => { try { await api(m, url); refresh(); } catch (e) { toast(e.message); } };
  if (u.friend_status === 'self') act.append(h('a', { class: 'btn', href: '#/settings' }, 'Edit profile'));
  else if (u.friend_status === 'friends') act.append(h('a', { class: 'btn primary', href: '#/chats/' + u.id }, 'Message'), h('button', { class: 'btn', onclick: () => confirm('Remove this friend?') && call('DELETE', '/api/friends/' + u.id)() }, 'Friends'));
  else if (u.friend_status === 'pending_out') act.append(h('button', { class: 'btn', onclick: call('POST', '/api/friends/decline/' + u.id) }, 'Cancel request'));
  else if (u.friend_status === 'pending_in') act.append(h('button', { class: 'btn primary', onclick: call('POST', '/api/friends/accept/' + u.id) }, 'Accept'), h('button', { class: 'btn', onclick: call('POST', '/api/friends/decline/' + u.id) }, 'Decline'));
  else act.append(h('button', { class: 'btn primary', disabled: !u.allow_friend_requests, title: u.allow_friend_requests ? '' : 'Not accepting requests', onclick: call('POST', '/api/friends/request/' + u.id) }, 'Add friend'));
  const posts = h('div');
  const header = h('div', { class: 'card profile-card' },
    h('div', { class: 'profile-info' }, avatar(u, 'lg'), h('div', { class: 'grow' }, h('h2', {}, u.display_name, u.online && h('span', { class: 'dot', title: 'Online' })), h('div', { class: 'muted' }, '@' + u.username, u.location && ' · 📍 ' + u.location),
      u.can_view && h('p', { style: 'margin:6px 0 0;white-space:pre-wrap' }, u.bio), u.can_view && h('div', { class: 'small muted' }, `${u.friend_count} friends · ${u.post_count} posts · Joined ${new Date(u.created_at * 1000).toLocaleDateString(undefined, { month: 'short', year: 'numeric' })}`)), act));
  const content = u.can_view ? [(u.friend_status === 'self' ? buildComposer(p => posts.prepend(postCard(p))) : null), pager(posts, before => api('GET', `/api/users/${encodeURIComponent(u.username)}/posts?before=${before}`).then(r => ({ ...r, emptyText: 'No posts to show.' })))]
    : [h('div', { class: 'card muted', style: 'text-align:center' }, '🔒 This profile is ' + (u.profile_visibility === 'private' ? 'private.' : 'only visible to friends.'))];
  setView('profile', h('div', { class: 'wrap single' }, h('main', {}, header, ...content)));
  if (S.me.username === u.username) navBits.links.me.classList.add('on');
  S.profileId = u.id;
}
async function viewPost(id) {
  setView('post', h('div', { class: 'wrap single' }, h('main', {}, h('div', { class: 'muted' }, 'Loading…'))));
  try { const { post } = await api('GET', '/api/posts/' + id); setView('post', h('div', { class: 'wrap single' }, h('main', {}, postCard(post, { openComments: true })))); }
  catch (e) { setView('post', h('div', { class: 'wrap single' }, h('div', { class: 'card' }, 'This post is unavailable. It may have been deleted or you may not have access.'))); }
}
async function viewFriends() {
  const main = h('main', {}, h('div', { class: 'muted' }, 'Loading…'));
  setView('friends', h('div', { class: 'wrap single' }, main));
  try {
    const [{ incoming, outgoing }, { friends }] = await Promise.all([api('GET', '/api/friends/requests'), api('GET', '/api/friends')]);
    const act = (label, m, url, cls = '') => { const b = h('button', { class: 'btn sm ' + cls }, label); b.onclick = async () => { try { await api(m, url); } catch (e) { toast(e.message); } }; return b; };
    main.replaceChildren(
      h('div', { class: 'card' }, h('h3', {}, `Friend requests (${incoming.length})`), ...(incoming.length ? incoming.map(u => personRow(u, h('div', { class: 'row-btns' }, act('Accept', 'POST', '/api/friends/accept/' + u.id, 'primary'), act('Decline', 'POST', '/api/friends/decline/' + u.id)))) : [h('div', { class: 'muted small' }, 'No pending requests.')])),
      outgoing.length ? h('div', { class: 'card' }, h('h3', {}, 'Sent requests'), ...outgoing.map(u => personRow(u, act('Cancel', 'POST', '/api/friends/decline/' + u.id)))) : null,
      h('div', { class: 'card' }, h('h3', {}, `Your friends (${friends.length})`), ...(friends.length ? friends.map(u => personRow(u, h('a', { class: 'btn sm primary', href: '#/chats/' + u.id }, 'Chat'))) : [h('div', { class: 'muted small' }, 'Use the search bar to find people and send requests.')])));
  } catch (e) { main.textContent = e.message; }
}
function renderChatMessage(m) {
  return h('div', { class: 'chat-message' + (m.mine ? ' mine' : ''), 'data-mid': m.id }, h('div', { class: 'chat-bubble' }, m.body), h('div', { class: 'small muted chat-time' }, timeAgo(m.created_at)));
}
async function viewChats(friendId = null) {
  const shell = h('div', { class: 'wrap single' }, h('main', {}, h('div', { class: 'card muted' }, 'Loading chats…')));
  setView('chats', shell);
  let friends;
  try { friends = (await api('GET', '/api/chats')).friends; }
  catch (e) { shell.replaceChildren(h('main', {}, h('div', { class: 'card' }, e.message))); return; }
  const selected = friends.find(f => f.id === Number(friendId)) || null;
  const list = h('div', { class: 'chat-friends' }, ...(friends.length ? friends.map(f => h('a', { class: 'chat-friend' + (selected?.id === f.id ? ' selected' : ''), href: '#/chats/' + f.id }, avatar(f, 'sm'), h('span', {}, h('b', {}, f.display_name), h('span', { class: 'small muted chat-last' }, f.last_message?.body || (f.online ? 'Online now' : '@' + f.username))))) : [h('div', { class: 'muted small' }, 'Add friends to start chatting.')]));
  const messages = h('div', { class: 'chat-messages' });
  const input = h('input', { type: 'text', placeholder: selected ? `Message ${selected.display_name}…` : 'Choose a friend to chat', maxlength: 2000, disabled: !selected, 'aria-label': 'Message' });
  const send = h('button', { class: 'btn primary', type: 'submit', disabled: !selected }, 'Send');
  const composer = h('form', { class: 'chat-compose', onsubmit: async e => {
    e.preventDefault(); const body = input.value.trim(); if (!body || !selected) return;
    send.disabled = true;
    try { const { message } = await api('POST', `/api/chats/${selected.id}/messages`, { body }); addMessage(message); input.value = ''; messages.scrollTop = messages.scrollHeight; }
    catch (err) { toast(err.message); } finally { send.disabled = false; input.focus(); }
  } }, input, send);
  const addMessage = m => { if (!messages.querySelector(`[data-mid="${m.id}"]`)) messages.append(renderChatMessage(m)); };
  const conversation = h('section', { class: 'card chat-panel' }, selected ? h('div', { class: 'chat-heading' }, avatar(selected, 'sm'), h('b', {}, selected.display_name, selected.online && h('span', { class: 'dot' }))) : h('div', { class: 'chat-heading muted' }, 'Select a friend'), messages, composer);
  shell.replaceChildren(h('main', { class: 'chat-layout' }, h('section', { class: 'card chat-list' }, h('h3', {}, 'Chats'), list), conversation));
  if (!selected) { messages.append(h('div', { class: 'muted chat-empty' }, friends.length ? 'Choose a friend to view your conversation.' : 'Your conversations will appear here.')); return; }
  S.chatFriendId = selected.id; S.chatMessages = messages; S.chatAddMessage = addMessage;
  try { const r = await api('GET', `/api/chats/${selected.id}/messages`); if (S.view !== 'chats' || S.chatFriendId !== selected.id) return; messages.replaceChildren(...r.messages.map(renderChatMessage)); if (!r.messages.length) messages.append(h('div', { class: 'muted chat-empty' }, 'No messages yet. Say hello!')); messages.scrollTop = messages.scrollHeight; }
  catch (e) { messages.replaceChildren(h('div', { class: 'muted chat-empty' }, e.message)); }
}
async function viewNotifications() {
  const list = h('div'); setView('notifications', h('div', { class: 'wrap single' }, h('main', {}, h('div', { class: 'card' }, h('div', { style: 'display:flex;justify-content:space-between;align-items:center' }, h('h3', {}, 'Notifications'), h('button', { class: 'btn sm', onclick: markRead }, 'Mark all read')), list))));
  S.notifList = list;
  try {
    const { notifications, unread } = await api('GET', '/api/notifications'); setUnread(unread);
    list.replaceChildren(...(notifications.length ? notifications.map(notifEl) : [h('div', { class: 'muted' }, 'Nothing yet.')]));
  } catch (e) { list.textContent = e.message; }
}
const notifEl = n => h('a', { class: 'notif' + (n.read ? '' : ' unread'), href: notifHref(n) }, avatar(n.actor), h('div', {}, h('b', {}, n.actor.display_name), ' ' + notifText(n), n.excerpt && h('span', { class: 'muted' }, ` — “${n.excerpt}”`), h('div', { class: 'small muted' }, timeAgo(n.created_at))));
async function markRead() { try { await api('POST', '/api/notifications/read'); } catch {} }

function viewSettings() {
  const me = S.me, msg = h('div', { class: 'small', style: 'min-height:18px;margin-top:8px' });
  const say = (t, bad) => { msg.textContent = t; msg.style.color = bad ? 'var(--danger)' : 'var(--ok)'; setTimeout(() => msg.textContent === t && (msg.textContent = ''), 4000); };
  const save = async patch => { try { S.me = (await api('PATCH', '/api/me', patch)).user; say('Saved ✓'); } catch (e) { say(e.message, true); } };
  const name = h('input', { type: 'text', value: me.display_name, maxlength: 50 }), loc = h('input', { type: 'text', value: me.location, maxlength: 60 });
  const bio = h('textarea', { maxlength: 300 }, me.bio); bio.value = me.bio;
  const shownAvatar = avatar(me, 'lg');
  const upload = () => {
    const f = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/gif,image/webp', class: 'hidden', 'aria-label': 'Choose profile photo' });
    const filename = h('div', { class: 'small muted file-name', 'aria-live': 'polite' }, 'No photo selected');
    const preview = h('img', { class: 'avatar lg file-preview hidden', alt: 'Selected profile photo preview' });
    const status = h('div', { class: 'small file-status', 'aria-live': 'polite' });
    const choose = h('button', { type: 'button', class: 'btn sm', onclick: () => f.click() }, 'Choose photo');
    let previewUrl = null;
    const uploadBtn = h('button', { type: 'button', class: 'btn primary sm', disabled: true, onclick: async () => {
      if (!f.files[0]) return; uploadBtn.disabled = true; status.textContent = 'Uploading photo�'; status.style.color = 'var(--muted)';
      const fd = new FormData(); fd.set('file', f.files[0]);
      try { S.me = (await api('POST', '/api/me/image/avatar', fd)).user; shownAvatar.replaceWith(avatar(S.me, 'lg')); filename.textContent = 'Uploaded: ' + f.files[0].name; status.textContent = 'Profile photo updated successfully.'; status.style.color = 'var(--ok)'; preview.classList.add('hidden'); }
      catch (e) { uploadBtn.disabled = false; status.textContent = e.message; status.style.color = 'var(--danger)'; }
    } }, 'Uploading�');
    uploadBtn.classList.add('hidden');
    f.onchange = () => {
      const file = f.files[0]; if (!file) { filename.textContent = 'No photo selected'; uploadBtn.disabled = true; preview.classList.add('hidden'); return; }
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      previewUrl = URL.createObjectURL(file); preview.src = previewUrl; preview.classList.remove('hidden');
      filename.textContent = `Selected: ${file.name}`; filename.classList.remove('muted'); filename.style.color = 'var(--ok)';
      status.textContent = 'Selected; uploading photo�'; status.style.color = 'var(--ok)'; uploadBtn.disabled = false; uploadBtn.click();
    };
    return h('div', { class: 'avatar-upload' }, preview, h('div', { class: 'avatar-upload-controls' }, choose, f, filename, h('div', { class: 'row-btns', style: 'margin-top:8px' }, uploadBtn), status));
  };
  const toggle = (key, title, sub) => { const c = h('input', { type: 'checkbox', checked: me[key], onchange: () => save({ [key]: c.checked }) }); return h('label', { class: 'switch', style: 'margin:0;color:var(--ink);font-size:15px' }, h('span', {}, h('b', {}, title), h('div', { class: 'small muted', style: 'font-weight:400' }, sub)), c); };
  const select = (key, title, sub) => { const s = h('select', { onchange: () => save({ [key]: s.value }) }, ...Object.entries(VIS).map(([k, v]) => h('option', { value: k, selected: me[key] === k }, v[0] + ' ' + v[1]))); return h('div', { class: 'switch' }, h('span', {}, h('b', {}, title), h('div', { class: 'small muted' }, sub)), s); };
  const profSel = h('select', { onchange: () => save({ profile_visibility: profSel.value }) }, ...['public', 'friends', 'private'].map(k => h('option', { value: k, selected: me.profile_visibility === k }, { public: '🌐 Everyone', friends: '👥 Friends only', private: '🔒 Only me' }[k])));
  const cur = h('input', { type: 'password', autocomplete: 'current-password' }), nw = h('input', { type: 'password', autocomplete: 'new-password' }), del = h('input', { type: 'password', placeholder: 'Confirm password' });
  setView('settings', h('div', { class: 'wrap single' }, h('main', {},
    h('div', { class: 'card' }, h('h3', {}, 'Profile'), h('div', { style: 'display:flex;gap:12px;align-items:center' }, shownAvatar, upload()),
      h('label', {}, 'Display name'), name, h('label', {}, 'Location'), loc, h('label', {}, 'Bio'), bio,
      h('div', { style: 'margin-top:12px' }, h('button', { class: 'btn primary', onclick: () => save({ display_name: name.value, location: loc.value, bio: bio.value }) }, 'Save profile')), msg),
    h('div', { class: 'card' }, h('h3', {}, 'Privacy'),
      h('div', { class: 'switch' }, h('span', {}, h('b', {}, 'Who can see my profile'), h('div', { class: 'small muted' }, 'Bio, friends and posts. Name and photo always show.')), profSel),
      select('default_post_visibility', 'Default audience for new posts', 'You can change it on each post.'),
      toggle('allow_friend_requests', 'Allow friend requests', 'Turn off to stop receiving new requests.'),
      toggle('searchable', 'Appear in search & suggestions', 'Others can still reach your profile by link.'),
      toggle('show_online', 'Show when I’m online', 'Visible to friends only.')),
    h('div', { class: 'card' }, h('h3', {}, 'Change password'), h('label', {}, 'Current password'), cur, h('label', {}, 'New password (min 8 characters)'), nw,
      h('div', { style: 'margin-top:12px' }, h('button', { class: 'btn', onclick: async () => { try { await api('POST', '/api/me/password', { current: cur.value, next: nw.value }); cur.value = nw.value = ''; say('Password changed ✓'); } catch (e) { say(e.message, true); } } }, 'Update password'))),
    h('div', { class: 'card' }, h('h3', {}, 'Danger zone'), h('p', { class: 'muted small' }, 'Deleting your account permanently removes your posts, comments, photos and friendships.'), del,
      h('div', { style: 'margin-top:12px' }, h('button', { class: 'btn danger', onclick: async () => { if (!confirm('Permanently delete your account?')) return; try { await api('DELETE', '/api/me', { password: del.value }); logout(); } catch (e) { say(e.message, true); } } }, 'Delete account'))),
    h('div', { class: 'card' }, h('button', { class: 'btn', onclick: () => { if (confirm('Are you sure you want to sign out?')) logout(); } }, 'Sign out')))));
}

// ---------- router ----------
function route() {
  if (!S.me) return;
  const [, a, b] = (location.hash || '#/').split('/');
  $('#view')?.scrollTo?.(0, 0); window.scrollTo(0, 0);
  if (!a) viewFeed(); else if (a === 'u' && b) viewProfile(decodeURIComponent(b)); else if (a === 'friends') viewFriends(); else if (a === 'chats') viewChats(b);
  else if (a === 'notifications') viewNotifications(); else if (a === 'settings') viewSettings(); else if (a === 'post' && b) viewPost(+b); else viewFeed();
}
window.addEventListener('hashchange', route);

// ---------- realtime ----------
function connectWS() {
  if (!S.token) return;
  const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/?token=' + encodeURIComponent(S.token));
  S.ws = ws; let hb, wasDown = S.wsTries > 0;
  ws.onopen = () => { S.wsTries = 0; $('#conn')?.classList.add('hidden'); hb = setInterval(() => ws.readyState === 1 && ws.send('{"type":"ping"}'), 25000); if (wasDown) route(); };
  ws.onmessage = e => { try { onEvent(JSON.parse(e.data)); } catch (err) { console.error(err); } };
  ws.onclose = () => { clearInterval(hb); if (S.ws !== ws || !S.token) return; $('#conn')?.classList.remove('hidden'); S.wsTries++; setTimeout(connectWS, Math.min(15000, 500 * 2 ** S.wsTries)); };
}
function flushPending() {
  if (!S.feedPosts) return; for (const p of S.pending.splice(0).reverse()) if (!S.cards.has(p.id)) S.feedPosts.prepend(postCard(p));
  S.feedPend.replaceChildren();
}
function onEvent(ev) {
  switch (ev.type) {
    case 'hello': S.online = new Set(ev.online); setUnread(ev.unread); break;
    case 'presence': ev.online ? S.online.add(ev.user_id) : S.online.delete(ev.user_id); if (S.view === 'friends' || (S.view === 'profile' && S.profileId === ev.user_id)) route(); break;
    case 'notification': {
      setUnread(ev.unread); const n = ev.notification;
      toast(`${n.actor.display_name} ${notifText(n)}`, notifHref(n));
      if (S.view === 'notifications' && S.notifList) { S.notifList.prepend(notifEl(n)); }
      break;
    }
    case 'notification:read': setUnread(0); if (S.view === 'notifications') $('#view .notif.unread')?.parentNode?.querySelectorAll('.unread').forEach(x => x.classList.remove('unread')); break;
    case 'post:new':
      if (S.view === 'feed' && !S.cards.has(ev.post.id)) {
        if (window.scrollY > 250) { S.pending.push(ev.post); S.feedPend.replaceChildren(h('button', { class: 'btn primary sm', onclick: () => { flushPending(); window.scrollTo({ top: 0, behavior: 'smooth' }); } }, `↑ ${S.pending.length} new post${S.pending.length > 1 ? 's' : ''}`)); }
        else { const el = postCard(ev.post); el.classList.add('flash'); S.feedPosts.prepend(el); }
      } else if (S.view === 'profile' && S.profileId === ev.post.author.id) route();
      break;
    case 'post:update': { const c = S.cards.get(ev.post_id); if (c) { c.post.like_count = ev.like_count; c.post.comment_count = ev.comment_count; if (ev.liked !== undefined) c.post.liked = ev.liked; c.draw(); } break; }
    case 'post:edit': { const c = S.cards.get(ev.post.id); if (c) { Object.assign(c.post, ev.post); c.draw(); } break; }
    case 'post:delete': removeCard(ev.post_id); S.pending = S.pending.filter(p => p.id !== ev.post_id); break;
    case 'comment:new': {
      const c = S.cards.get(ev.post_id); if (!c) break; c.post.comment_count = ev.comment_count; c.draw();
      if (c.list && !c.list.querySelector(`[data-cid="${ev.comment.id}"]`)) { const el = commentEl(ev.comment, c); el.classList.add('flash'); c.list.append(el); }
      break;
    }
    case 'comment:delete': { const c = S.cards.get(ev.post_id); if (!c) break; c.post.comment_count = ev.comment_count; c.draw(); c.list?.querySelector(`[data-cid="${ev.comment_id}"]`)?.remove(); break; }
    case 'friend:update': if (['friends', 'profile', 'chats'].includes(S.view)) route(); else if (S.view === 'feed') { sidebar().then(s => S.view === 'feed' && $('#view .wrap').lastChild.replaceWith(s)); } break;
    case 'chat:message': if (S.view === 'chats' && S.chatFriendId && (ev.message.sender_id === S.chatFriendId || ev.message.recipient_id === S.chatFriendId)) { S.chatAddMessage?.(ev.message); if (S.chatMessages) S.chatMessages.scrollTop = S.chatMessages.scrollHeight; } break;
  }
}

// ---------- boot ----------
async function boot() {
  if (!S.token) return renderAuth();
  try {
    const r = await api('GET', '/api/me'); S.me = r.user; S.unread = r.unread;
    await fetch('/api/session', { method: 'POST', headers: { Authorization: 'Bearer ' + S.token } }).catch(() => {}); // refresh media cookie
  } catch { S.token = null; store.set('sn_token', null); return renderAuth(); }
  renderShell(); connectWS();
  route();
}
boot();
