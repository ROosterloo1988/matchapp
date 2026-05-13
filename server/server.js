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

function readDB() {
    if (!fs.existsSync(DB_FILE)) return { tournaments: [], darters: [] };
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}

function writeDB(data) {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

app.get('/api/settings', (req, res) => res.json(readDB()));
app.post('/api/settings', (req, res) => {
    writeDB(req.body);
    res.json({ success: true, message: "Instellingen opgeslagen!" });
});

let cache = { data: null, timestamp: 0 };
const CACHE_TIME = 30 * 1000;

app.get('/api/matches', async (req, res) => {
    const db = readDB();
    if (db.tournaments.length === 0) return res.json([]);

    const now = Date.now();
    let rawMatches = [];

    if (cache.data && (now - cache.timestamp < CACHE_TIME)) {
        rawMatches = cache.data;
    } else {
        try {
            const requests = db.tournaments.map(t => axios.post(t.url, {}));
            const responses = await Promise.all(requests);
            
            responses.forEach((response, index) => {
                const toernooiNaam = db.tournaments[index].name;
                
                let dataContainer = response.data.payload || response.data || {};
                let bronMap = dataContainer.proBracket || dataContainer.bracketData || dataContainer;
                
                // DE KLUIS IS GEKRAAKT: We kijken nu direct in de 'playerList' map!
                let proPlayersObj = dataContainer.proPlayers || dataContainer.players || {};
                let spelerLijst = proPlayersObj.playerList || (Array.isArray(proPlayersObj) ? proPlayersObj : Object.values(proPlayersObj));

                let matchesList = [];

                // De Stofzuiger (Haalt alle wedstrijden netjes uit de rondes)
                function zoekWedstrijden(obj) {
                    if (!obj || typeof obj !== 'object') return;
                    if ('p1' in obj || 'd1' in obj) {
                        matchesList.push(obj);
                    } else {
                        Object.values(obj).forEach(val => zoekWedstrijden(val));
                    }
                }
                
                zoekWedstrijden(bronMap);

                // Het Hulpje (Zoekt het ID nu op de juiste plek!)
                function vindSpeler(id) {
                    if (Array.isArray(spelerLijst)) {
                        return spelerLijst.find(p => p && (p.id == id || p.dcid == id || p.player_id == id));
                    }
                    return proPlayersObj[id];
                }

                // De Vertaler (Pakt de namen erbij)
                function getSpelerNaam(idOrArray) {
                    if (!idOrArray) return "Onbekend";
                    
                    if (Array.isArray(idOrArray)) {
                        const validIds = idOrArray.filter(id => id && id !== -1);
                        if (validIds.length === 0) return "Onbekend";
                        
                        const namen = validIds.map(id => {
                            let p = vindSpeler(id);
                            if (!p) return `Speler ${id}`; 
                            return p.name || `${p.first_name || ''} ${p.last_name || ''}`.trim() || `Speler ${id}`;
                        });
                        return namen.join(" & ");
                    }
                    
                    if (idOrArray === -1) return "Onbekend";
                    let p = vindSpeler(idOrArray);
                    if (!p) return `Speler ${idOrArray}`;
                    return p.name || `${p.first_name || ''} ${p.last_name || ''}`.trim() || `Speler ${idOrArray}`;
                }

                if (matchesList.length > 0) {
                    const matchesMetToernooi = matchesList.map(m => {
                        return {
                            // Dit verwijdert alle overbodige troep (zoals de as, by, ch code) en houdt de JSON schoon!
                            id: m.id,
                            player1: getSpelerNaam(m.d1 || m.p1),
                            player2: getSpelerNaam(m.d2 || m.p2),
                            board: m.bn || m.b || m.board || m.bd || "?",
                            time: m.t || m.time || m.st || "Onbekend",
                            toernooi: toernooiNaam
                        };
                    });
                    rawMatches = rawMatches.concat(matchesMetToernooi);
                }
            });

            cache.data = rawMatches;
            cache.timestamp = now;
        } catch (error) {
            console.error("Fout:", error.message);
            return res.status(500).json({ error: "Kon data niet ophalen" });
        }
    }

    // De filter is weer AAN!
    const dartersLower = db.darters.map(d => d.toLowerCase());
    const filteredMatches = rawMatches.filter(match => {
        // We zoeken in de hele JSON van de wedstrijd, dus ook in 'player1' en 'player2'
        const matchString = JSON.stringify(match).toLowerCase();
        return dartersLower.some(darter => matchString.includes(darter));
    });

    res.json(rawMatches);
});

// --- API: RUWE DATA DUMP (Om te spieken!) ---
app.get('/api/debug', async (req, res) => {
    const db = readDB();
    if (db.tournaments.length === 0) return res.json({ error: "Geen toernooien in admin" });

    try {
        // We pakken gewoon het allereerste toernooi uit je lijst
        const response = await axios.post(db.tournaments[0].url, {});
        
        // We sturen de VOLLEDIGE, onbewerkte payload naar je scherm
        res.json(response.data.payload || response.data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.listen(PORT, () => console.log(`🎯 Server draait op http://localhost:${PORT}`));
