#!/bin/bash
set -euo pipefail

UUID="sysmon@dopppo"
EXT_DIR="$HOME/.local/share/gnome-shell/extensions/$UUID"

echo "Uninstalling SysMon GNOME extension..."
python3 - <<PY
import ast, subprocess
uuid = ${UUID@Q}
current = subprocess.check_output([
    'gsettings', 'get', 'org.gnome.shell', 'enabled-extensions'
], text=True).strip()
if current.startswith('@as '):
    current = current[4:]
items = [item for item in ast.literal_eval(current) if item != uuid]
subprocess.check_call([
    'gsettings', 'set', 'org.gnome.shell', 'enabled-extensions', str(items)
])
PY
rm -rf "$EXT_DIR"
echo "Removed: $EXT_DIR"
echo "Restart GNOME Shell (Alt+F2, then r) or log out/in to unload it."
