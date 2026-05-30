'use strict';

const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'data.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    uuid          TEXT    UNIQUE NOT NULL,
    remark        TEXT    DEFAULT '',
    note          TEXT    DEFAULT '',
    status        TEXT    DEFAULT 'approved',
    max_ips       INTEGER DEFAULT 1,
    traffic_limit INTEGER DEFAULT 0,
    traffic_used  INTEGER DEFAULT 0,
    expires_at    DATETIME,
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_seen     DATETIME,
    last_ip       TEXT    DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS ip_blocks (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    ip         TEXT    UNIQUE NOT NULL,
    user_id    INTEGER,
    note       TEXT    DEFAULT '',
    blocked_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Migrations for existing databases
try { db.exec('ALTER TABLE users ADD COLUMN expires_at DATETIME'); }             catch {}
try { db.exec('ALTER TABLE users ADD COLUMN max_ips INTEGER DEFAULT 1'); }       catch {}
try { db.exec('ALTER TABLE users ADD COLUMN traffic_limit INTEGER DEFAULT 0'); } catch {}
try { db.exec('ALTER TABLE users ADD COLUMN traffic_used INTEGER DEFAULT 0'); }  catch {}
try { db.exec("ALTER TABLE users ADD COLUMN last_ip TEXT DEFAULT ''"); }         catch {}

const users = {
  all() {
    return db.prepare('SELECT * FROM users ORDER BY created_at DESC').all();
  },

  byId(id) {
    return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  },

  create(uuid, remark) {
    const r = db.prepare('INSERT INTO users (uuid, remark) VALUES (?, ?)').run(uuid, remark || '');
    return users.byId(r.lastInsertRowid);
  },

  update(id, data) {
    const allowed = [
      'remark', 'note', 'status', 'max_ips',
      'traffic_limit', 'traffic_used',
      'last_seen', 'last_ip', 'expires_at',
    ];
    const fields = Object.keys(data).filter(k => allowed.includes(k));
    if (!fields.length) return users.byId(id);
    const sets = fields.map(f => `${f} = ?`).join(', ');
    const vals = fields.map(f => data[f]);
    db.prepare(`UPDATE users SET ${sets} WHERE id = ?`).run(...vals, id);
    return users.byId(id);
  },

  touchSeen(uuid) {
    db.prepare("UPDATE users SET last_seen = datetime('now') WHERE uuid = ?").run(uuid);
  },

  remove(id) {
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
  },

  getExpired() {
    return db.prepare(
      "SELECT * FROM users WHERE status = 'approved' AND expires_at IS NOT NULL AND expires_at <= datetime('now')"
    ).all();
  },

  getTrafficLimited() {
    return db.prepare(
      "SELECT * FROM users WHERE status = 'approved' AND traffic_limit > 0"
    ).all();
  },

  getApproved() {
    return db.prepare("SELECT * FROM users WHERE status = 'approved'").all();
  },
};

const ipBlocks = {
  all() {
    return db.prepare('SELECT * FROM ip_blocks ORDER BY blocked_at DESC').all();
  },

  isBlocked(ip) {
    return !!db.prepare('SELECT id FROM ip_blocks WHERE ip = ?').get(ip);
  },

  block(ip, userId) {
    try {
      db.prepare('INSERT INTO ip_blocks (ip, user_id) VALUES (?, ?)').run(ip, userId || null);
    } catch {} // ignore duplicate
  },

  unblock(ip) {
    db.prepare('DELETE FROM ip_blocks WHERE ip = ?').run(ip);
  },

  byUserId(userId) {
    return db.prepare('SELECT * FROM ip_blocks WHERE user_id = ?').all(userId);
  },
};

module.exports = { users, ipBlocks };
