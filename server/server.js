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
                            toernooi: toernooiNaam,
                            isFinished: m.fn === true // DartConnect gebruikt 'fn' voor finished
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

// --- FILTEREN, VOORSPELLEN EN SORTEREN (V4: Tijdreizen!) ---
    
    // 🕒 TIJDREIS INSTELLING: 
    // Zet hier een tijd (bijv. "17:00") om te testen. 
    // BELANGRIJK: Verander dit in `null` op de echte toernooidag! (const SIMULATIE_TIJD = null;)
    const SIMULATIE_TIJD = "null"; 

    if (SIMULATIE_TIJD) {
        rawMatches = rawMatches.map(match => {
            // Als de wedstrijd na de simulatietijd is, of we weten de tijd nog niet: wis de uitslag!
            if (!match.time || match.time === "Onbekend" || match.time === "Later" || match.time >= SIMULATIE_TIJD) {
                return { ...match, isFinished: false, score1: "", score2: "" };
            }
            return match;
        });
    }

    const dartersLower = db.darters.map(d => d.toLowerCase());
    let definitieveLijst = [];
    let toegevoegdeIds = new Set();

    // 1. Zoek alle wedstrijden waar onze darters in staan
    let eigenWedstrijden = rawMatches.filter(match => {
        const matchString = JSON.stringify(match).toLowerCase();
        return dartersLower.some(darter => matchString.includes(darter));
    });

    eigenWedstrijden.forEach(match => {
        // Bepaal de status: als er een score is OF hij is afgevinkt in DartConnect
        match.status = (match.isFinished || (match.score1 !== "" && match.score2 !== "")) ? "gespeeld" : "gepland";
        match.isMogelijk = false;
        
        // Bepaal resultaat (Win/Verlies) voor de Rood/Groen kleuren
        if (match.status === "gespeeld") {
            let onzeSpeler = db.darters.find(d => 
                (match.player1 && match.player1.toLowerCase().includes(d.toLowerCase())) || 
                (match.player2 && match.player2.toLowerCase().includes(d.toLowerCase()))
            );
            
            if (onzeSpeler) {
                const isP1 = match.player1.toLowerCase().includes(onzeSpeler.toLowerCase());
                const s1 = (match.score1 === 'W' || match.score1 === 'X') ? 99 : (match.score1 === 'F' ? -1 : parseInt(match.score1) || 0);
                const s2 = (match.score2 === 'W' || match.score2 === 'X') ? 99 : (match.score2 === 'F' ? -1 : parseInt(match.score2) || 0);
                
                if (isP1) {
                    match.resultaat = (s1 > s2) ? "win" : "verlies";
                } else {
                    match.resultaat = (s2 > s1) ? "win" : "verlies";
                }
            }
        }

        let uniekeKey = match.toernooi + match.id;
        definitieveLijst.push(match);
        toegevoegdeIds.add(uniekeKey);
    });

    // 2. VOORSPELLEN VAN DE VOLGENDE RONDE
    eigenWedstrijden.forEach(match => {
        let spelerNaam = db.darters.find(d => 
            (match.player1 && match.player1.toLowerCase().includes(d.toLowerCase())) || 
            (match.player2 && match.player2.toLowerCase().includes(d.toLowerCase()))
        ) || "Onze speler";

        // Mogen we doorvoorspellen? Ja, als we moeten spelen, OF als we net gewonnen hebben!
        let magDoor = (match.status === "gepland") || (match.status === "gespeeld" && match.resultaat === "win");

        if (magDoor && match.id) {
            let matchRegex = match.id.match(/^(\d+)-(\d+)$/);
            if (matchRegex) {
                let nextId = (parseInt(matchRegex[1]) + 1) + "-" + Math.ceil(parseInt(matchRegex[2]) / 2); 
                let mogelijkeMatch = rawMatches.find(rm => rm.toernooi === match.toernooi && rm.id === nextId);

                if (mogelijkeMatch) {
                    let mKey = mogelijkeMatch.toernooi + mogelijkeMatch.id;
                    // Check of deze toekomstige wedstrijd niet toevallig stiekem al gespeeld is door een ander
                    let isAlGeweest = mogelijkeMatch.isFinished === true || mogelijkeMatch.score1 !== "";

                    // Als de volgende wedstrijd nog NIET op ons bord staat
                    if (!toegevoegdeIds.has(mKey) && !isAlGeweest) {
                        let kloon = { ...mogelijkeMatch, isMogelijk: true, status: "mogelijk", mogelijkVoor: spelerNaam };
                        definitieveLijst.push(kloon);
                        toegevoegdeIds.add(mKey);
                    }
                }
            }
        }
    });

    // 3. SORTEREN: Eerst Gepland, dan Mogelijk, dan Gespeeld
    definitieveLijst.sort((a, b) => {
        const volgorde = { "gepland": 1, "mogelijk": 2, "gespeeld": 3 };
        if (volgorde[a.status] !== volgorde[b.status]) return volgorde[a.status] - volgorde[b.status];
        
        let tijdA = (a.time && !["Onbekend", "Later"].includes(a.time)) ? a.time : "24:00";
        let tijdB = (b.time && !["Onbekend", "Later"].includes(b.time)) ? b.time : "24:00";
        return tijdA.localeCompare(tijdB) || (parseInt(a.board) || 999) - (parseInt(b.board) || 999);
    });

    res.json(definitieveLijst);
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
