# Shared settings for the launchd scripts (sourced, not executed).
LABEL="com.prits3.gold-outlook.worker"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOGDIR="$HOME/Library/Logs/gold-outlook"
DOMAIN="gui/$(id -u)"
PY="$REPO/backend/.venv/bin/python"
