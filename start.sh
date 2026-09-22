#!/bin/bash
# sgb-generator 服务控制脚本
#
# 用法:
#   ./start.sh            # 默认，等价于 start
#   ./start.sh start      # 启动 server 和 cloudflared
#   ./start.sh stop       # 停止 server 和 cloudflared
#   ./start.sh restart    # 重启两个服务
#   ./start.sh status     # 查看运行状态
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_DIR="$SCRIPT_DIR/.run"
SERVER_PID_FILE="$RUN_DIR/server.pid"
CLOUDFLARED_PID_FILE="$RUN_DIR/cloudflared.pid"
SERVER_LOG="$SCRIPT_DIR/sys.log"
CLOUDFLARED_LOG="$SCRIPT_DIR/cloudflared.log"
CLOUDFLARED_TOKEN="eyJhIjoiMzg2MDc5Y2NkY2FiYTlhMzNiYmUyOTY2M2NjOGNiMDYiLCJ0IjoiZjM0ZDM1MzYtMDY5Ni00MGRlLTkzOGItNTIzNmI0Y2JiYjE0IiwicyI6Ik5EY3pNemhrWWpZdE9HRTVaQzAwTlRkakxXRTRaR1V0Tm1ZMVpEQmpPVFl3TW1ZMiJ9"
CURRENT_UID="$(id -u)"

# 兜底停止用：按命令匹配当前用户的进程，避免误杀系统级 cloudflared（root）
SERVER_MATCH="node src/server.mjs"
CLOUDFLARED_MATCH="cloudflared tunnel run"

[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

mkdir -p "$RUN_DIR"

is_running() {
  local pid="${1:-}"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

read_pid() {
  [ -f "$1" ] && tr -d '[:space:]' < "$1" || true
}

matching_pids() {
  pgrep -u "$CURRENT_UID" -f "$1" 2>/dev/null || true
}

list_pids() {
  echo "$1" | tr '\n' ' ' | sed 's/[[:space:]]*$//'
}

terminate() {
  local pid="$1"
  kill "$pid" 2>/dev/null || return 0
  local _i
  for _i in $(seq 1 25); do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.2
  done
  kill -9 "$pid" 2>/dev/null || true
}

start_server() {
  local pid
  pid="$(read_pid "$SERVER_PID_FILE")"
  if is_running "$pid"; then
    echo "✔ server 已在运行 (PID $pid)"
    return 0
  fi
  local running
  running="$(matching_pids "$SERVER_MATCH")"
  if [ -n "$running" ]; then
    echo "✔ server 已在运行 (PID: $(list_pids "$running"))"
    return 0
  fi
  nvm use system &>/dev/null
  cd "$SCRIPT_DIR" || return 1
  nohup pnpm start > "$SERVER_LOG" 2>&1 &
  echo $! > "$SERVER_PID_FILE"
  echo "▶ server 已启动 (PID $!)  日志: $SERVER_LOG"
}

stop_server() {
  local pid
  pid="$(read_pid "$SERVER_PID_FILE")"
  if is_running "$pid"; then
    # 先结束 pnpm 派生的子进程，再结束 pnpm 本身
    pkill -TERM -P "$pid" 2>/dev/null || true
    terminate "$pid"
  fi
  # 兜底：结束没有记录 PID 的旧进程（仅当前用户）
  local running
  running="$(matching_pids "$SERVER_MATCH")"
  if [ -n "$running" ]; then
    echo "$running" | xargs kill -TERM 2>/dev/null || true
    sleep 1
    running="$(matching_pids "$SERVER_MATCH")"
    [ -n "$running" ] && echo "$running" | xargs kill -9 2>/dev/null || true
  fi
  rm -f "$SERVER_PID_FILE"
  echo "■ server 已停止"
}

start_cloudflared() {
  local pid
  pid="$(read_pid "$CLOUDFLARED_PID_FILE")"
  if is_running "$pid"; then
    echo "✔ cloudflared 已在运行 (PID $pid)"
    return 0
  fi
  local running
  running="$(matching_pids "$CLOUDFLARED_MATCH")"
  if [ -n "$running" ]; then
    echo "✔ cloudflared 已在运行 (PID: $(list_pids "$running"))"
    return 0
  fi
  nohup cloudflared tunnel run --token "$CLOUDFLARED_TOKEN" > "$CLOUDFLARED_LOG" 2>&1 &
  echo $! > "$CLOUDFLARED_PID_FILE"
  echo "▶ cloudflared 已启动 (PID $!)  日志: $CLOUDFLARED_LOG"
}

stop_cloudflared() {
  local pid
  pid="$(read_pid "$CLOUDFLARED_PID_FILE")"
  if is_running "$pid"; then
    terminate "$pid"
  fi
  local running
  running="$(matching_pids "$CLOUDFLARED_MATCH")"
  if [ -n "$running" ]; then
    echo "$running" | xargs kill -TERM 2>/dev/null || true
    sleep 1
    running="$(matching_pids "$CLOUDFLARED_MATCH")"
    [ -n "$running" ] && echo "$running" | xargs kill -9 2>/dev/null || true
  fi
  rm -f "$CLOUDFLARED_PID_FILE"
  echo "■ cloudflared 已停止"
}

status() {
  local pid running
  pid="$(read_pid "$SERVER_PID_FILE")"
  running="$(matching_pids "$SERVER_MATCH")"
  if is_running "$pid" || [ -n "$running" ]; then
    echo "server:      运行中 (PID ${pid:-$(list_pids "$running")})"
  else
    echo "server:      未运行"
  fi

  pid="$(read_pid "$CLOUDFLARED_PID_FILE")"
  running="$(matching_pids "$CLOUDFLARED_MATCH")"
  if is_running "$pid" || [ -n "$running" ]; then
    echo "cloudflared: 运行中 (PID ${pid:-$(list_pids "$running")})"
  else
    echo "cloudflared: 未运行"
  fi
}

case "${1:-start}" in
  start)
    start_server
    start_cloudflared
    ;;
  stop)
    stop_server
    stop_cloudflared
    ;;
  restart)
    stop_server
    stop_cloudflared
    sleep 1
    start_server
    start_cloudflared
    ;;
  status)
    status
    ;;
  *)
    echo "用法: $0 {start|stop|restart|status}"
    exit 1
    ;;
esac
