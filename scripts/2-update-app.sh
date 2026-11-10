#!/bin/bash
# Werkt de app bij naar de nieuwste versie op GitHub en (her)start hem via PM2.
# Alles staat in main(): bash leest zo het hele script in vóór git reset het bestand overschrijft
main() {
APP_NAME="dart-proxy"
OLD_APP_NAMES="dart-match-app"   # oude naam uit de readme; zorgt anders voor een dubbel proces op poort 3000
PORT=3000

# De repo-map is de map boven deze scripts-map, waar je de repo ook gecloned hebt
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR" || { echo "❌ Fout: Map $APP_DIR niet gevonden."; exit 1; }
echo "⬇️ Start: Nieuwste versie ophalen van GitHub in $APP_DIR..."

# Haal nieuwste code op (database.json en node_modules staan in .gitignore en blijven bewaard)
git fetch origin main || { echo "❌ Fout: Kon niet ophalen van GitHub."; exit 1; }
git reset --hard origin/main

# Controleer de Node.js-versie: server.js gebruikt syntax die minimaal Node 14 nodig heeft
NODE_MAJOR=$(node -v 2>/dev/null | sed 's/^v\([0-9]*\).*/\1/')
if [ -z "$NODE_MAJOR" ] || [ "$NODE_MAJOR" -lt 18 ]; then
    echo "❌ Fout: Node.js $(node -v 2>/dev/null || echo 'niet gevonden') is te oud. Minimaal Node 18 nodig."
    echo "   Draai eerst opnieuw scripts/1-install-server.sh om Node.js bij te werken."
    exit 1
fi

echo "📦 Node modules updaten..."
cd server || { echo "❌ Fout: Map 'server' niet gevonden!"; exit 1; }
npm install --omit=dev || { echo "❌ Fout: npm install mislukt."; exit 1; }
# package-lock.json staat niet in git en houdt oude (sub)pakketten vast; werk die bij naar
# veilige versies binnen dezelfde hoofdversie (geen --force, dus geen brekende updates)
npm audit fix --omit=dev --no-fund || echo "⚠️ npm audit fix kon niet alles oplossen, de app wordt wel gestart."

echo "🔄 Applicatie herstarten via PM2..."
for old in $OLD_APP_NAMES; do
    pm2 delete "$old" >/dev/null 2>&1 && echo "🧹 Oud proces '$old' verwijderd."
done
if pm2 describe "$APP_NAME" >/dev/null 2>&1; then
    pm2 restart "$APP_NAME" --update-env
else
    pm2 start server.js --name "$APP_NAME" --cwd "$APP_DIR/server"
fi
# Sla de proceslijst op, zodat PM2 de app na een reboot weer start
pm2 save

echo "⏳ Controleren of de app reageert op poort $PORT..."
for i in $(seq 1 10); do
    if curl -s -o /dev/null "http://localhost:$PORT/"; then
        echo "✅ Update succesvol afgerond! De app draait op http://localhost:$PORT"
        return 0
    fi
    sleep 1
done

echo "❌ De app reageert niet op poort $PORT. Laatste logregels:"
pm2 logs "$APP_NAME" --lines 30 --nostream
exit 1
}
main "$@"
