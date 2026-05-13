#!/bin/bash
echo "⬇️ Start: Nieuwste versie ophalen van GitHub..."

cd ~/workspace/matchapp || { echo "❌ Fout: Map niet gevonden."; exit 1; }

# Haal nieuwste code op
git fetch origin main
git reset --hard origin/main

echo "📦 Node modules updaten..."
# Duik DIRECT de server map in voordat we npm installeren
cd server || { echo "❌ Fout: Map 'server' niet gevonden!"; exit 1; }
npm install

echo "🔄 Applicatie herstarten via PM2..."
pm2 restart dart-proxy || pm2 start server.js --name "dart-proxy"

cd ..
echo "✅ Update succesvol afgerond! Je app draait op de nieuwste versie."
