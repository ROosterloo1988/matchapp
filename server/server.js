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
                
                // 1. DE TELEFOONBOEK STOFZUIGER!
                let spelersDict = {};
                function bouwWoordenboek(obj) {
                    if (!obj || typeof obj !== 'object') return;
                    
                    // Als we iets zien met een naam én een ID, is het een speler. Sla hem direct op!
                    if (obj.name && (obj.dcid || obj.id || obj.player_id)) {
                        let spelerId = obj.dcid || obj.id || obj.player_id;
                        spelersDict[spelerId] = obj.name;
                    }
                    
                    // Trek alle sub-mapjes open op zoek naar meer spelers
                    Object.values(obj).forEach(val => bouwWoordenboek(val));
                }
                // Zet de stofzuiger aan voor ALLES
                bouwWoordenboek(dataContainer);

                let matchesList = [];

                // 2. DE WEDSTRIJD STOFZUIGER
                function zoekWedstrijden(obj) {
                    if (!obj || typeof obj !== 'object') return;
                    if ('p1' in obj || 'd1' in obj) {
                        matchesList.push(obj);
                    } else {
                        Object.values(obj).forEach(val => zoekWedstrijden(val));
                    }
                }
                zoekWedstrijden(bronMap);

                // 3. DE VERTALER
                function getSpelerNaam(idOrArray) {
                    if (!idOrArray) return "Onbekend";
                    
                    // Voor koppels en teams
                    if (Array.isArray(idOrArray)) {
                        const validIds = idOrArray.filter(id => id && id !== -1);
                        if (validIds.length === 0) return "Onbekend";
                        
                        // Kijk gewoon in ons eigen gebouwde woordenboek!
                        const namen = validIds.map(id => spelersDict[id] || `Speler ${id}`);
                        return namen.join(" & ");
                    }
                    
                    // Voor singles
                    if (idOrArray === -1) return "Onbekend";
                    return spelersDict[idOrArray] || `Speler ${idOrArray}`;
                }

                // 4. ALLES SAMENVOEGEN
                if (matchesList.length > 0) {
                    const matchesMetToernooi = matchesList.map(m => {
                        // DartConnect gebruikt soms id, soms match_id. We vervangen de underscore door een streepje (zoals op TV).
                        let matchId = m.id || m.match_id || "";
                        if (typeof matchId === 'string') matchId = matchId.replace('_', '-');

                        return {
                            id: matchId,
                            player1: getSpelerNaam(m.d1 || m.p1),
                            player2: getSpelerNaam(m.d2 || m.p2),
                            // Score kan een getal of letter zijn. Als hij null of undefined is, sturen we een lege string.
                            score1: m.s1 !== null && m.s1 !== undefined ? m.s1 : "",
                            score2: m.s2 !== null && m.s2 !== undefined ? m.s2 : "",
                            board: m.bn || m.b || m.board || m.bd || "?",
                            // We pakken de tijd! Soms zit hij in tm, soms in t, soms time.
                            time: m.tm || m.t || m.time || m.st || "Later",
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

// --- FILTEREN EN SORTEREN ---
    
    // 1. Filter de data voor onze darters
    const dartersLower = db.darters.map(d => d.toLowerCase());
    let filteredMatches = rawMatches.filter(match => {
        const matchString = JSON.stringify(match).toLowerCase();
        return dartersLower.some(darter => matchString.includes(darter));
    });

    // 2. NIEUW: Sorteer op tijd, en daarna op bordnummer!
    filteredMatches.sort((a, b) => {
        // Tijd "Onbekend" of leeg? Dan geven we het intern de fictieve tijd "24:00" zodat het onderaan belandt.
        let tijdA = (a.time && a.time !== "Onbekend") ? a.time : "24:00";
        let tijdB = (b.time && b.time !== "Onbekend") ? b.time : "24:00";
        
        // Vergelijk de tijden
        if (tijdA !== tijdB) {
            return tijdA.localeCompare(tijdB);
        }
        
        // Is de starttijd exact hetzelfde? Sorteer dan op bordnummer!
        let bordA = parseInt(a.board) || 999;
        let bordB = parseInt(b.board) || 999;
        return bordA - bordB;
    });

    // 3. Stuur de perfect gesorteerde lijst naar het dashboard
    res.json(filteredMatches);
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
