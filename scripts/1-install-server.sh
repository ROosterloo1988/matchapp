#!/bin/bash
APP_NAME="dart-proxy"
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "📦 Start: Systeem updaten en afhankelijkheden installeren..."
sudo apt update && sudo apt upgrade -y
sudo apt install -y curl ca-certificates

# De Node.js uit apt is op veel Ubuntu-versies te oud (bijv. v12 op 22.04) en
# laat server.js direct crashen. Installeer daarom Node 20 LTS via NodeSource.
NODE_MAJOR=$(node -v 2>/dev/null | sed 's/^v\([0-9]*\).*/\1/')
if [ -z "$NODE_MAJOR" ] || [ "$NODE_MAJOR" -lt 18 ]; then
    echo "🟢 Node.js 20 installeren..."
    sudo apt remove -y nodejs npm >/dev/null 2>&1
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt install -y nodejs
fi
echo "Node.js versie: $(node -v)"

echo "🔄 PM2 (Process Manager) installeren..."
sudo npm install -g pm2

echo "⚙️ PM2 instellen om automatisch te starten bij server reboot..."
# 'pm2 startup' zelf print alleen een commando; dit voert het direct uit
sudo env PATH="$PATH:$(dirname "$(command -v node)")" "$(command -v pm2)" startup systemd -u "$USER" --hp "$HOME"

if [ -f "$APP_DIR/server/server.js" ]; then
    echo "📦 App-afhankelijkheden installeren en app starten..."
    (cd "$APP_DIR/server" && npm install --omit=dev)
    pm2 describe "$APP_NAME" >/dev/null 2>&1 || pm2 start "$APP_DIR/server/server.js" --name "$APP_NAME" --cwd "$APP_DIR/server"
    pm2 save
    echo "✅ Installatie voltooid! De app draait en start automatisch na een reboot."
else
    echo "✅ Installatie server-pakketten voltooid!"
    echo "Clone nu de repository en draai daarna scripts/2-update-app.sh:"
    echo "git clone git@github.com:ROosterloo1988/matchapp.git"
fi
