'use strict';
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const { DATA } = require('./util');

const db = new DatabaseSync(process.env.DB_PATH || path.join(DATA, 'social.db'));
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL COLLATE NOCASE, email TEXT UNIQUE NOT NULL COLLATE NOCASE,
  password_hash TEXT NOT NULL, display_name TEXT NOT NULL, bio TEXT NOT NULL DEFAULT '', location TEXT NOT NULL DEFAULT '',
  avatar TEXT, cover TEXT,
  profile_visibility TEXT NOT NULL DEFAULT 'public' CHECK(profile_visibility IN ('public','friends','private')),
  default_post_visibility TEXT NOT NULL DEFAULT 'friends' CHECK(default_post_visibility IN ('public','friends','private')),
  allow_friend_requests INTEGER NOT NULL DEFAULT 1, show_online INTEGER NOT NULL DEFAULT 1, searchable INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()));
CREATE TABLE IF NOT EXISTS posts(
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL DEFAULT '', media TEXT, media_type TEXT,
  visibility TEXT NOT NULL DEFAULT 'friends' CHECK(visibility IN ('public','friends','private')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()));
CREATE INDEX IF NOT EXISTS idx_posts_user ON posts(user_id, id DESC);
CREATE TABLE IF NOT EXISTS comments(
  id INTEGER PRIMARY KEY, post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, body TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()));
CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id, id);
CREATE TABLE IF NOT EXISTS likes(
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()), PRIMARY KEY(user_id, post_id));
CREATE TABLE IF NOT EXISTS friendships(
  id INTEGER PRIMARY KEY, requester_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  addressee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()), UNIQUE(requester_id, addressee_id), CHECK(requester_id != addressee_id));
CREATE TABLE IF NOT EXISTS notifications(
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  actor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, type TEXT NOT NULL,
  post_id INTEGER REFERENCES posts(id) ON DELETE CASCADE, read INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()));
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, id DESC);
CREATE TABLE IF NOT EXISTS messages(
  id INTEGER PRIMARY KEY, sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL CHECK(length(body) BETWEEN 1 AND 2000), created_at INTEGER NOT NULL DEFAULT (unixepoch()));
CREATE INDEX IF NOT EXISTS idx_messages_pair ON messages(sender_id, recipient_id, id);
`);
module.exports = db;
