'use strict';

const express    = require('express');
const https      = require('https');
const http       = require('http');
const fs         = require('fs');
const path       = require('path');
const crypto     = require('crypto');
const readline   = require('readline');
const { spawnSync } = require('child_process');

const { users } = require('./db');
const xray = require('./xray');

const CFG_FILE = path.join(__dirname, 'admin.config.json');

/* ─── Expiry helpers ────────────────────────────────── */

// duration: days (0 = permanent, positive = N days from now)
function calcExpiresAt(durationDays) {
  if (!durationDays || durationDays <= 0) return null;
  const d = new Date();
  d.setDate(d.getDate() + durationDays);
  return d.toISOString();
}

/* ─── Admin config ──────────────────────────────────── */

function loadCfg() {
  if (fs.existsSync(CFG_FILE)) {
    try { return JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')); } catch {}
  }
  return null;
}

function saveCfg(cfg) {
  fs.writeFileSync(CFG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
}

function hashPwd(pwd) {
  return crypto.createHash('sha256').update(pwd).digest('hex');
}

/* ─── First-run wizard ──────────────────────────────── */

async function setupWizard() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = q => new Promise(resolve => rl.question(q, resolve));

  console.log('\n╔══════════════════════════════════════╗');
  console.log('║     Xray 管理后台 — 首次配置         ║');
  console.log('╚══════════════════════════════════════╝\n');

  const username = (await ask('管理员用户名 [admin]: ')).trim() || 'admin';

  let password = '';
  while (password.length < 6) {
    password = (await ask('管理员密码（至少 6 位）: ')).trim();
    if (password.length < 6) console.log('  ✗ 密码太短，请重新输入');
  }

  const portStr = (await ask('后台监听端口 [39271]: ')).trim();
  const port = parseInt(portStr) || 39271;

  const pathIn = (await ask('访问路径（留空则随机生成）: ')).trim();
  let adminPath = pathIn ? (pathIn.startsWith('/') ? pathIn : '/' + pathIn)
                         : '/' + crypto.randomBytes(8).toString('hex');

  const serverIp = (await ask('服务器公网 IP: ')).trim();

  rl.close();

  const cfg = { username, passwordHash: hashPwd(password), port, adminPath, serverIp };
  saveCfg(cfg);

  console.log('\n✅ 配置完成！');
  console.log(`🔗 访问地址: https://${serverIp}:${port}${adminPath}`);
  console.log('⚠️  浏览器会提示证书风险，点击"继续"即可\n');

  return cfg;
}

/* ─── Self-signed cert ──────────────────────────────── */

function ensureCert() {
  const cert = path.join(__dirname, 'cert.pem');
  const key  = path.join(__dirname, 'key.pem');

  if (!fs.existsSync(cert) || !fs.existsSync(key)) {
    console.log('生成自签名证书...');
    const r = spawnSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048',
      '-keyout', key, '-out', cert,
      '-days', '3650', '-nodes',
      '-subj', '/CN=xray-admin',
    ], { timeout: 30000, stdio: 'pipe' });

    if (r.status !== 0) {
      console.warn('openssl 不可用，将以 HTTP 模式运行');
      return null;
    }
    console.log('✅ 证书生成成功');
  }
  return { cert: fs.readFileSync(cert), key: fs.readFileSync(key) };
}

/* ─── App ───────────────────────────────────────────── */

