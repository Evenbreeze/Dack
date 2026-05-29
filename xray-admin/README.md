# Xray 管理后台

基于 Node.js 的 Xray VLESS 节点管理面板，支持：

- 📡 **实时在线设备查看**（解析 Xray access.log）
- 📝 **用户备注 / 内部笔记**
- ✅ **创建即激活**（UUID 自动写入 Xray config.json）
- 🚫 **拉黑 / 解黑用户**（立即重载 Xray，断开连接）
- 📦 **流量限额**（GB，超额自动封禁，真实统计来自 Xray Stats API）
- ⏰ **使用期限**（1天/3天/1个月/...永久/自定义，到期自动封禁）
- 📱 **设备数限制**（同时在线 IP 数超限自动封禁）
- 🔐 **HTTPS 自签名证书**（启动自动生成）
- 🔗 **一键生成 VLESS 链接**（自动读取 Xray 配置，支持 TCP/WS/gRPC/TLS/Reality）

---

## 一键安装（Ubuntu 20.04 / 22.04 / 24.04）

> 将下方命令中 `YOUR_GITHUB_USERNAME` 替换为你的 GitHub 用户名后运行

```bash
bash <(curl -s https://raw.githubusercontent.com/Evenbreeze/Dack/main/xray-admin/install.sh)
```

安装过程会引导你设置：
1. 管理员用户名 & 密码
2. 后台监听端口（默认 39271）
3. 访问路径（默认随机生成）
4. 服务器公网 IP

---

## 手动安装

```bash
# 1. 安装 Node.js 20+
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs

# 2. 下载项目
git clone https://github.com/Evenbreeze/Dack.git /tmp/Dack && cp -r /tmp/Dack/xray-admin /opt/xray-admin
cd /opt/xray-admin

# 3. 安装依赖
npm install --production

# 4. 首次运行（按提示配置，完成后 Ctrl+C）
node server.js --setup-only

# 5. 创建 systemd 服务
cat > /etc/systemd/system/xray-admin.service <<EOF
[Unit]
Description=Xray Admin Panel
After=network.target xray.service

[Service]
Type=simple
User=root
WorkingDirectory=/opt/xray-admin
ExecStart=/usr/bin/node /opt/xray-admin/server.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now xray-admin
```

---

## 目录结构

```
xray-admin/
├── server.js          # 主服务（Express HTTPS）
├── db.js              # SQLite 数据库层
├── xray.js            # Xray 配置读写 & 日志/Stats API
├── package.json
├── public/
│   └── index.html     # 管理界面（单页应用）
└── install.sh         # 一键安装脚本
```

---

## 前提条件

- Xray 已安装并以 `systemctl` 管理（`systemctl status xray`）
- Xray 配置路径：`/usr/local/etc/xray/config.json`
- Xray 日志路径：`/var/log/xray/access.log`（需开启 access log，见下方）
- 运行身份具有读写 Xray 配置的权限（root 或对应用户）

### 开启 Xray access log

在 `/usr/local/etc/xray/config.json` 的 `log` 节点中添加：

```json
"log": {
  "access": "/var/log/xray/access.log",
  "loglevel": "warning"
}
```

然后 `systemctl restart xray`

---

## 常用命令

```bash
systemctl status xray-admin      # 查看运行状态
journalctl -u xray-admin -f      # 实时查看日志
systemctl restart xray-admin     # 重启服务
```

---

## 流量统计说明

面板启动时会自动检测并启用 Xray 的 Stats API（在 `config.json` 中添加必要配置）。
每 5 分钟查询一次各用户的实际上传 + 下载流量，累计写入数据库。
超过设定配额后自动从 Xray 配置中移除该用户 UUID，立即断线。
管理员可在面板中手动重置某用户的流量计数。
