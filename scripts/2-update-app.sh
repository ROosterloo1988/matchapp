#!/bin/bash
echo "⬇️ Start: Nieuwste versie ophalen van GitHub..."

# Ga naar de map van je app. Verander dit pad als je hem ergens anders hebt gezet!
cd ~/workspace/matchapp || { echo "❌ Fout: Map ~/workspace/matchapp niet gevonden. Heb je 'git clone' al uitgevoerd?"; exit 1; }

# Haal de nieuwste wijzigingen op (forceer dit, weggooien van eventuele lokale onbedoelde wijzigingen)
git fetch origin main
git reset --hard origin/main

echo "📦 Node modules updaten (indien nodig)..."
npm install

# Duik het server mapje in
cd server || { echo "Map 'server' niet gevonden!"; exit 1; }
npm install

echo "🔄 Applicatie herstarten via PM2..."
pm2 restart dart-proxy || pm2 start server.js --name "dart-proxy"

# Ga netjes weer een mapje terug omhoog
cd ..

echo "✅ Update succesvol afgerond! Je app draait op de nieuwste versie."
