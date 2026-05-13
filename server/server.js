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
                
                let dataContainer = response.data.payload || response.data;
                let bronMap = dataContainer.proBracket || dataContainer.bracketData || dataContainer;
                let playersMap = dataContainer.proPlayers || {}; // Het Telefoonboek!

                let matchesList = [];
                if (Array.isArray(bronMap)) {
                    matchesList = bronMap; 
                } else if (typeof bronMap === 'object') {
                    Object.values(bronMap).forEach(val => {
                        if (Array.isArray(val)) matchesList = matchesList.concat(val);
                    });
                }

                // Helper: Zoek het ID op in het telefoonboek (ondersteunt nu arrays!)
                function getSpelerNaam(idOrArray) {
                    if (!idOrArray) return "Onbekend";
                    
                    // Als het een array is (bijv. [2023814, 2023820] voor koppels of teams)
                    if (Array.isArray(idOrArray)) {
                        // Filter lege of -1 waarden eruit
                        const validIds = idOrArray.filter(id => id && id !== -1);
                        if (validIds.length === 0) return "Onbekend";
                        
                        // Zoek de naam op voor elk ID en voeg ze samen
                        const namen = validIds.map(id => {
                            let p = playersMap[id];
                            if (!p) return `Speler ${id}`;
                            return p.name || p.player_name || `${p.first_name || ''} ${p.last_name || ''}`.trim() || `Speler ${id}`;
                        });
                        return namen.join(" & ");
                    }
                    
                    // Als het gewoon één nummer is (zoals in je eerste screenshot)
                    if (idOrArray === -1) return "Onbekend";
                    let p = playersMap[idOrArray];
                    if (!p) return `Speler ${idOrArray}`;
                    return p.name || p.player_name || `${p.first_name || ''} ${p.last_name || ''}`.trim() || `Speler ${idOrArray}`;
                }

                if (matchesList.length > 0) {
                    const matchesMetToernooi = matchesList.map(m => {
                        return {
                            ...m,
                            // Gebruik m.d1 of m.p1, afhankelijk van wat DartConnect in dit toernooi gebruikt
                            player1: getSpelerNaam(m.d1 || m.p1),
                            player2: getSpelerNaam(m.d2 || m.p2),
                            // Soms gebruikt DartConnect 'bn' voor board number ipv 'b'
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

app.listen(PORT, () => console.log(`🎯 Server draait op http://localhost:${PORT}`));
