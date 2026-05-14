const express = require('express');
const cors = require('cors');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const webpush = require('web-push'); // NIEUW: Push bibliotheek

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

const DB_FILE = path.join(__dirname, 'database.json');

// --- DATABASE & PUSH SETUP ---
function readDB() {
    if (!fs.existsSync(DB_FILE)) return { tournaments: [], subscriptions: [], notifiedMatches: [] };
    let db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    if (!db.tournaments) db.tournaments = [];
    if (!db.subscriptions) db.subscriptions = [];
    if (!db.notifiedMatches) db.notifiedMatches = []; // Onthoudt waarover al een melding is gestuurd
    db.tournaments.forEach(t => { if (!t.darters) t.darters = []; });
    
    // Genereer VAPID keys voor Push (als ze nog niet bestaan)
    if (!db.vapidKeys) {
        db.vapidKeys = webpush.generateVAPIDKeys();
        fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
    }
    return db;
}

function writeDB(data) {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

// Initialiseer Push Settings
const initialDb = readDB();
webpush.setVapidDetails(
    'mailto:jouw@email.nl',
    initialDb.vapidKeys.publicKey,
    initialDb.vapidKeys.privateKey
);

// PUSH ENDPOINTS
app.get('/api/vapidPublicKey', (req, res) => {
    res.send(readDB().vapidKeys.publicKey);
});

app.post('/api/subscribe', (req, res) => {
    const subscription = req.body;
    const db = readDB();
    const exists = db.subscriptions.find(sub => sub.endpoint === subscription.endpoint);
    if (!exists) {
        db.subscriptions.push(subscription);
        writeDB(db);
    }
    res.status(201).json({});
});

// STANDAARD ENDPOINTS
app.get('/api/settings', (req, res) => res.json(readDB()));
app.post('/api/settings', (req, res) => {
    writeDB(req.body);
    res.json({ success: true, message: "Instellingen opgeslagen!" });
});

app.get('/api/tournaments', (req, res) => {
    const db = readDB();
    res.json(db.tournaments.map(t => t.name));
});

let isFirstRun = true; // Zorgt dat je server bij het opstarten niet ineens 20 meldingen uitspuugt

app.get('/api/matches', async (req, res) => {
    const requestedTournament = req.query.tournament;
    const db = readDB();
    const tournament = db.tournaments.find(t => t.name === requestedTournament);

    if (!tournament) return res.json([]);

    let rawMatches = [];
    let matchlistData = []; 

    try {
        const response = await axios.post(tournament.url, {});
        let dataContainer = response.data.payload || response.data || {};
        let bronMap = dataContainer.proBracket || dataContainer.bracketData || dataContainer;
        
        if (tournament.matchlistUrl) {
            try {
                let mlRes = await axios.get(tournament.matchlistUrl).catch(() => axios.post(tournament.matchlistUrl, {}));
                if (mlRes.data && mlRes.data.payload && mlRes.data.payload.completed) {
                    matchlistData = mlRes.data.payload.completed;
                } else if (Array.isArray(mlRes.data)) {
                    matchlistData = mlRes.data;
                }
            } catch(e) { }
        }

        let alleRecaps = [];
        matchlistData.forEach(match => {
            if (match.mi && match.hc && match.ac) {
                alleRecaps.push({ id: match.mi, p1: match.hc.toLowerCase(), p2: match.ac.toLowerCase() });
            }
        });

        let spelersDict = {};
        function bouwWoordenboek(obj) {
            if (!obj || typeof obj !== 'object') return;
            if (obj.name && (obj.dcid || obj.id || obj.player_id)) {
                spelersDict[obj.dcid || obj.id || obj.player_id] = obj.name;
            }
            Object.values(obj).forEach(val => bouwWoordenboek(val));
        }
        bouwWoordenboek(dataContainer);

        let matchesList = [];
        function zoekWedstrijden(obj) {
            if (!obj || typeof obj !== 'object') return;
            if ('p1' in obj || 'd1' in obj) { matchesList.push(obj); } 
            else { Object.values(obj).forEach(val => zoekWedstrijden(val)); }
        }
        zoekWedstrijden(bronMap);

        let rondeTellingen = {};
        matchesList.forEach(m => {
            let matchId = (m.id || m.match_id || "").toString();
            let rndMatch = matchId.match(/^(\d+)[_-]/);
            if (rndMatch) {
                let rnd = rndMatch[1];
                rondeTellingen[rnd] = (rondeTellingen[rnd] || 0) + 1;
            }
        });

        function getSpelerNaam(idOrArray) {
            if (!idOrArray) return "Onbekend";
            if (Array.isArray(idOrArray)) {
                const validIds = idOrArray.filter(id => id && id !== -1);
                if (validIds.length === 0) return "Onbekend";
                return validIds.map(id => spelersDict[id] || `Speler ${id}`).join(" & ");
            }
            if (idOrArray === -1) return "Onbekend";
            return spelersDict[idOrArray] || `Speler ${idOrArray}`;
        }

        if (matchesList.length > 0) {
            const matchesMetToernooi = matchesList.map(m => {
                let matchId = m.id || m.match_id || "";
                if (typeof matchId === 'string') matchId = matchId.replace('_', '-');

                let rondeNaam = "Ronde ?";
                let rondeMatch = matchId.match(/^(\d+)-/);
                if (rondeMatch) {
                    let cR = rondeMatch[1];
                    let aW = rondeTellingen[cR];
                    if (aW === 1) rondeNaam = "Finale";
                    else if (aW === 2) rondeNaam = "Halve Finale";
                    else if (aW === 4) rondeNaam = "Kwartfinale";
                    else if (aW === 8) rondeNaam = "Laatste 16";
                    else if (aW === 16) rondeNaam = "Laatste 32";
                    else if (aW === 32) rondeNaam = "Laatste 64";
                    else rondeNaam = "Ronde " + cR;
                }

                let markerData = m.ch && m.ch.v ? m.ch.v : null;
                let markerNaam = "";
                if (Array.isArray(markerData) || typeof markerData === 'number') markerNaam = getSpelerNaam(markerData);
                else if (typeof markerData === 'string') markerNaam = markerData;

                return {
                    id: matchId,
                    ronde: rondeNaam,
                    player1: getSpelerNaam(m.d1 || m.p1),
                    player2: getSpelerNaam(m.d2 || m.p2),
                    marker: markerNaam,
                    score1: m.s1 !== null && m.s1 !== undefined ? m.s1 : "",
                    score2: m.s2 !== null && m.s2 !== undefined ? m.s2 : "",
                    board: m.bn || m.b || m.board || m.bd || "?",
                    time: m.tm || m.t || m.time || m.st || "Later",
                    toernooi: tournament.name,
                    isFinished: m.fn === true
                };
            });
            rawMatches = rawMatches.concat(matchesMetToernooi);
        }

        const dartersLower = (tournament.darters || []).map(d => d.toLowerCase());
        let definitieveLijst = [];
        let toegevoegdeIds = new Set();
        let nieuwGeplandCount = 0;

        let eigenWedstrijden = rawMatches.filter(match => {
            return dartersLower.some(d => match.player1.toLowerCase().includes(d) || match.player2.toLowerCase().includes(d) || (match.marker && match.marker.toLowerCase().includes(d)));
        });

        eigenWedstrijden.forEach(match => {
            match.status = (match.isFinished || (match.score1 !== "" && match.score2 !== "")) ? "gespeeld" : "gepland";
            match.isMogelijk = false;
            
            let isSpeler = dartersLower.find(d => match.player1.toLowerCase().includes(d) || match.player2.toLowerCase().includes(d));
            let isMarker = dartersLower.find(d => match.marker && match.marker.toLowerCase().includes(d));

            // if (!isSpeler && isMarker && match.status === "gespeeld") return; 
            match.rol = (!isSpeler && isMarker) ? "marker" : "speler";

            // --- PUSH MELDING LOGICA ---
            // Als hij gepland is, het een speler is, en we hebben nog GEEN melding verstuurd
            if (match.status === "gepland" && isSpeler && !db.notifiedMatches.includes(match.id)) {
                db.notifiedMatches.push(match.id); // Direct opslaan
                
                if (!isFirstRun && db.subscriptions.length > 0) {
                    const payload = JSON.stringify({
                        title: "🎯 Nieuwe Wedstrijd Gepland!",
                        body: `${match.player1} vs ${match.player2}\nBord: ${match.board} | Tijd: ${match.time}`
                    });
                    
                    db.subscriptions.forEach(sub => {
                        webpush.sendNotification(sub, payload).catch(err => console.log('Push niet verstuurd (waarschijnlijk uitgelogd):', err));
                    });
                }
                nieuwGeplandCount++;
            }

            if (match.status === "gespeeld" && isSpeler && alleRecaps.length > 0 && match.player1 !== "Onbekend" && match.player2 !== "Onbekend") {
                let p1Words = match.player1.toLowerCase().split(/[ ,]+/).filter(w => w.length > 3);
                let p2Words = match.player2.toLowerCase().split(/[ ,]+/).filter(w => w.length > 3);
                if (p1Words.length === 0) p1Words = [match.player1.toLowerCase()];
                if (p2Words.length === 0) p2Words = [match.player2.toLowerCase()];

                let foundRecap = alleRecaps.find(r => {
                    let p1ZitErin = p1Words.some(w => r.p1.includes(w) || r.p2.includes(w));
                    let p2ZitErin = p2Words.some(w => r.p1.includes(w) || r.p2.includes(w));
                    return p1ZitErin && p2ZitErin;
                });
                
                if (foundRecap) match.recapId = foundRecap.id;
            }

            if (match.status === "gespeeld" && isSpeler) {
                const isP1 = match.player1.toLowerCase().includes(isSpeler);
                const parseScore = (s) => (s === 'W') ? 99 : ((s === 'X' || s === 'F') ? -1 : parseInt(s) || 0);
                const s1 = parseScore(match.score1);
                const s2 = parseScore(match.score2);
                match.resultaat = (isP1 && s1 > s2) || (!isP1 && s2 > s1) ? "win" : "verlies";
            }

            definitieveLijst.push(match);
            toegevoegdeIds.add(match.id);
        });

        // Schrijf de zojuist gewaarschuwde wedstrijden op naar de database
        if (nieuwGeplandCount > 0) writeDB(db);

        eigenWedstrijden.forEach(match => {
            let isSpeler = tournament.darters.find(d => (match.player1 && match.player1.toLowerCase().includes(d.toLowerCase())) || (match.player2 && match.player2.toLowerCase().includes(d.toLowerCase())));
            let magDoor = isSpeler && ((match.status === "gepland") || (match.status === "gespeeld" && match.resultaat === "win"));

            if (magDoor && match.id) {
                let matchRegex = match.id.match(/^(\d+)-(\d+)$/);
                if (matchRegex) {
                    let nextId = (parseInt(matchRegex[1]) + 1) + "-" + Math.ceil(parseInt(matchRegex[2]) / 2); 
                    let mogelijkeMatch = rawMatches.find(rm => rm.id === nextId);

                    if (mogelijkeMatch) {
                        let isAlGeweest = mogelijkeMatch.isFinished === true || mogelijkeMatch.score1 !== "";
                        if (!toegevoegdeIds.has(mogelijkeMatch.id) && !isAlGeweest) {
                            definitieveLijst.push({ ...mogelijkeMatch, isMogelijk: true, status: "mogelijk", mogelijkVoor: isSpeler, rol: "speler" });
                            toegevoegdeIds.add(mogelijkeMatch.id);
                        }
                    }
                }
            }
        });

        definitieveLijst.sort((a, b) => {
            const volgorde = { "gepland": 1, "mogelijk": 2, "gespeeld": 3 };
            if (volgorde[a.status] !== volgorde[b.status]) return volgorde[a.status] - volgorde[b.status];
            
            let tijdA = (a.time && !["Onbekend", "Later"].includes(a.time)) ? a.time : "24:00";
            let tijdB = (b.time && !["Onbekend", "Later"].includes(b.time)) ? b.time : "24:00";
            let rondeA = a.id ? (parseInt(a.id.split('-')[0]) || 0) : 0;
            let rondeB = b.id ? (parseInt(b.id.split('-')[0]) || 0) : 0;

            if (a.status === "gespeeld") {
                return tijdB.localeCompare(tijdA) || (rondeB - rondeA) || ((parseInt(b.board) || 999) - (parseInt(a.board) || 999));
            } else {
                return tijdA.localeCompare(tijdB) || (rondeA - rondeB) || ((parseInt(a.board) || 999) - (parseInt(b.board) || 999));
            }
        });

        isFirstRun = false; // Na 1 keer inladen mag hij voortaan wél meldingen sturen!
        res.json(definitieveLijst);

    } catch (error) {
        console.error("Fout:", error.message);
        return res.status(500).json({ error: "Kon data niet ophalen" });
    }
});

app.listen(PORT, () => console.log(`🎯 Server draait op http://localhost:${PORT}`));
});

