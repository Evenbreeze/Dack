'use strict';

const fs   = require('fs');
const { execSync, spawnSync } = require('child_process');

// Try multiple common Xray config locations
const XRAY_CONFIG_CANDIDATES = [
  '/usr/local/etc/xray/config.json',
  '/etc/xray/config.json',
  '/opt/xray/config.json',
  '/usr/local/etc/xray/conf/config.json',
];

function findXrayConfig() {
  for (const p of XRAY_CONFIG_CANDIDATES) {
    if (fs.existsSync(p)) return p;
  }
  return XRAY_CONFIG_CANDIDATES[0]; // fallback
}

const XRAY_CONFIG = findXrayConfig();
const ACCESS_LOG  = '/var/log/xray/access.log';
const XRAY_API    = '127.0.0.1:10085';
// Online threshold: active within 5 minutes counts as online
const ONLINE_MS   = 5 * 60 * 1000;

/* ─── Config helpers ─────────────────────────────────── */

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(XRAY_CONFIG, 'utf8'));
  } catch (e) {
    throw new Error(`读取 Xray 配置失败: ${e.message}`);
  }
}

function writeConfig(cfg) {
  fs.writeFileSync(XRAY_CONFIG, JSON.stringify(cfg, null, 2), 'utf8');
}

function reloadXray() {
  const r = spawnSync('systemctl', ['reload', 'xray'], { timeout: 10000 });
  if (r.status !== 0) {
    spawnSync('systemctl', ['restart', 'xray'], { timeout: 15000 });
  }
}

/* ─── VLESS inbound ──────────────────────────────────── */

function getVlessInbound(cfg) {
  return (cfg.inbounds || []).find(i => i.protocol === 'vless');
}

function getClients(cfg) {
  const inb = getVlessInbound(cfg);
  return inb?.settings?.clients || [];
}

/* ─── Add / remove / update client ──────────────────── */

function addClient(cfg, uuid, email) {
  const inb = getVlessInbound(cfg);
  if (!inb) throw new Error('找不到 VLESS 入站，请检查 Xray 配置');

  inb.settings         = inb.settings         || {};
  inb.settings.clients = inb.settings.clients || [];

  // Skip if already present
  if (inb.settings.clients.some(c => c.id === uuid)) return;

  inb.settings.clients.push({
    id:    uuid,
    email: email || uuid.slice(0, 8),
    level: 0,
    flow:  '',
  });
}

function removeClient(cfg, uuid) {
  const inb = getVlessInbound(cfg);
  if (!inb?.settings?.clients) return;
  inb.settings.clients = inb.settings.clients.filter(c => c.id !== uuid);
}

function updateClientEmail(cfg, uuid, newEmail) {
  const inb = getVlessInbound(cfg);
  if (!inb?.settings?.clients) return;
  const c = inb.settings.clients.find(c => c.id === uuid);
  if (!c) return;
  c.email = newEmail || uuid.slice(0, 8);
}

/* ─── Xray Stats API — enable ────────────────────────── */

// Adds stats/api/policy sections to Xray config if missing.
// Returns true if the config was modified and needs to be written back.
function enableStats(cfg) {
  let changed = false;

  // stats module
  if (!cfg.stats) { cfg.stats = {}; changed = true; }

  // api service
  if (!cfg.api) {
    cfg.api = { tag: 'api', services: ['StatsService'] };
    changed = true;
  }

  // policy: per-user traffic stats on level 0
  cfg.policy            = cfg.policy            || {};
  cfg.policy.levels     = cfg.policy.levels     || {};
  cfg.policy.levels['0'] = cfg.policy.levels['0'] || {};
  if (!cfg.policy.levels['0'].statsUserUplink) {
    cfg.policy.levels['0'].statsUserUplink = true; changed = true;
  }
  if (!cfg.policy.levels['0'].statsUserDownlink) {
    cfg.policy.levels['0'].statsUserDownlink = true; changed = true;
  }

  // API inbound (dokodemo-door on localhost)
  cfg.inbounds = cfg.inbounds || [];
  if (!cfg.inbounds.find(i => i.tag === 'api')) {
    cfg.inbounds.push({
      tag:      'api',
      listen:   '127.0.0.1',
      port:     10085,
      protocol: 'dokodemo-door',
      settings: { address: '127.0.0.1' },
    });
    changed = true;
  }

  // API outbound (freedom)
  cfg.outbounds = cfg.outbounds || [];
  if (!cfg.outbounds.find(o => o.tag === 'api')) {
    cfg.outbounds.push({ tag: 'api', protocol: 'freedom' });
    changed = true;
  }

  // Routing rule: api inbound → api outbound (must be FIRST rule)
  cfg.routing        = cfg.routing        || {};
  cfg.routing.rules  = cfg.routing.rules  || [];
  if (!cfg.routing.rules.find(r => r.inboundTag?.includes('api'))) {
    cfg.routing.rules.unshift({
      type:        'field',
      inboundTag:  ['api'],
      outboundTag: 'api',
    });
    changed = true;
  }

  return changed;
}

