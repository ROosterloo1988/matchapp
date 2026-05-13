const express = require('express');
const cors = require('cors');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

const DB_FILE = path.join(__dirname, 'database.json');

// --- DATABASE LOGICA ---
function readDB() {
    if (!fs.existsSync(DB_FILE)) {
        return { tournaments: [], darters: [] };
    }
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}

function writeDB(data) {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

// --- API: INSTELLINGEN (Voor Admin) ---
app.get('/api/settings', (req, res) => {
    res.json(readDB());
});

app.post('/api/settings', (req, res) => {
    writeDB(req.body);
    res.json({ success: true, message: "Instellingen opgeslagen!" });
});

// --- API: MATCHES (Voor Dashboard) ---
let cache = { data: null, timestamp: 0 };
const CACHE_TIME = 30 * 1000; // 30 seconden

app.get('/api/matches', async (req, res) => {
    const db = readDB();
    if (db.tournaments.length === 0) return res.json([]);

    const now = Date.now();
    let rawMatches = [];

    if (cache.data && (now - cache.timestamp < CACHE_TIME)) {
        rawMatches = cache.data;
    } else {
        try {
            // We gebruiken axios.post omdat DartConnect GET-verzoeken blokkeert
            const requests = db.tournaments.map(t => axios.post(t.url, {}));
            const responses = await Promise.all(requests);
            
            responses.forEach((response, index) => {
                const toernooiNaam = db.tournaments[index].name;
                
                // DEBUG: Print de structuur in je log
                console.log(`[DEBUG] Data structuur voor ${toernooiNaam}:`, Object.keys(response.data));
                
                let dataContainer = response.data.payload || response.data;
                let bronMap = dataContainer.proBracket || dataContainer.bracketData || dataContainer;
                let playersMap = dataContainer.proPlayers || {}; // HET TELEFOONBOEK!

                let matchesList = [];

                if (Array.isArray(bronMap)) {
                    matchesList = bronMap; 
                } else if (typeof bronMap === 'object') {
                    Object.values(bronMap).forEach(val => {
                        if (Array.isArray(val)) matchesList = matchesList.concat(val);
                    });
                }

                // Helper functie om naam op te zoeken in het telefoonboek
                function getSpelerNaam(id) {
                    if (!id) return "Onbekend";
                    let p = playersMap[id];
                    if (!p) return `Speler ${id}`; // Als hij echt niet bestaat
                    // DartConnect gebruikt soms 'name' en soms 'first_name last_name'
                    return p.name || p.player_name || `${p.first_name || ''} ${p.last_name || ''}`.trim() || `Speler ${id}`;
                }

                if (matchesList.length > 0) {
                    const matchesMetToernooi = matchesList.map(m => {
                        return {
                            ...m,
                            // Knoop de juiste namen vast aan het ID
                            player1: getSpelerNaam(m.p1),
                            player2: getSpelerNaam(m.p2),
                            // DartConnect gebruikt vaak 'b' voor board en 't' voor time
                            board: m.b || m.board || m.bd || "?",
                            time: m.t || m.time || m.st || "Onbekend",
                            toernooi: toernooiNaam
                        };
                    });
                    rawMatches = rawMatches.concat(matchesMetToernooi);
                } else {
                    console.log(`[WAARSCHUWING] Geen wedstrijden gevonden voor ${toernooiNaam}`);
                }
            });

            cache.data = rawMatches;
            cache.timestamp = now;
        } catch (error) {
            console.error("Fout bij ophalen DartConnect:", error.message);
            return res.status(500).json({ error: "Kon data niet ophalen" });
        }
    }

    // Filter de data voor onze darters
    const dartersLower = db.darters.map(d => d.toLowerCase());
    const filteredMatches = rawMatches.filter(match => {
        const matchString = JSON.stringify(match).toLowerCase();
        return dartersLower.some(darter => matchString.includes(darter));
    });

    res.json(filteredMatches);
});

// Zorg dat de server gaat luisteren!
app.listen(PORT, () => {
    console.log(`🎯 Server draait op http://localhost:${PORT}`);
});