app.get('/api/matches', async (req, res) => {
    const requestedTournament = req.query.tournament;
    const db = readDB();
    const tournament = db.tournaments.find(t => t.name === requestedTournament);

    if (!tournament) return res.json([]);

    let rawMatches = [];
    let matchlistData = []; 

    try {
        // 1. Haal BRACKET (Schema) Data op
        const response = await axios.post(tournament.url, {});
        let dataContainer = response.data.payload || response.data || {};
        let bronMap = dataContainer.proBracket || dataContainer.bracketData || dataContainer;
        
        // 2. Haal MATCHLIST (Recap) Data op
        if (tournament.matchlistUrl) {
            try {
                let mlRes = await axios.get(tournament.matchlistUrl).catch(() => axios.post(tournament.matchlistUrl, {}));
                
                // Kijk of de data netjes in payload.completed zit (zoals we in de debug zagen!)
                if (mlRes.data && mlRes.data.payload && mlRes.data.payload.completed) {
                    matchlistData = mlRes.data.payload.completed;
                } else if (Array.isArray(mlRes.data)) {
                    matchlistData = mlRes.data;
                }
            } catch(e) { 
                console.log(`[DEBUG] Matchlist ophalen mislukt voor ${tournament.name}`); 
            }
        }

        // --- NIEUWE MATCHLIST STOFZUIGER ---
        let alleRecaps = [];
        matchlistData.forEach(match => {
            if (match.mi && match.hc && match.ac) {
                alleRecaps.push({
                    id: match.mi,
                    p1: match.hc.toLowerCase(),
                    p2: match.ac.toLowerCase()
                });
            }
        });
        console.log(`[DEBUG] ${tournament.name}: ${alleRecaps.length} recaps gevonden!`);

        // --- BRACKET STOFZUIGER ---
        let spelersDict = {};
        function bouwWoordenboek(obj) {
            if (!obj || typeof obj !== 'object') return;
            if (obj.name && (obj.dcid || obj.id || obj.player_id)) {
                spelersDict[obj.dcid || obj.id || obj.player_id] = obj.name;
            }
            Object.values(obj).forEach(val => bouwWoordenboek(val));
        }
        bouwWoordenboek(dataContainer);

        let matchesList = [];
        function zoekWedstrijden(obj) {
            if (!obj || typeof obj !== 'object') return;
            if ('p1' in obj || 'd1' in obj) { matchesList.push(obj); } 
            else { Object.values(obj).forEach(val => zoekWedstrijden(val)); }
        }
        zoekWedstrijden(bronMap);

        // RONDEN BEREKENEN
        let rondeTellingen = {};
        matchesList.forEach(m => {
            let matchId = (m.id || m.match_id || "").toString();
            let rndMatch = matchId.match(/^(\d+)[_-]/);
            if (rndMatch) {
                let rnd = rndMatch[1];
                rondeTellingen[rnd] = (rondeTellingen[rnd] || 0) + 1;
            }
        });

        function getSpelerNaam(idOrArray) {
            if (!idOrArray) return "Onbekend";
            if (Array.isArray(idOrArray)) {
                const validIds = idOrArray.filter(id => id && id !== -1);
                if (validIds.length === 0) return "Onbekend";
                return validIds.map(id => spelersDict[id] || `Speler ${id}`).join(" & ");
            }
            if (idOrArray === -1) return "Onbekend";
            return spelersDict[idOrArray] || `Speler ${idOrArray}`;
        }

        if (matchesList.length > 0) {
            const matchesMetToernooi = matchesList.map(m => {
                let matchId = m.id || m.match_id || "";
                if (typeof matchId === 'string') matchId = matchId.replace('_', '-');

                let rondeNaam = "Ronde ?";
                let rondeMatch = matchId.match(/^(\d+)-/);
                if (rondeMatch) {
                    let cR = rondeMatch[1];
                    let aW = rondeTellingen[cR];
                    if (aW === 1) rondeNaam = "Finale";
                    else if (aW === 2) rondeNaam = "Halve Finale";
                    else if (aW === 4) rondeNaam = "Kwartfinale";
                    else if (aW === 8) rondeNaam = "Laatste 16";
                    else if (aW === 16) rondeNaam = "Laatste 32";
                    else if (aW === 32) rondeNaam = "Laatste 64";
                    else rondeNaam = "Ronde " + cR;
                }

                let markerData = m.ch && m.ch.v ? m.ch.v : null;
                let markerNaam = "";
                if (Array.isArray(markerData) || typeof markerData === 'number') markerNaam = getSpelerNaam(markerData);
                else if (typeof markerData === 'string') markerNaam = markerData;

                return {
                    id: matchId,
                    ronde: rondeNaam,
                    player1: getSpelerNaam(m.d1 || m.p1),
                    player2: getSpelerNaam(m.d2 || m.p2),
                    marker: markerNaam,
                    score1: m.s1 !== null && m.s1 !== undefined ? m.s1 : "",
                    score2: m.s2 !== null && m.s2 !== undefined ? m.s2 : "",
                    board: m.bn || m.b || m.board || m.bd || "?",
                    time: m.tm || m.t || m.time || m.st || "Later",
                    toernooi: tournament.name,
                    isFinished: m.fn === true
                };
            });
            rawMatches = rawMatches.concat(matchesMetToernooi);
        }

        // --- FILTEREN EN KOPPELEN ---
        const dartersLower = (tournament.darters || []).map(d => d.toLowerCase());
        let definitieveLijst = [];
        let toegevoegdeIds = new Set();

        let eigenWedstrijden = rawMatches.filter(match => {
            return dartersLower.some(d => match.player1.toLowerCase().includes(d) || match.player2.toLowerCase().includes(d) || (match.marker && match.marker.toLowerCase().includes(d)));
        });

        eigenWedstrijden.forEach(match => {
            match.status = (match.isFinished || (match.score1 !== "" && match.score2 !== "")) ? "gespeeld" : "gepland";
            match.isMogelijk = false;
            
            let isSpeler = dartersLower.find(d => match.player1.toLowerCase().includes(d) || match.player2.toLowerCase().includes(d));
            let isMarker = dartersLower.find(d => match.marker && match.marker.toLowerCase().includes(d));

            if (!isSpeler && isMarker && match.status === "gespeeld") return; 
            match.rol = (!isSpeler && isMarker) ? "marker" : "speler";

            // KOPPEL RECAP ID! (Slim zoeken op losse woorden)
            if (match.status === "gespeeld" && isSpeler && alleRecaps.length > 0 && match.player1 !== "Onbekend" && match.player2 !== "Onbekend") {
                
                // Splits namen in lange woorden (bijv: "Van Schie, Jimmy" -> ["schie", "jimmy"])
                let p1Words = match.player1.toLowerCase().split(/[ ,]+/).filter(w => w.length > 3);
                let p2Words = match.player2.toLowerCase().split(/[ ,]+/).filter(w => w.length > 3);
                if (p1Words.length === 0) p1Words = [match.player1.toLowerCase()];
                if (p2Words.length === 0) p2Words = [match.player2.toLowerCase()];

                let foundRecap = alleRecaps.find(r => {
                    let p1ZitErin = p1Words.some(w => r.p1.includes(w) || r.p2.includes(w));
                    let p2ZitErin = p2Words.some(w => r.p1.includes(w) || r.p2.includes(w));
                    return p1ZitErin && p2ZitErin;
                });
                
                if (foundRecap) match.recapId = foundRecap.id;
            }

            // BEPAAL WINST/VERLIES (Met W en X check)
            if (match.status === "gespeeld" && isSpeler) {
                const isP1 = match.player1.toLowerCase().includes(isSpeler);
                
                // Slimme score lezer: W = 99 (Winst), X of F = -1 (Verlies)
                const parseScore = (s) => (s === 'W') ? 99 : ((s === 'X' || s === 'F') ? -1 : parseInt(s) || 0);
                
                const s1 = parseScore(match.score1);
                const s2 = parseScore(match.score2);
                
                match.resultaat = (isP1 && s1 > s2) || (!isP1 && s2 > s1) ? "win" : "verlies";
            }


            definitieveLijst.push(match);
            toegevoegdeIds.add(match.id);
        });

        eigenWedstrijden.forEach(match => {
            let isSpeler = tournament.darters.find(d => (match.player1 && match.player1.toLowerCase().includes(d.toLowerCase())) || (match.player2 && match.player2.toLowerCase().includes(d.toLowerCase())));
            let magDoor = isSpeler && ((match.status === "gepland") || (match.status === "gespeeld" && match.resultaat === "win"));

            if (magDoor && match.id) {
                let matchRegex = match.id.match(/^(\d+)-(\d+)$/);
                if (matchRegex) {
                    let nextId = (parseInt(matchRegex[1]) + 1) + "-" + Math.ceil(parseInt(matchRegex[2]) / 2); 
                    let mogelijkeMatch = rawMatches.find(rm => rm.id === nextId);

                    if (mogelijkeMatch) {
                        let isAlGeweest = mogelijkeMatch.isFinished === true || mogelijkeMatch.score1 !== "";
                        if (!toegevoegdeIds.has(mogelijkeMatch.id) && !isAlGeweest) {
                            definitieveLijst.push({ ...mogelijkeMatch, isMogelijk: true, status: "mogelijk", mogelijkVoor: isSpeler, rol: "speler" });
                            toegevoegdeIds.add(mogelijkeMatch.id);
                        }
                    }
                }
            }
        });

       definitieveLijst.sort((a, b) => {
            const volgorde = { "gepland": 1, "mogelijk": 2, "gespeeld": 3 };
            if (volgorde[a.status] !== volgorde[b.status]) return volgorde[a.status] - volgorde[b.status];
            
            let tijdA = (a.time && !["Onbekend", "Later"].includes(a.time)) ? a.time : "24:00";
            let tijdB = (b.time && !["Onbekend", "Later"].includes(b.time)) ? b.time : "24:00";
            
            // Haal het rondenummer uit de ID (bijv. de "12" uit "12-1") als extra sorteer-regel
            let rondeA = a.id ? (parseInt(a.id.split('-')[0]) || 0) : 0;
            let rondeB = b.id ? (parseInt(b.id.split('-')[0]) || 0) : 0;

            if (a.status === "gespeeld") {
                // GESPEELD: Nieuwste tijd bovenaan. Als de tijd gelijk is (of 'Later'), zet de hoogste ronde bovenaan!
                return tijdB.localeCompare(tijdA) || (rondeB - rondeA) || ((parseInt(b.board) || 999) - (parseInt(a.board) || 999));
            } else {
                // GEPLAND: Vroegste tijd bovenaan. Als de tijd gelijk is, zet de laagste ronde eerst.
                return tijdA.localeCompare(tijdB) || (rondeA - rondeB) || ((parseInt(a.board) || 999) - (parseInt(b.board) || 999));
            }
        });

        res.json(definitieveLijst);

    } catch (error) {
        console.error("Fout:", error.message);
        return res.status(500).json({ error: "Kon data niet ophalen" });
    }
});
// --- API: MATCHLIST DATA DUMP ---
app.get('/api/debug-matchlist', async (req, res) => {
    const requestedTournament = req.query.tournament;
    const db = readDB();
    const tournament = db.tournaments.find(t => t.name === requestedTournament) || db.tournaments[0];

    if (!tournament || !tournament.matchlistUrl) return res.json({ error: "Geen toernooi of matchlist URL gevonden" });

    try {
        let mlRes = await axios.get(tournament.matchlistUrl).catch(() => axios.post(tournament.matchlistUrl, {}));
        res.send(mlRes.data); // Stuurt de letterlijke data naar je scherm
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.listen(PORT, () => console.log(`🎯 Server draait op http://localhost:${PORT}`));

// --- NIEUW: PUSH MELDINGEN OPVANGEN ---
self.addEventListener('push', function(event) {
    if (event.data) {
        const data = event.data.json();
        const options = {
            body: data.body,
            icon: '/icon-192x192.png',
            badge: '/icon-192x192.png',
            vibrate: [100, 50, 100],
            data: { url: '/' } // Waar gaan we heen als je erop klikt?
        };

        event.waitUntil(
            self.registration.showNotification(data.title, options)
        );
    }
});

self.addEventListener('notificationclick', function(event) {
    event.notification.close();
    event.waitUntil(
        clients.openWindow(event.notification.data.url)
    );
});