async function main() {
  let cfg = loadCfg();
  if (!cfg) cfg = await setupWizard();

  const app  = express();
  const BASE = cfg.adminPath;

  app.use(express.json());
  // Serve static files; index.html auto-detects BASE from URL — no replacement needed
  app.use(BASE, express.static(path.join(__dirname, 'public')));

  function serveIndex(res) {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  }

  /* ── Session store (24-hour expiry) ── */
  const sessions    = new Map();
  const mkToken     = () => crypto.randomBytes(32).toString('hex');
  const SESSION_TTL = 24 * 60 * 60 * 1000; // 24 hours

  function auth(req, res, next) {
    const token = req.headers['x-auth-token'];
    const sess  = sessions.get(token);
    if (sess) {
      if (Date.now() - sess.at < SESSION_TTL) return next();
      sessions.delete(token); // expired — clean up
    }
    res.status(401).json({ error: '未登录' });
  }

  /* ── Login rate limiter (max 10 attempts per IP per 5 min) ── */
  const loginAttempts = new Map(); // ip → { count, resetAt }

  function checkLoginRate(ip) {
    const now  = Date.now();
    let   rec  = loginAttempts.get(ip);
    if (!rec || now > rec.resetAt) {
      rec = { count: 0, resetAt: now + 5 * 60 * 1000 };
    }
    rec.count++;
    loginAttempts.set(ip, rec);
    return rec.count;
  }

  // Clean up stale rate-limit records every 10 minutes
  setInterval(() => {
    const now = Date.now();
    for (const [ip, rec] of loginAttempts) {
      if (now > rec.resetAt) loginAttempts.delete(ip);
    }
  }, 10 * 60 * 1000);

  /* ── Login / Logout ── */

  app.post(`${BASE}/api/login`, (req, res) => {
    const ip = req.socket.remoteAddress || 'unknown';
    const attempts = checkLoginRate(ip);
    if (attempts > 10) {
      return res.status(429).json({ error: '尝试次数过多，请5分钟后再试' });
    }

    const { username, password } = req.body || {};
    if (username === cfg.username && hashPwd(password || '') === cfg.passwordHash) {
      loginAttempts.delete(ip); // reset on success
      const token = mkToken();
      sessions.set(token, { at: Date.now() });
      return res.json({ token });
    }
    res.status(401).json({ error: '用户名或密码错误' });
  });

  app.post(`${BASE}/api/logout`, auth, (req, res) => {
    sessions.delete(req.headers['x-auth-token']);
    res.json({ ok: true });
  });

  /* ── Users ── */

  app.get(`${BASE}/api/users`, auth, (req, res) => {
    try {
      const list = users.all();
      const { online, lastSeen, onlineIps } = xray.getOnlineEmails();

      const result = list.map(u => {
        const email    = u.remark || u.uuid.slice(0, 8);
        const isOnline = online.has(email);
        const ips      = onlineIps[email] || [];
        if (isOnline) users.touchSeen(u.uuid);
        const logTs = lastSeen[email];
        return {
          ...u,
          isOnline,
          onlineIps: ips,
          last_seen: isOnline ? new Date().toISOString()
                   : logTs    ? new Date(logTs).toISOString()
                   : u.last_seen,
        };
      });

      res.json(result);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post(`${BASE}/api/users`, auth, (req, res) => {
    try {
      const { remark, duration, max_ips, traffic_limit } = req.body || {};
      const uuid  = crypto.randomUUID();
      const email = remark || uuid.slice(0, 8);

      // Step 1: add to Xray first — if this fails, nothing written to DB
      const xcfg = xray.readConfig();
      xray.addClient(xcfg, uuid, email);
      xray.writeConfig(xcfg);
      xray.reloadXray();

      // Step 2: create in DB after Xray succeeds
      let user = users.create(uuid, remark);
      const expires_at  = calcExpiresAt(parseInt(duration) || 0);
      const parsedMaxIps = parseInt(max_ips);
      const parsedTrafficLimit = parseInt(traffic_limit) || 0;
      user = users.update(user.id, {
        expires_at,
        max_ips:       isNaN(parsedMaxIps) ? 1 : parsedMaxIps,
        traffic_limit: parsedTrafficLimit,
      });

      res.json(user);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.put(`${BASE}/api/users/:id`, auth, (req, res) => {
    try {
      const { remark, note, duration, max_ips, traffic_limit } = req.body || {};
      const patch = {};
      if (remark        !== undefined) patch.remark        = remark;
      if (note          !== undefined) patch.note          = note;
      if (max_ips       !== undefined) patch.max_ips       = parseInt(max_ips);
      if (traffic_limit !== undefined) patch.traffic_limit = parseInt(traffic_limit) || 0;
      if (duration !== undefined && duration !== -1) {
        patch.expires_at = calcExpiresAt(parseInt(duration) || 0);
      }

      let user = users.update(req.params.id, patch);

      // If approved and remark changed → sync email in Xray
      if (remark !== undefined && user.status === 'approved') {
        try {
          const xcfg = xray.readConfig();
          xray.updateClientEmail(xcfg, user.uuid, user.remark);
          xray.writeConfig(xcfg);
          xray.reloadXray();
        } catch {}
      }

      // If was expired and now has a new future expiry → re-approve
      if (duration !== undefined && duration !== -1 && user.status === 'expired') {
        const newExpiry = patch.expires_at;
        if (!newExpiry || new Date(newExpiry) > new Date()) {
          try {
            const xcfg = xray.readConfig();
            xray.addClient(xcfg, user.uuid, user.remark || user.uuid.slice(0, 8));
            xray.writeConfig(xcfg);
            xray.reloadXray();
            user = users.update(user.id, { status: 'approved' });
          } catch {}
        }
      }

      res.json(user);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  /* Sync users from Xray config into DB */
  app.post(`${BASE}/api/sync-xray`, auth, (req, res) => {
    try {
      const xcfg    = xray.readConfig();
      const clients = xray.getClients(xcfg);

      // Build uuid → alias map from config_export.json (generated by vless.sh)
      const aliasMap = {};
      const exportCandidates = [
        '/etc/xray/config_export.json',
        '/usr/local/etc/xray/config_export.json',
        '/opt/xray/config_export.json',
      ];
      for (const p of exportCandidates) {
        try {
          if (!fs.existsSync(p)) continue;
          const exported = JSON.parse(fs.readFileSync(p, 'utf8'));
          // vless.sh puts the link at xray_config.vless_link
          const link = exported?.xray_config?.vless_link
                    || exported?.server_info?.config?.xray_config?.vless_link;
          if (link) {
            const uuidM  = link.match(/vless:\/\/([^@]+)@/);
            const aliasM = link.match(/#(.+)$/);
            if (uuidM && aliasM) {
              aliasMap[uuidM[1]] = decodeURIComponent(aliasM[1]);
            }
          }
          break;
        } catch {}
      }

      const imported = [];
      const skipped  = [];

      for (const c of clients) {
        if (!c.id) continue;

        const existing = users.all().find(u => u.uuid === c.id);
        if (existing) { skipped.push(c.id); continue; }

        // Priority: alias from export file → email field → uuid prefix
        const remark = aliasMap[c.id] || c.email || c.id.slice(0, 8);
        let user = users.create(c.id, remark);
        users.update(user.id, { status: 'approved' });
        imported.push({ uuid: c.id, remark });
      }

      res.json({ ok: true, imported: imported.length, skipped: skipped.length, details: imported });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  /* Reset a user's traffic counter */
  app.post(`${BASE}/api/users/:id/reset-traffic`, auth, (req, res) => {
    try {
      const user = users.byId(req.params.id);
      if (!user) return res.status(404).json({ error: '用户不存在' });
      res.json(users.update(user.id, { traffic_used: 0 }));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  /* Block */
  app.post(`${BASE}/api/users/:id/block`, auth, (req, res) => {
    try {
      const user = users.byId(req.params.id);
      if (!user) return res.status(404).json({ error: '用户不存在' });

      const xcfg = xray.readConfig();
      xray.removeClient(xcfg, user.uuid);
      xray.writeConfig(xcfg);
      xray.reloadXray();

      res.json(users.update(user.id, { status: 'blocked' }));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  /* Unblock */
  app.post(`${BASE}/api/users/:id/unblock`, auth, (req, res) => {
    try {
      const user = users.byId(req.params.id);
      if (!user) return res.status(404).json({ error: '用户不存在' });

      const xcfg  = xray.readConfig();
      const email = user.remark || user.uuid.slice(0, 8);
      xray.addClient(xcfg, user.uuid, email);
      xray.writeConfig(xcfg);
      xray.reloadXray();

      // If unblocking a user whose traffic quota was already exceeded,
      // auto-reset their traffic counter so checkTraffic won't re-block
      // them immediately in the next 5-minute cycle.
      const patch = { status: 'approved' };
      if (user.traffic_limit > 0) {
        const limitBytes = user.traffic_limit * 1073741824;
        if ((user.traffic_used || 0) >= limitBytes) {
          patch.traffic_used = 0;
        }
      }

      res.json(users.update(user.id, patch));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  /* Delete */
  app.delete(`${BASE}/api/users/:id`, auth, (req, res) => {
    try {
      const user = users.byId(req.params.id);
      if (!user) return res.status(404).json({ error: '用户不存在' });

      if (user.status === 'approved') {
        try {
          const xcfg = xray.readConfig();
          xray.removeClient(xcfg, user.uuid);
          xray.writeConfig(xcfg);
          xray.reloadXray();
        } catch {}
      }

      users.remove(user.id);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  /* Get VLESS link */
  app.get(`${BASE}/api/users/:id/link`, auth, (req, res) => {
    try {
      const user = users.byId(req.params.id);
      if (!user) return res.status(404).json({ error: '用户不存在' });
      const xcfg = xray.readConfig();
      const link = xray.buildVlessLink(user.uuid, user.remark, xcfg, cfg.serverIp);
      res.json({ link });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  /* ── Settings ── */

  app.get(`${BASE}/api/settings`, auth, (req, res) => {
    res.json({ serverIp: cfg.serverIp, username: cfg.username });
  });

  app.put(`${BASE}/api/settings`, auth, (req, res) => {
    try {
      const { serverIp, newPassword } = req.body || {};
      if (serverIp) cfg.serverIp = serverIp;
      if (newPassword && newPassword.length >= 6) {
        cfg.passwordHash = hashPwd(newPassword);
      }
      saveCfg(cfg);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  /* ── Catch-all SPA ── */
  app.get(`${BASE}`,    (req, res) => serveIndex(res));
  app.get(`${BASE}/`,   (req, res) => serveIndex(res));
  app.get(`${BASE}/*`,  (req, res) => {
    if (/\.\w+$/.test(req.path)) return res.status(404).send('Not Found');
    serveIndex(res);
  });
  app.use((req, res) => res.status(404).send('Not Found'));

  /* ── Enable Xray Stats API on startup ── */
  try {
    const xcfg = xray.readConfig();
    if (xray.enableStats(xcfg)) {
      xray.writeConfig(xcfg);
      xray.reloadXray();
      console.log('✅ Xray 流量统计已启用');
    }
  } catch (e) {
    console.warn('⚠️  无法启用 Xray 流量统计（节点未安装？）:', e.message);
  }

  /* ── Expiry checker: every 60 s ── */
  function checkExpired() {
    try {
      const expired = users.getExpired();
      if (!expired.length) return;

      const xcfg = xray.readConfig();
      for (const u of expired) xray.removeClient(xcfg, u.uuid);

      xray.writeConfig(xcfg);
      xray.reloadXray();

      for (const u of expired) {
        users.update(u.id, { status: 'expired' });
        console.log(`[到期] 用户 "${u.remark || u.uuid.slice(0, 8)}" 已到期，自动封禁`);
      }
    } catch (e) {
      console.error('[到期检测] 错误:', e.message);
    }
  }

  checkExpired();
  setInterval(checkExpired, 60 * 1000);

  /* ── Traffic checker: every 5 min ── */
  function checkTraffic() {
    try {
      // Step 1: only proceed if there are traffic-limited users
      const limited = users.getTrafficLimited();
      if (!limited.length) return;

      // Step 2: query Xray stats (resets counters — do this only when needed)
      const stats = xray.queryTrafficStats();
      if (!Object.keys(stats).length) return;

      // Step 3: always update traffic in DB first (before any Xray ops)
      // so data is not lost if Xray config write fails
      const toBlock = [];
      for (const u of limited) {
        const email = u.remark || u.uuid.slice(0, 8);
        const st    = stats[email];
        if (!st || !st.total) continue;

        const newUsed    = (u.traffic_used || 0) + st.total;
        const limitBytes = u.traffic_limit * 1024 * 1024 * 1024;

        users.update(u.id, { traffic_used: newUsed });

        if (newUsed >= limitBytes) {
          console.log(`[流量超限] "${email}" 已用 ${(newUsed / 1073741824).toFixed(2)} GB，` +
                      `限额 ${u.traffic_limit} GB，自动封禁`);
          toBlock.push(u);
        }
      }

      // Step 4: block exceeded users — read Xray config only if needed
      if (toBlock.length) {
        const xcfg = xray.readConfig();
        for (const u of toBlock) xray.removeClient(xcfg, u.uuid);
        xray.writeConfig(xcfg);
        xray.reloadXray();
        for (const u of toBlock) users.update(u.id, { status: 'blocked' });
      }
    } catch (e) {
      console.error('[流量检测] 错误:', e.message);
    }
  }

  checkTraffic();
  setInterval(checkTraffic, 5 * 60 * 1000);

  /* ── IP limit checker: every 60 s ── */
  function checkIpLimits() {
    try {
      const approved = users.getApproved();
      if (!approved.length) return;

      const { onlineIps } = xray.getOnlineEmails();

      // Step 1: find who exceeded — no Xray I/O yet
      const toBlock = [];
      for (const u of approved) {
        const limit = u.max_ips;
        if (!limit || limit <= 0) continue;

        const email = u.remark || u.uuid.slice(0, 8);
        const ips   = onlineIps[email] || [];
        if (ips.length <= limit) continue;

        console.log(`[IP超限] "${email}" 在线 ${ips.length} 个IP，上限 ${limit}，自动封禁`);
        toBlock.push(u);
      }

      // Step 2: block exceeded users — read Xray config only if needed
      if (toBlock.length) {
        const xcfg = xray.readConfig();
        for (const u of toBlock) xray.removeClient(xcfg, u.uuid);
        xray.writeConfig(xcfg);
        xray.reloadXray();
        for (const u of toBlock) users.update(u.id, { status: 'blocked' });
      }
    } catch (e) {
      console.error('[IP限制检测] 错误:', e.message);
    }
  }

  checkIpLimits();
  setInterval(checkIpLimits, 60 * 1000);

  /* ── Start HTTPS / HTTP ── */
  const tls = ensureCert();
  const { port } = cfg;

  if (tls) {
    https.createServer(tls, app).listen(port, () => {
      console.log(`\n✅ 管理后台已启动 (HTTPS)`);
      console.log(`🔗 https://${cfg.serverIp}:${port}${BASE}\n`);
    });
  } else {
    http.createServer(app).listen(port, () => {
      console.log(`\n✅ 管理后台已启动 (HTTP)`);
      console.log(`🔗 http://${cfg.serverIp}:${port}${BASE}\n`);
    });
  }
}

if (process.argv.includes('--setup-only')) {
  (async () => {
    await setupWizard();
    process.exit(0);
  })().catch(e => { console.error(e.message); process.exit(1); });
} else {
  main().catch(e => { console.error('启动失败:', e.message); process.exit(1); });
}
