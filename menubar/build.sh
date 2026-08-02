#!/bin/bash
# Build VoizeMonitor.app into ~/Applications and (re)start it.
set -euo pipefail

cd "$(dirname "$0")"
APP="$HOME/Applications/VoizeMonitor.app"

AGENT="gui/$(id -u)/com.moritz.voizemonitor"

# Stop it via launchd if it's managed there, else KeepAlive respawns it mid-build.
if launchctl print "$AGENT" >/dev/null 2>&1; then
  MANAGED=1
  launchctl bootout "$AGENT" 2>/dev/null || true
else
  MANAGED=0
  pkill -f "VoizeMonitor.app/Contents/MacOS" 2>/dev/null || true
fi
sleep 1

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"

swiftc -O VoizeMonitor.swift -o "$APP/Contents/MacOS/VoizeMonitor"

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>VoizeMonitor</string>
  <key>CFBundleIdentifier</key><string>com.moritz.voizemonitor</string>
  <key>CFBundleExecutable</key><string>VoizeMonitor</string>
  <key>CFBundleVersion</key><string>1.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <!-- menu bar only: no dock icon, no app switcher entry -->
  <key>LSUIElement</key><true/>
</dict>
</plist>
PLIST

codesign --force --sign - "$APP" 2>/dev/null || true

echo "built $APP"

if [ "$MANAGED" = "1" ]; then
  launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.moritz.voizemonitor.plist"
else
  open "$APP"
fi
echo "running"
