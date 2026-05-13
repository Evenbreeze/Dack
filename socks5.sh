#!/usr/bin/env bash
# Debian 12+：编译 3proxy，多公网 IP SOCKS5（连哪个 IP+端口，就从哪个 IP 出）。
#
# 【两种方式】① 无 endpoints.conf：运行脚本 → 默认多行粘贴（回车即可）；输入 n 则逐条 → 账号口令。
#              批量粘贴：每行 IPv4:端口（中间不要空行）；贴完后按一次回车结束。
#            ② 同目录放好 endpoints.conf：每行 公网IP:端口 ，不要写密码；运行脚本后只问账号口令。
#
# 【运行】cd 到脚本所在目录后： chmod +x install.sh && sudo bash install.sh
#        socks5.sh 与 install.sh 相同，可推到 GitHub 给 curl 一键装。
#        （若用 bash <(curl ...) 等方式运行，当前目录会用来放 endpoints.conf）
#
# 【可选】sudo -E env SOCKS_USER='x' SOCKS_PASS='y' bash install.sh
#        粘贴仍异常时可在命令前设置 SOCKS_PASS（或改用 Windows 终端 / MobaXterm 等）。
#        需要恢复「输入不显示」：SOCKS_PASS_HIDDEN=1 bash install.sh
#        ENDPOINTS_FILE=/path/to/列表.conf bash install.sh
#
# 【上传仓库前】git status 里不要出现 endpoints.conf；不放心就把仓库设 Private。
#
# 前置：ip -4 addr 已能见到列表里全部 IP；云防火墙放行所列 TCP 端口及 SSH。

set -euo pipefail

# curl|bash 时 stdin 是脚本内容，交互必须从终端读
read_tty() {
  if [[ -r /dev/tty ]]; then
    read -r "$@" </dev/tty
  else
    read -r "$@"
  fi
}

# 带 readline（-e）：多数终端里右键/Ctrl+Shift+V 粘贴更可靠；用户名、明文口令等用它
read_tty_edit() {
  if [[ -r /dev/tty ]]; then
    read -e -r "$@" </dev/tty
  else
    read -e -r "$@"
  fi
}

