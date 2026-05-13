#!/bin/bash
echo "⬆️ Start: Lokale wijzigingen pushen naar GitHub..."

cd ~/matchapp || { echo "❌ Fout: Map ~/matchapp niet gevonden."; exit 1; }

# Vraag om een bericht wat je hebt aangepast
read -p "📝 Wat heb je aangepast? (commit bericht): " commit_msg

# Als je niks invult, geven we een standaard bericht
if [ -z "$commit_msg" ]; then
    commit_msg="Update vanaf Ubuntu server"
fi

echo "Git configureren (eenmalig nodig als je lokaal commit)..."
git config user.name "Ubuntu Server"
git config user.email "server@dutchopen.local"

# Voeg alles toe, maak de commit en push
git add .
git commit -m "$commit_msg"
git push origin main

echo "✅ Release succesvol! De wijzigingen staan op GitHub (https://github.com/ROosterloo1988/matchapp)."
