#!/data/data/com.termux/files/usr/bin/bash
set -e
cd "$(dirname "$0")"
termux-wake-lock >/dev/null 2>&1 || true
exec python -m uvicorn server:app --host 127.0.0.1 --port 8765
