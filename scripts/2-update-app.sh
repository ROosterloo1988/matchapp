#!/bin/bash
echo "⬇️ Start: Nieuwste versie ophalen van GitHub..."

# Ga naar de map van je app. Verander dit pad als je hem ergens anders hebt gezet!
cd ~/matchapp || { echo "❌ Fout: Map ~/matchapp niet gevonden. Heb je 'git clone' al uitgevoerd?"; exit 1; }

# Haal de nieuwste wijzigingen op (forceer dit, weggooien van eventuele lokale onbedoelde wijzigingen)
git fetch origin main
git reset --hard origin/main

echo "📦 Node modules updaten (indien nodig)..."
npm install

echo "🔄 Applicatie herstarten via PM2..."
# We gaan ervan uit dat je app 'dart-proxy' heet in PM2. 
# Mocht hij nog niet draaien, dan proberen we hem te starten via server.js (pas dit aan als je bestand anders heet).
pm2 restart dart-proxy || pm2 start server.js --name "dart-proxy"

echo "✅ Update succesvol afgerond! Je app draait op de nieuwste versie."