/* ─── Xray Stats API — query ─────────────────────────── */

// Query per-user traffic since last call (uses -reset flag).
// Returns: { email: { uplink, downlink, total } }
// Returns empty object if API is unavailable or no data.
function queryTrafficStats() {
  const stats = {};
  try {
    const out = execSync(
      `xray api statsquery --server="${XRAY_API}" -pattern "user>>>" -reset 2>/dev/null`,
      { encoding: 'utf8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] }
    );

    const parsed = JSON.parse(out);
    for (const item of (parsed.stat || [])) {
      // Format: "user>>>email>>>traffic>>>uplink" or ">>>downlink"
      const parts = item.name.split('>>>');
      if (parts.length !== 4 || parts[0] !== 'user' || parts[2] !== 'traffic') continue;
      const email     = parts[1];
      const direction = parts[3]; // 'uplink' or 'downlink'
      const bytes     = parseInt(item.value) || 0;
      if (!stats[email]) stats[email] = { uplink: 0, downlink: 0, total: 0 };
      stats[email][direction] = bytes;
      stats[email].total += bytes;
    }
  } catch { /* API not available yet — return empty */ }
  return stats;
}

/* ─── Online detection (log parse) ──────────────────── */

function getOnlineEmails() {
  const online    = new Set();
  const lastSeen  = {};   // email → epoch ms
  const onlineIps = {};   // email → Set<ip>

  if (!fs.existsSync(ACCESS_LOG)) return { online, lastSeen, onlineIps: {} };

  let tail = '';
  try {
    tail = execSync(`tail -n 3000 "${ACCESS_LOG}"`, {
      encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch { return { online, lastSeen, onlineIps: {} }; }

  const now = Date.now();

  for (const line of tail.split('\n')) {
    const tMatch  = line.match(/^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
    const eMatch  = line.match(/email:\s*(\S+)/);
    if (!tMatch || !eMatch) continue;

    const [, yr, mo, dy, hr, mi, sc] = tMatch;
    const ts    = new Date(`${yr}/${mo}/${dy} ${hr}:${mi}:${sc}`).getTime();
    const email = eMatch[1];

    const ipMatch = line.match(/from\s+([\d.]+):/);
    const ip      = ipMatch ? ipMatch[1] : null;

    if (!lastSeen[email] || lastSeen[email] < ts) lastSeen[email] = ts;

    if (now - ts < ONLINE_MS) {
      online.add(email);
      if (ip) {
        if (!onlineIps[email]) onlineIps[email] = new Set();
        onlineIps[email].add(ip);
      }
    }
  }

  const result = {};
  for (const [k, v] of Object.entries(onlineIps)) result[k] = [...v];

  return { online, lastSeen, onlineIps: result };
}

/* ─── VLESS link generator ───────────────────────────── */

function buildVlessLink(uuid, remark, cfg, serverIp) {
  const inb = getVlessInbound(cfg);
  if (!inb) return null;

  const port      = inb.port || 443;
  const ss        = inb.streamSettings || {};
  const security  = ss.security  || 'none';
  const network   = ss.network   || 'tcp';

  const params = new URLSearchParams({ encryption: 'none', security, type: network });

  if (security === 'tls') {
    const sni = ss.tlsSettings?.serverName || serverIp;
    params.set('sni', sni);
    if (ss.tlsSettings?.fingerprint) params.set('fp', ss.tlsSettings.fingerprint);
  }

  if (security === 'reality') {
    const rs = ss.realitySettings || {};
    params.set('sni',       rs.serverNames?.[0] || serverIp);
    params.set('pbk',       rs.publicKey || '');
    params.set('sid',       rs.shortIds?.[0] || '');
    params.set('fp',        rs.fingerprint || 'chrome');
  }

  if (network === 'ws') {
    const ws = ss.wsSettings || {};
    if (ws.path)          params.set('path', ws.path);
    if (ws.headers?.Host) params.set('host', ws.headers.Host);
  }

  if (network === 'grpc') {
    const grpc = ss.grpcSettings || {};
    if (grpc.serviceName) params.set('serviceName', grpc.serviceName);
    params.set('mode', 'gun');
  }

  const clients  = getClients(cfg);
  const existing = clients.find(c => c.id === uuid);
  if (existing?.flow) params.set('flow', existing.flow);

  const tag = encodeURIComponent(remark || 'VLESS');
  return `vless://${uuid}@${serverIp}:${port}?${params.toString()}#${tag}`;
}

module.exports = {
  readConfig, writeConfig, reloadXray,
  addClient, removeClient, updateClientEmail,
  getClients,
  enableStats, queryTrafficStats,
  getOnlineEmails, buildVlessLink,
  XRAY_CONFIG,
};
