#!/bin/bash
set -euo pipefail

UUID="sysmon@dopppo"
EXT_DIR="$HOME/.local/share/gnome-shell/extensions/$UUID"
SRC_DIR="$(pwd)/gnome-extension"

if [[ ! -d "$SRC_DIR" ]]; then
  echo "Missing $SRC_DIR"
  exit 1
fi

echo "Installing SysMon GNOME extension..."
mkdir -p "$EXT_DIR"
cp "$SRC_DIR/metadata.json" "$EXT_DIR/metadata.json"
cp "$SRC_DIR/extension.js" "$EXT_DIR/extension.js"

# Stop any old AppIndicator-based sysmon if it still exists.
pkill -f sysmon.py 2>/dev/null || true
rm -f "$HOME/.config/autostart/sysmon.desktop"

python3 - <<PY
import ast, subprocess
uuid = ${UUID@Q}
current = subprocess.check_output([
    'gsettings', 'get', 'org.gnome.shell', 'enabled-extensions'
], text=True).strip()
if current.startswith('@as '):
    current = current[4:]
items = ast.literal_eval(current)
if uuid not in items:
    items.append(uuid)
    subprocess.check_call([
        'gsettings', 'set', 'org.gnome.shell', 'enabled-extensions', str(items)
    ])
PY

echo "Installed to: $EXT_DIR"
echo "Queued for enable: $UUID"
echo "Restart GNOME Shell now (Alt+F2, then r) or log out/in to load it."
