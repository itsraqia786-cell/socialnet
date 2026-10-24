# Circle — a real-time social network

Full-stack social platform with **zero npm dependencies**: only Node.js ≥ 22.5 (built-in `node:sqlite`, `http`, `crypto`, plus a hand-written RFC 6455 WebSocket server).

## Run
```bash
npm start     # http://localhost:3000  (PORT=8080 to change)
npm test      # 16-step end-to-end suite (REST + WebSocket + privacy checks)
```
Env: `PORT`, `DB_PATH`, `UPLOAD_DIR`, `SESSION_SECRET` (auto-generated into `data/.secret` if unset).

## Features
- **Accounts**: register/login (scrypt hashes, HMAC-signed 7-day tokens), change password, delete account (cascades posts, media, friendships)
- **Profiles**: display name, bio, location, avatar, cover image, friend/post counts, online dot
- **Posts**: text + image/video (JPEG, PNG, GIF, WebP, MP4, WebM ≤ 25 MB, verified by magic bytes), edit, delete, per-post audience
- **Interaction**: likes (toggle), comments (post owner can moderate), paginated feed
- **Friends**: request / accept / decline / cancel / unfriend, mutual requests auto-accept, search, suggestions
- **Notifications**: likes, comments, friend requests/accepts; persisted, unread badge, mark-all-read, live toasts
- **Privacy**: profile visibility (everyone / friends / only me), post audience (public / friends / only me), default audience, allow friend requests, searchable, show online status
- **Real-time (WebSocket)**: new posts, live like/comment counts and comments, edits/deletes, notifications, friend changes, presence

## Architecture
```
server.js     REST API, access control, static + media serving, WebSocket fan-out
lib/ws.js     WebSocket server (handshake, framing, masking, ping/pong, size limits)
lib/db.js     SQLite schema
lib/util.js   tokens, password hashing, multipart parser, media sniffing
public/       single-page client (hash router, no framework, no innerHTML)
test/e2e.js   end-to-end tests
```
Authorization is enforced server-side in one place (`canViewPost` / `canViewProfile`) and applied to REST reads, uploaded media (`/uploads/*`, cookie-authenticated, checked per file) and every WebSocket push, so private content never leaks over a socket.

Security: scrypt, constant-time token compare, rate limits, body-size limits, strict CSP, `nosniff`, WebSocket origin check, path-traversal-safe static serving, unguessable media names, parameterised SQL.

## API (Bearer token except register/login)
`POST /api/register|login|logout|session` · `GET|PATCH|DELETE /api/me` · `POST /api/me/password` · `POST /api/me/image/{avatar|cover}`
`GET /api/users/search?q=|suggestions|:username|:username/posts` · `GET /api/feed?scope=&before=`
`POST /api/posts` · `GET|PATCH|DELETE /api/posts/:id` · `POST /api/posts/:id/like` · `GET|POST /api/posts/:id/comments` · `DELETE /api/comments/:id`
`GET /api/friends|friends/requests` · `POST /api/friends/request|accept|decline/:id` · `DELETE /api/friends/:id`
`GET /api/notifications` · `POST /api/notifications/read`

WebSocket (`/?token=…`) events: `hello presence notification notification:read post:new post:edit post:update post:delete comment:new comment:delete friend:update`

## Scaling
Single process, in-memory socket registry. To scale out: Postgres, Redis pub/sub for fan-out, object storage for media.
