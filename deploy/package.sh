#!/bin/bash
# Package claw binary + data for deployment to a new machine.
# Usage: ./deploy/package.sh [output-dir]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$SCRIPT_DIR/.."
PHOTON_DIR="$HOME/.photon"
OUTPUT="${1:-$SCRIPT_DIR/dist}"
ARCHIVE="$OUTPUT/claw-deploy.tar.gz"

echo "=== Claw Deployment Packager ==="
echo ""

# Check binary exists
BINARY="$PROJECT_DIR/claw-bin"
if [ ! -f "$BINARY" ]; then
  echo "Error: claw-bin not found. Run: photon build claw.photon.ts -o claw-bin"
  exit 1
fi

# Clean previous output
rm -rf "$OUTPUT/claw-deploy"
mkdir -p "$OUTPUT/claw-deploy"

# Helper: copy first existing dir from a list of candidates
copy_first() {
  local dest="$1"; shift
  for src in "$@"; do
    if [ -d "$src" ] && [ "$(ls -A "$src" 2>/dev/null)" ]; then
      mkdir -p "$dest"
      cp -r "$src/." "$dest/"
      echo "  ✓ Found at $src"
      return 0
    fi
  done
  echo "  (not found)"
  return 1
}

# 1. Binary
echo "[1/6] Copying binary..."
cp "$BINARY" "$OUTPUT/claw-deploy/claw-bin"
chmod +x "$OUTPUT/claw-deploy/claw-bin"

# 2. Claw data (registry, sessions, agent memory)
echo "[2/6] Copying claw data..."
copy_first "$OUTPUT/claw-deploy/data/claw" \
  "$PHOTON_DIR/data/claw" || true

# 3. Telegram auth (token + offset)
# Binary expects: ~/.photon/telegram/auth/
# Dev machine may have it at: local source, ~/.photon/telegram/, or legacy ~/.photon/local/telegram/
echo "[3/6] Copying Telegram auth..."
copy_first "$OUTPUT/claw-deploy/photon/telegram/auth" \
  "$PROJECT_DIR/telegram/auth" \
  "$PHOTON_DIR/telegram/auth" \
  "$PHOTON_DIR/local/telegram/auth" || true

# 4. WhatsApp auth (may need re-pairing on new machine)
echo "[4/6] Copying WhatsApp auth..."
if copy_first "$OUTPUT/claw-deploy/photon/whatsapp/auth" \
  "$PROJECT_DIR/whatsapp/auth" \
  "$PHOTON_DIR/whatsapp/auth" \
  "$PHOTON_DIR/local/whatsapp/auth"; then
  echo "  ⚠ WhatsApp session may need re-pairing on new device"
fi

# 5. Courier inbox
echo "[5/6] Copying Courier inbox..."
copy_first "$OUTPUT/claw-deploy/photon/courier/inbox" \
  "$PROJECT_DIR/courier/inbox" \
  "$PHOTON_DIR/courier/inbox" \
  "$PHOTON_DIR/local/courier/inbox" || true

# 6. State files + Claude runner conversations
echo "[6/6] Copying state & settings..."
for photon in claw chat whatsapp telegram courier agent-router agent-runner; do
  if [ -f "$PHOTON_DIR/state/$photon/default.json" ]; then
    mkdir -p "$OUTPUT/claw-deploy/state/$photon"
    cp "$PHOTON_DIR/state/$photon/"*.json "$OUTPUT/claw-deploy/state/$photon/" 2>/dev/null || true
  fi
done
if [ -d "$PHOTON_DIR/data/claude-runner" ]; then
  cp -r "$PHOTON_DIR/data/claude-runner" "$OUTPUT/claw-deploy/data/claude-runner"
  echo "  ✓ Claude runner conversations"
fi

# Create install script
cat > "$OUTPUT/claw-deploy/install.sh" << 'INSTALL_EOF'
#!/bin/bash
# Install claw on a new machine.
# Usage: ./install.sh [install-dir]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
INSTALL_DIR="${1:-$HOME/.claw}"
PHOTON_DIR="$HOME/.photon"

echo "=== Installing Claw ==="
echo "  Install dir: $INSTALL_DIR"
echo "  Data dir:    $PHOTON_DIR"
echo ""

# Install binary
mkdir -p "$INSTALL_DIR"
cp "$SCRIPT_DIR/claw-bin" "$INSTALL_DIR/claw"
chmod +x "$INSTALL_DIR/claw"

# Restore claw data (registry, agent memory)
if [ -d "$SCRIPT_DIR/data/claw" ]; then
  mkdir -p "$PHOTON_DIR/data"
  cp -r "$SCRIPT_DIR/data/claw" "$PHOTON_DIR/data/claw"
  echo "  ✓ Restored claw registry + agent memory"
fi

# Restore photon storage — binary resolves storage() to ~/.photon/{photonName}/
if [ -d "$SCRIPT_DIR/photon" ]; then
  for photon_dir in "$SCRIPT_DIR/photon/"*/; do
    photon=$(basename "$photon_dir")
    mkdir -p "$PHOTON_DIR/$photon"
    cp -r "$photon_dir." "$PHOTON_DIR/$photon/"
    echo "  ✓ Restored $photon storage"
  done
fi

# Restore Claude runner conversations
if [ -d "$SCRIPT_DIR/data/claude-runner" ]; then
  mkdir -p "$PHOTON_DIR/data"
  cp -r "$SCRIPT_DIR/data/claude-runner" "$PHOTON_DIR/data/claude-runner"
  echo "  ✓ Restored Claude runner state"
fi

# Restore state files
if [ -d "$SCRIPT_DIR/state" ]; then
  for photon_dir in "$SCRIPT_DIR/state/"*/; do
    photon=$(basename "$photon_dir")
    mkdir -p "$PHOTON_DIR/state/$photon"
    cp "$photon_dir"*.json "$PHOTON_DIR/state/$photon/" 2>/dev/null || true
  done
  echo "  ✓ Restored instance state"
fi

# Setup symlinks for bundled photons
cd "$INSTALL_DIR" && ./claw setup 2>/dev/null || true

echo ""
echo "=== Installation Complete ==="
echo ""
echo "Start claw:"
echo "  $INSTALL_DIR/claw sse 3000"
echo ""
echo "Or add to PATH:"
echo "  export PATH=\"$INSTALL_DIR:\$PATH\""
INSTALL_EOF
chmod +x "$OUTPUT/claw-deploy/install.sh"

# Create archive
echo ""
echo "Creating archive..."
cd "$OUTPUT" && tar -czf claw-deploy.tar.gz claw-deploy/

SIZE=$(du -sh "$ARCHIVE" | cut -f1)
echo ""
echo "=== Package Ready ==="
echo "  Archive: $ARCHIVE ($SIZE)"
echo "  Contents:"
du -sh "$OUTPUT/claw-deploy/"*/ 2>/dev/null | sed 's/^/    /'
echo ""
echo "Deploy: scp $ARCHIVE target: && ssh target 'tar xzf claw-deploy.tar.gz && cd claw-deploy && ./install.sh'"
