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

                // DE STOFZUIGER: Kijkt net zo diep in alle mapjes/rondes totdat hij de echte wedstrijden vindt
                function zoekWedstrijden(obj) {
                    if (!obj || typeof obj !== 'object') return;
                    
                    // We weten dat het een echte wedstrijd is als er een 'p1' of 'd1' (speler data) in zit
                    if ('p1' in obj || 'd1' in obj) {
                        matchesList.push(obj);
                    } else {
                        // Zo niet, trek alle sub-mapjes (zoals "0", "1", of "Ronde 2") open en zoek daarin verder
                        Object.values(obj).forEach(val => zoekWedstrijden(val));
                    }
                }
                
                // Zet de stofzuiger aan!
                zoekWedstrijden(bronMap);

                // HULPJE: Bladert door het telefoonboek, ongeacht hoe DartConnect het aanlevert
                function vindSpeler(id) {
                    if (!playersMap) return null;
                    
                    // Als het telefoonboek een 'lijst' is (Array)
                    if (Array.isArray(playersMap)) {
                        return playersMap.find(p => p.id == id || p.player_id == id || p.key == id);
                    }
                    
                    // Als het een 'woordenboek' is (Object)
                    return playersMap[id] || Object.values(playersMap).find(p => p && (p.id == id || p.player_id == id));
                }

                // Helper: Vertaalt de nummers naar namen
                function getSpelerNaam(idOrArray) {
                    if (!idOrArray) return "Onbekend";
                    
                    // Voor koppels en teams (Lijst met nummers)
                    if (Array.isArray(idOrArray)) {
                        const validIds = idOrArray.filter(id => id && id !== -1);
                        if (validIds.length === 0) return "Onbekend";
                        
                        const namen = validIds.map(id => {
                            let p = vindSpeler(id);
                            if (!p) return `Speler ${id}`; // Mocht hij écht niet bestaan
                            return p.name || p.player_name || `${p.first_name || ''} ${p.last_name || ''}`.trim() || `Speler ${id}`;
                        });
                        return namen.join(" & ");
                    }
                    
                    // Voor singles (Één los nummer)
                    if (idOrArray === -1) return "Onbekend";
                    let p = vindSpeler(idOrArray);
                    if (!p) return `Speler ${idOrArray}`;
                    return p.name || p.player_name || `${p.first_name || ''} ${p.last_name || ''}`.trim() || `Speler ${idOrArray}`;
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

app.listen(PORT, () => console.log(`🎯 Server draait op http://localhost:${PORT}`));