# 校验 endpoints 一行：仅支持 IPv4:端口（端口 1–65535）
_valid_ep_line() {
  local ip port
  port="${1##*:}"
  ip="${1%%:*}"
  [[ -n "$ip" && -n "$port" && "$ip" != "$1" ]] || return 1
  [[ "$port" =~ ^[0-9]+$ ]] || return 1
  [[ "$port" -ge 1 && "$port" -le 65535 ]] || return 1
  [[ "$ip" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || return 1
  return 0
}

if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  echo "请用 root: sudo bash $0" >&2
  exit 1
fi

# 脚本从管道/stdin 运行时路径常为 /dev/fd/*、/dev/stdin、- ，无法用「脚本所在目录」
_script_src="${BASH_SOURCE[0]}"
if [[ "$_script_src" == /dev/fd/* || "$_script_src" == /proc/self/fd/* || "$_script_src" == /dev/stdin || "$_script_src" == "-" ]]; then
  SCRIPT_DIR="$(pwd -P)"
else
  SCRIPT_DIR="$(cd "$(dirname "$_script_src")" && pwd -P)"
fi
# bash < install.sh 时 dirname 可能是 /dev
if [[ "$(dirname "$_script_src")" == /dev ]]; then
  SCRIPT_DIR="$(pwd -P)"
fi
if [[ "$SCRIPT_DIR" == /dev/fd || "$SCRIPT_DIR" == /dev/fd/* ]]; then
  SCRIPT_DIR="$(pwd -P)"
fi
unset _script_src

INTERACTIVE_TMP=""
LOCAL_EP="$SCRIPT_DIR/endpoints.conf"

if [[ -n "${ENDPOINTS_FILE:-}" ]]; then
  ENDPOINTS="$ENDPOINTS_FILE"
  if [[ ! -f "$ENDPOINTS" ]]; then
    echo "未找到 ENDPOINTS_FILE: $ENDPOINTS" >&2
    exit 1
  fi
elif [[ -f "$LOCAL_EP" ]]; then
  ENDPOINTS="$LOCAL_EP"
else
  echo ""
  echo "未找到同目录下的 endpoints.conf 。"
  echo "格式：每行 IPv4:端口（中间英文冒号，端口 1–65535）"
  read_tty_edit -p "多行粘贴请直接回车；逐条输入请输入 n 回车: " bulk
  INTERACTIVE_TMP=$(mktemp)
  n=0
  _trim() {
    local s="$1"
    s="${s#"${s%%[![:space:]]*}"}"
    s="${s%"${s##*[![:space:]]}"}"
    s="${s//$'\r'/}"
    printf '%s' "$s"
  }

  bulk_trim="$(_trim "${bulk:-}")"
  if [[ "$bulk_trim" =~ ^[nN]$ ]]; then
    echo "逐条输入；**仅回车（空行）**表示结束。"
    echo ""
    while true; do
      read_tty_edit -p "[$((n + 1))] 公网IP:端口（空行结束）: " line || true
      line="$(_trim "$line")"
      [[ -z "$line" ]] && break
      if ! _valid_ep_line "$line"; then
        echo "  → 格式须为 IPv4:端口（端口 1–65535），例如 1.2.3.4:8443 ，请重输。" >&2
        continue
      fi
      echo "$line" >>"$INTERACTIVE_TMP"
      n=$((n + 1))
    done
  else
    # 有人把第一行 IPv4:端口 粘在「回车/n」提示同一行，别丢掉（须过校验）
    if [[ -n "$bulk_trim" && "$bulk_trim" != \#* ]] && _valid_ep_line "$bulk_trim"; then
      echo "$bulk_trim" >>"$INTERACTIVE_TMP"
      n=$((n + 1))
    fi
    echo ""
    echo "请粘贴：每行 IPv4:端口；条目之间不要空行。"
    echo "以 # 开头的行会忽略。贴完后按**一次回车**结束。"
    echo ""
    while IFS= read -r line || [[ -n "$line" ]]; do
      line="$(_trim "$line")"
      if [[ -z "$line" ]]; then
        [[ "$n" -gt 0 ]] && break
        continue
      fi
      [[ "$line" == \#* ]] && continue
      if ! _valid_ep_line "$line"; then
        echo "  → 跳过无效行（须 IPv4:端口）: $line" >&2
        continue
      fi
      echo "$line" >>"$INTERACTIVE_TMP"
      n=$((n + 1))
    done </dev/tty
  fi

  if [[ "$n" -eq 0 ]]; then
    echo "至少输入一组 IP:端口" >&2
    rm -f "$INTERACTIVE_TMP"
    exit 1
  fi
  ENDPOINTS="$INTERACTIVE_TMP"
  _itmp_rm() { [[ -n "${INTERACTIVE_TMP:-}" && -f "${INTERACTIVE_TMP:-}" ]] && rm -f -- "$INTERACTIVE_TMP"; }
  trap '_itmp_rm' EXIT
  read_tty_edit -p "把列表保存成 endpoints.conf 方便下次？[y/N] " save_ep
  if [[ "${save_ep:-}" =~ ^[yY] ]]; then
    cp "$INTERACTIVE_TMP" "$LOCAL_EP"
    chmod 600 "$LOCAL_EP"
    echo "已保存: $LOCAL_EP（勿上传 Git）"
  fi
  echo ""
fi

# ---------- 账号口令：按提示输入（或用环境变量 SOCKS_USER / SOCKS_PASS）----------
if [[ -z "${SOCKS_USER:-}" ]]; then
  read_tty_edit -p "SOCKS5 用户名: " SOCKS_USER
fi
if [[ -z "${SOCKS_USER// /}" ]]; then
  echo "用户名不能为空" >&2
  exit 1
fi
if [[ "$SOCKS_USER" == *:* || "$SOCKS_USER" == *' '* || "$SOCKS_USER" == *$'\t'* ]]; then
  echo "用户名不能含空格、制表符或英文冒号（与 3proxy 配置格式冲突）" >&2
  exit 1
fi

if [[ -z "${SOCKS_PASS:-}" ]]; then
  if [[ -n "${SOCKS_PASS_HIDDEN:-}" ]]; then
    read_tty_edit -s -p "SOCKS5 密码: " SOCKS_PASS
    echo
    read_tty_edit -s -p "再输入一次密码: " SOCKS_PASS2
    echo
  else
    echo "口令输入（已启用 readline，一般可用 Ctrl+Shift+V / 右键粘贴；若无反应请用环境变量 SOCKS_PASS）："
    echo "若更介意屏幕留痕，请 Ctrl+C 后在同一条安装命令前加上：env SOCKS_PASS='...' （勿把密码写进脚本文件再上传）。"
    echo ""
    read_tty_edit -p "SOCKS5 密码: " SOCKS_PASS
    read_tty_edit -p "再输入一次密码: " SOCKS_PASS2
  fi
  if [[ "$SOCKS_PASS" != "$SOCKS_PASS2" ]]; then
    echo "两次密码不一致" >&2
    exit 1
  fi
fi
if [[ -z "$SOCKS_PASS" ]]; then
  echo "密码不能为空" >&2
  exit 1
fi
if [[ "$SOCKS_PASS" == *:* ]]; then
  echo "密码不能含英文冒号 :（3proxy users 行会用冒号分段）" >&2
  exit 1
fi

EP_COUNT=0
FIRST_EP_LINE=""
while IFS= read -r _line || [[ -n "$_line" ]]; do
  _line="${_line#"${_line%%[![:space:]]*}"}"
  _line="${_line%"${_line##*[![:space:]]}"}"
  [[ -z "$_line" || "$_line" == \#* ]] && continue
  if ! _valid_ep_line "$_line"; then
    echo "无效行（须 IPv4:端口，端口 1–65535）: $_line" >&2
    exit 1
  fi
  EP_COUNT=$((EP_COUNT + 1))
  [[ -z "${FIRST_EP_LINE:-}" ]] && FIRST_EP_LINE="$_line"
done <"$ENDPOINTS"

if [[ "$EP_COUNT" -eq 0 ]]; then
  echo "endpoints.conf 无有效 IP:端口 行" >&2
  exit 1
fi

FIRST_EP="$FIRST_EP_LINE"
CURL_IP="${FIRST_EP%%:*}"
CURL_PORT="${FIRST_EP##*:}"

if ! command -v apt-get >/dev/null 2>&1; then
  echo "未找到 apt-get，本脚本仅适用于 Debian/Ubuntu 系。" >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y build-essential wget

_3VER=0.9.6
cd /tmp
rm -rf "3proxy-${_3VER}"*
wget -O "3proxy-${_3VER}.tar.gz" "https://github.com/3proxy/3proxy/archive/refs/tags/${_3VER}.tar.gz"
tar xzf "3proxy-${_3VER}.tar.gz"
cd "3proxy-${_3VER}"
make -f Makefile.Linux
install -m 755 bin/3proxy /usr/local/bin/3proxy

install -d -m 755 /etc/3proxy
umask 077
# users: CL = 明文；须与 allow 同名。口令含 $、` 等时不能用未引用 heredoc 拼进配置，故用 printf 写入。
{
  cat <<'PART'
daemon
maxconn 500
nserver 8.8.8.8
nscache 65536
pidfile /var/run/3proxy.pid

PART
  printf 'users %s:CL:%s\n\nauth strong\nallow %s\n\n' "$SOCKS_USER" "$SOCKS_PASS" "$SOCKS_USER"
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line%"${line##*[![:space:]]}"}"
    [[ -z "$line" || "$line" == \#* ]] && continue
    ip="${line%%:*}"
    port="${line##*:}"
    printf 'socks -p%s -i%s -e%s\n' "$port" "$ip" "$ip"
  done <"$ENDPOINTS"
} >/etc/3proxy/3proxy.cfg
chmod 600 /etc/3proxy/3proxy.cfg
chown root:root /etc/3proxy/3proxy.cfg
umask 022

killall danted 2>/dev/null || true

cat >/etc/systemd/system/3proxy-local.service <<'UNIT'
[Unit]
Description=3proxy (local /usr/local/bin)
After=network-online.target
Wants=network-online.target

[Service]
Type=forking
PIDFile=/var/run/3proxy.pid
ExecStart=/usr/local/bin/3proxy /etc/3proxy/3proxy.cfg
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now 3proxy-local
sleep 2

echo
echo "======== 自检 ========"
systemctl status 3proxy-local --no-pager || true
echo -n "3proxy 监听行数(应为 $EP_COUNT): "
ss -tlnp 2>/dev/null | grep -c 3proxy || echo "0"
echo "====================="

CLIENT_LIST=/root/3proxy-socks-clients.txt
umask 077
: >"$CLIENT_LIST"
while IFS= read -r line || [[ -n "$line" ]]; do
  line="${line#"${line%%[![:space:]]*}"}"
  line="${line%"${line##*[![:space:]]}"}"
  [[ -z "$line" || "$line" == \#* ]] && continue
  printf '%s:%s:%s\n' "$line" "$SOCKS_USER" "$SOCKS_PASS" >>"$CLIENT_LIST"
done <"$ENDPOINTS"
chmod 600 "$CLIENT_LIST"

echo
echo "客户端列表（含口令）: $CLIENT_LIST"
echo "本机测 SOCKS（勿用 127.0.0.1；首行为 endpoints.conf 第一组地址）："
echo "  curl -x socks5h://${SOCKS_USER}:'<密码>'@${CURL_IP}:${CURL_PORT} --connect-timeout 10 https://ipinfo.io/ip"
echo
echo "改配置后: systemctl restart 3proxy-local"
