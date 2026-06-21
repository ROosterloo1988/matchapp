#!/bin/bash
set -e

cd ~/workspace/matchapp || { echo "❌ Fout: Map niet gevonden."; exit 1; }

echo "⬇️ Nieuwste versie ophalen van GitHub..."
git fetch origin main
git reset --hard origin/main

echo "📦 Node modules updaten..."
cd server
npm install --audit=false

echo "🔧 Beveiligingsproblemen automatisch oplossen..."
npm audit fix --force 2>/dev/null || true

echo "🔄 Applicatie herstarten via PM2..."
cd ..
pm2 restart dart-proxy || pm2 start server/server.js --name "dart-proxy"

echo "✅ Update succesvol afgerond!"
