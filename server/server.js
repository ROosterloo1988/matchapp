const express = require('express');
const cors = require('cors');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json()); // Om JSON data van de admin pagina te snappen
app.use(express.static(path.join(__dirname, '../public'))); // Serveer de HTML bestanden

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
            // FIX 1: We gebruiken nu axios.POST in plaats van axios.GET!
            // We sturen ook een lege body ({}) mee, want dat verwacht een POST verzoek vaak.
            const requests = db.tournaments.map(t => axios.post(t.url, {}));
            const responses = await Promise.all(requests);
            
            responses.forEach((response, index) => {
                const toernooiNaam = db.tournaments[index].name;
                
                // DEBUG: Wat krijgen we precies terug van DartConnect?
                console.log(`[DEBUG] Data structuur voor ${toernooiNaam}:`, Object.keys(response.data));
                
                // FIX 2: Slim zoeken naar de wedstrijdenlijst
                let matchesList = [];
                if (Array.isArray(response.data)) {
                    matchesList = response.data; // Het was al een platte lijst
                } else if (response.data.matches) {
                    matchesList = response.data.matches; // Genest onder 'matches'
                } else if (response.data.games) {
                    matchesList = response.data.games; // Genest onder 'games'
                } else if (response.data.bracket) {
                    matchesList = response.data.bracket; // Genest onder 'bracket'
                } else {
                    console.log(`[WAARSCHUWING] Kon geen wedstrijdenlijst vinden voor ${toernooiNaam}`);
                }

                // Plak de toernooinaam eraan vast
                const matchesMetToernooi = matchesList.map(m => ({ ...m, toernooi: toernooiNaam }));
                rawMatches = rawMatches.concat(matchesMetToernooi);
            });

            cache.data = rawMatches;
            cache.timestamp = now;
        } catch (error) {
            console.error("Fout bij ophalen DartConnect:", error.message);
            // Als de DartConnect server wéér moeilijk doet, zien we dat nu tenminste!
            if (error.response) {
                console.error("DartConnect Status Code:", error.response.status);
            }
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

    // Filter de data zodat we alleen JOUW darters doorsturen naar het dashboard
    const dartersLower = db.darters.map(d => d.toLowerCase());
    const filteredMatches = rawMatches.filter(match => {
        // Pas dit aan op hoe DartConnect de namen precies noemt in hun JSON (bijv. match.player1, match.name, etc.)
        // Voor nu zoeken we in de hele JSON string van die specifieke match naar de naam.
        const matchString = JSON.stringify(match).toLowerCase();
        return dartersLower.some(darter => matchString.includes(darter));
    });

    res.json(filteredMatches);
});

app.listen(PORT, () => {
    console.log(`🎯 Server draait op http://localhost:${PORT}`);
});
