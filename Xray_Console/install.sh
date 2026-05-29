#!/usr/bin/env bash
# ══════════════════════════════════════════════
#  Xray 管理后台 — 一键安装脚本
#  支持 Ubuntu 20.04 / 22.04 / 24.04
# ══════════════════════════════════════════════
set -e

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; NC='\033[0m'; BOLD='\033[1m'

info()  { echo -e "${GREEN}[✓]${NC} $*"; }
warn()  { echo -e "${YELLOW}[!]${NC} $*"; }
error() { echo -e "${RED}[✗]${NC} $*"; exit 1; }
step()  { echo -e "\n${BLUE}${BOLD}▶ $*${NC}"; }

# ─── 权限检查 ─────────────────────────────────
[[ $EUID -ne 0 ]] && error "请使用 root 用户运行此脚本（sudo bash install.sh）"

INSTALL_DIR="/opt/xray-admin"
SERVICE_FILE="/etc/systemd/system/xray-admin.service"

# ─── 获取仓库地址 ─────────────────────────────
REPO_URL="${XRAY_ADMIN_REPO:-https://github.com/YOUR_GITHUB_USERNAME/xray-admin}"
RAW_URL="${REPO_URL/github.com/raw.githubusercontent.com}/main"

echo ""
echo -e "${BOLD}══════════════════════════════════════════${NC}"
echo -e "${BOLD}     Xray 管理后台 — 安装程序             ${NC}"
echo -e "${BOLD}══════════════════════════════════════════${NC}"
echo ""

# ─── 安装 Node.js ─────────────────────────────
step "检查 Node.js"
if ! command -v node &>/dev/null || [[ $(node -v | cut -d. -f1 | tr -d 'v') -lt 18 ]]; then
  info "安装 Node.js 20.x..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - &>/dev/null
  apt-get install -y nodejs &>/dev/null
  info "Node.js $(node -v) 安装完成"
else
  info "Node.js $(node -v) 已存在"
fi

# ─── 安装 git / openssl / curl ────────────────
step "检查系统依赖"
PKGS=()
command -v git    &>/dev/null || PKGS+=(git)
command -v openssl &>/dev/null || PKGS+=(openssl)
command -v curl   &>/dev/null || PKGS+=(curl)
if [[ ${#PKGS[@]} -gt 0 ]]; then
  apt-get install -y "${PKGS[@]}" &>/dev/null
  info "已安装: ${PKGS[*]}"
else
  info "系统依赖已就绪"
fi

# ─── 下载 / 更新项目文件 ──────────────────────
step "下载项目文件"
mkdir -p "$INSTALL_DIR/public"

FILES=(
  "package.json"
  "server.js"
  "db.js"
  "xray.js"
  "public/index.html"
)

for f in "${FILES[@]}"; do
  curl -fsSL "${RAW_URL}/${f}" -o "${INSTALL_DIR}/${f}" || error "下载 ${f} 失败，请检查网络或仓库地址"
done
info "项目文件下载完成"

# ─── 安装 npm 依赖 ────────────────────────────
step "安装 npm 依赖"
cd "$INSTALL_DIR"
npm install --production --silent
info "依赖安装完成"

# ─── 首次配置向导 ─────────────────────────────
if [[ ! -f "${INSTALL_DIR}/admin.config.json" ]]; then
  step "首次配置"
  warn "接下来请根据提示完成初始化设置..."
  echo ""
  node "${INSTALL_DIR}/server.js" --setup-only || true
fi

# If config still missing (user cancelled wizard), abort before setting up service
if [[ ! -f "${INSTALL_DIR}/admin.config.json" ]]; then
  echo ""
  warn "配置文件未创建（向导未完成）。"
  warn "请重新运行安装脚本完成设置：bash <(curl -s ${RAW_URL}/install.sh)"
  exit 1
fi

# ─── 创建 systemd 服务 ────────────────────────
step "配置开机自启"
cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=Xray Admin Panel
After=network.target xray.service

[Service]
Type=simple
User=root
WorkingDirectory=${INSTALL_DIR}
ExecStart=/usr/bin/node ${INSTALL_DIR}/server.js
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable xray-admin &>/dev/null
systemctl restart xray-admin

# ─── 完成 ────────────────────────────────────
sleep 2
if systemctl is-active --quiet xray-admin; then
  CFG_FILE="${INSTALL_DIR}/admin.config.json"
  if [[ -f "$CFG_FILE" ]]; then
    IP=$(python3 -c "import json;c=json.load(open('$CFG_FILE'));print(c.get('serverIp','?'))" 2>/dev/null || echo "?")
    PORT=$(python3 -c "import json;c=json.load(open('$CFG_FILE'));print(c.get('port','?'))" 2>/dev/null || echo "?")
    PATH_PART=$(python3 -c "import json;c=json.load(open('$CFG_FILE'));print(c.get('adminPath',''))" 2>/dev/null || echo "")
  fi
  echo ""
  echo -e "${GREEN}${BOLD}══════════════════════════════════════════${NC}"
  echo -e "${GREEN}${BOLD}  ✅ 安装完成！                            ${NC}"
  echo -e "${GREEN}${BOLD}══════════════════════════════════════════${NC}"
  echo ""
  echo -e "  🔗 访问地址: ${BOLD}https://${IP}:${PORT}${PATH_PART}${NC}"
  echo ""
  echo -e "  ${YELLOW}⚠️  浏览器提示证书风险时，点击「继续访问」即可${NC}"
  echo ""
  echo -e "  常用命令:"
  echo -e "    查看状态: ${BOLD}systemctl status xray-admin${NC}"
  echo -e "    查看日志: ${BOLD}journalctl -u xray-admin -f${NC}"
  echo -e "    重启服务: ${BOLD}systemctl restart xray-admin${NC}"
  echo -e "    更新面板: ${BOLD}bash <(curl -s ${RAW_URL}/install.sh)${NC}"
  echo ""
else
  warn "服务启动异常，请查看日志："
  echo "  journalctl -u xray-admin -n 30"
fi
