#!/bin/sh
set -e

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
PID_FILE="$ROOT_DIR/.server.pid"
WATCHER_PID_FILE="$ROOT_DIR/.watcher.pid"
LOG_DIR="$ROOT_DIR/logs"
LOG_FILE="$LOG_DIR/server.log"

PORT="3000"

mkdir -p "$LOG_DIR"

is_running() {
  if [ -f "$PID_FILE" ]; then
    PID="$(cat "$PID_FILE" || true)"
    if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
      return 0
    fi
  fi
  return 1
}

watcher_running() {
  if [ -f "$WATCHER_PID_FILE" ]; then
    PID="$(cat "$WATCHER_PID_FILE" || true)"
    if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
      return 0
    fi
  fi
  return 1
}

start_watcher() {
  if watcher_running; then
    return 0
  fi
  cd "$ROOT_DIR"
  nohup node "$ROOT_DIR/scripts/watch-server.js" > /dev/null 2>&1 &
  echo $! > "$WATCHER_PID_FILE"
}

stop_watcher() {
  if ! watcher_running; then
    return 0
  fi
  PID="$(cat "$WATCHER_PID_FILE")"
  kill "$PID" 2>/dev/null || true
  rm -f "$WATCHER_PID_FILE"
}

start() {
  if is_running; then
    echo "already running (pid=$(cat "$PID_FILE"))"
    return 0
  fi
  cd "$ROOT_DIR"
  nohup env PORT="$PORT" npm start > "$LOG_FILE" 2>&1 &
  echo $! > "$PID_FILE"
  start_watcher
  echo "started (pid=$(cat "$PID_FILE"), port=$PORT)"
}

stop() {
  if ! is_running; then
    echo "not running"
    return 0
  fi
  PID="$(cat "$PID_FILE")"
  pkill -P "$PID" 2>/dev/null || true
  kill "$PID" 2>/dev/null || true
  rm -f "$PID_FILE"
  stop_watcher
  echo "stopped"
}

status() {
  if is_running; then
    echo "running (pid=$(cat "$PID_FILE"), port=$PORT)"
  else
    echo "not running"
  fi
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  restart)
    stop
    start
    ;;
  status) status ;;
  *)
    echo "usage: $0 {start|stop|restart|status}"
    exit 1
    ;;
esac
