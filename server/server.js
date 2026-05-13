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
                
                // FIX: DartConnect verstopt de data in een "payload" mapje!
                let dataContainer = response.data.payload || response.data;

                // FIX 2: En daarbinnen in "bracketData"!
                if (dataContainer.bracketData) {
                    dataContainer = dataContainer.bracketData;
                }

                // Slim zoeken naar de wedstrijdenlijst in die container
                let matchesList = [];
                if (Array.isArray(dataContainer)) {
                    matchesList = dataContainer; 
                } else if (dataContainer.matches) {
                    matchesList = dataContainer.matches;
                } else if (dataContainer.games) {
                    matchesList = dataContainer.games;
                } else if (dataContainer.bracket) {
                    matchesList = dataContainer.bracket;
                } else {
                    // Als 'bracketData' een object is met rondes (bijv. "Losers Bracket": [...])
                    console.log(`[DEBUG] Container is een object. Keys:`, Object.keys(dataContainer));
                    Object.values(dataContainer).forEach(val => {
                        if (Array.isArray(val)) {
                            matchesList = matchesList.concat(val);
                        }
                    });
                }

                if (matchesList.length > 0) {
                    const matchesMetToernooi = matchesList.map(m => ({ ...m, toernooi: toernooiNaam }));
                    rawMatches = rawMatches.concat(matchesMetToernooi);
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
