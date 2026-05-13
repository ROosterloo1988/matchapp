#!/bin/bash
echo "📦 Start: Systeem updaten en afhankelijkheden installeren..."
sudo apt update && sudo apt upgrade -y

echo "🟢 Node.js en npm installeren..."
sudo apt install nodejs npm -y

echo "🔄 PM2 (Process Manager) installeren..."
sudo npm install -g pm2

echo "⚙️ PM2 instellen om automatisch te starten bij server reboot..."
pm2 startup

echo "✅ Installatie server-pakketten voltooid!"
echo "Je kunt nu je repository clonen met:"
echo "git clone git@github.com:ROosterloo1988/matchapp.git"
