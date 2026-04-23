#!/usr/bin/env bash
# Installer for claude-settings-manager
# Adds a `claude-settings` function to ~/.zshrc that runs the dashboard from anywhere.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENTRY="$SCRIPT_DIR/claude-settings.js"
ZSHRC="$HOME/.zshrc"
MARKER_BEGIN="# >>> claude-settings-manager >>>"
MARKER_END="# <<< claude-settings-manager <<<"

if [[ ! -f "$ENTRY" ]]; then
  echo "error: $ENTRY not found" >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "error: node is required but not found in PATH" >&2
  exit 1
fi

chmod +x "$ENTRY"

# Strip any previous block we installed so re-running stays idempotent.
if [[ -f "$ZSHRC" ]] && grep -q "$MARKER_BEGIN" "$ZSHRC"; then
  awk -v b="$MARKER_BEGIN" -v e="$MARKER_END" '
    $0 ~ b {skip=1; next}
    skip && $0 ~ e {skip=0; next}
    !skip {print}
  ' "$ZSHRC" > "$ZSHRC.tmp" && mv "$ZSHRC.tmp" "$ZSHRC"
  echo "• removed previous claude-settings-manager block from $ZSHRC"
fi

cat >> "$ZSHRC" <<EOF
$MARKER_BEGIN
# Launches the Claude Settings dashboard (web UI) from anywhere.
# Use: \`claude-settings\` to open, \`claude-settings --port=9999\` to change port.
claude-settings() {
  node "$ENTRY" "\$@"
}
$MARKER_END
EOF

echo "✓ installed claude-settings shell function into $ZSHRC"
echo
echo "Activate in this shell:"
echo "  source $ZSHRC"
echo
echo "Then run from any directory:"
echo "  claude-settings            # opens http://127.0.0.1:7823"
echo "  claude-settings --no-open  # don't auto-open browser"
echo "  claude-settings --port=9000"
echo
echo "Custom scan roots (colon-separated):"
echo "  CLAUDE_SETTINGS_ROOTS=\"\$HOME/projects:\$HOME/work\" claude-settings"
