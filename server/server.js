const express = require('express');
const cors = require('cors');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const webpush = require('web-push');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());

// --- ADMIN BEVEILIGING (BASIC AUTH) ---
const ADMIN_USER = "matchapp";
const ADMIN_PASS = "dutchopen2026"; 

app.use('/admin.html', (req, res, next) => {
    const b64auth = (req.headers.authorization || '').split(' ')[1] || '';
    const [login, password] = Buffer.from(b64auth, 'base64').toString().split(':');

    if (login && password && login === ADMIN_USER && password === ADMIN_PASS) {
        return next(); 
    }

    res.set('WWW-Authenticate', 'Basic realm="Admin Area"');
    res.status(401).send('Inloggen vereist voor beheer.');
});

app.use(express.static(path.join(__dirname, '../public')));

const DB_FILE = path.join(__dirname, 'database.json');

// --- DATABASE & PUSH SETUP ---
function readDB() {
    if (!fs.existsSync(DB_FILE)) return { tournaments: [], subscriptions: [], notifiedMatches: [] };
    let db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    if (!db.tournaments) db.tournaments = [];
    if (!db.subscriptions) db.subscriptions = [];
    if (!db.notifiedMatches) db.notifiedMatches = []; 
    db.tournaments.forEach(t => { if (!t.darters) t.darters = []; });
    
    if (!db.vapidKeys) {
        db.vapidKeys = webpush.generateVAPIDKeys();
        fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
    }
    return db;
}

function writeDB(data) {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

const initialDb = readDB();
webpush.setVapidDetails(
    'mailto:jouw@email.nl',
    initialDb.vapidKeys.publicKey,
    initialDb.vapidKeys.privateKey
);

app.get('/api/vapidPublicKey', (req, res) => res.send(readDB().vapidKeys.publicKey));

// --- NIEUW: Spelers ophalen voor de push-vinkjes ---
app.get('/api/darters', (req, res) => {
    const db = readDB();
    const tournament = db.tournaments.find(t => t.name === req.query.tournament);
    res.json(tournament && tournament.darters ? tournament.darters : []);
});

// --- GEÜPDATE: Slaat voorkeuren per toernooi op! ---
app.post('/api/subscribe', (req, res) => {
    const { subscription, tournament, players } = req.body;
    const db = readDB();
    
    let existingSub = db.subscriptions.find(sub => sub.endpoint === subscription.endpoint);
    
    if (!existingSub) {
        existingSub = subscription;
        existingSub.preferences = {}; 
        db.subscriptions.push(existingSub);
    } else {
        if (!existingSub.preferences) existingSub.preferences = {};
    }

    // Sla de gekozen spelers in kleine letters op onder de naam van dit specifieke toernooi
    if (tournament && Array.isArray(players)) {
        existingSub.preferences[tournament] = players.map(p => p.toLowerCase());
    }
    
    writeDB(db);
    res.status(201).json({});
});

app.get('/api/settings', (req, res) => res.json(readDB()));
app.post('/api/settings', (req, res) => {
    writeDB(req.body);
    res.json({ success: true, message: "Instellingen opgeslagen!" });
});

app.get('/api/tournaments', (req, res) => {
    res.json(readDB().tournaments.map(t => t.name));
});

let isFirstRun = true;

// --- DE CENTRALE DATA MOTOR ---
async function fetchMatchesForTournament(requestedTournament) {
    const db = readDB();
    const tournament = db.tournaments.find(t => t.name === requestedTournament);
    if (!tournament) return [];

    let rawMatches = [];
    let matchlistData = [];
    let spelersDict = {};
    let matchesList = [];

    try {
        let bracketUrls = tournament.url.split(',').map(u => u.trim()).filter(u => u !== "");
        
        for (let i = 0; i < bracketUrls.length; i++) {
            let bUrl = bracketUrls[i];
            let bracketType = "";
            
            // Labels voor Winnaars en Verliezersronde
            if (bracketUrls.length === 3) {
                if (i === 0) bracketType = "Groepsfase";
                if (i === 1) bracketType = "WR";
                if (i === 2) bracketType = "VR";
            } else if (bracketUrls.length === 2) {
                if (i === 0) bracketType = "Groepsfase";
                if (i === 1) bracketType = "Knockout";
            }

            try {
                const response = await axios.post(bUrl, {});
                let dataContainer = response.data.payload || response.data || {};
                let bronMap = dataContainer.proBracket || dataContainer.bracketData || dataContainer;

                function bouwWoordenboek(obj) {
                    if (!obj || typeof obj !== 'object') return;
                    if (obj.name && (obj.dcid || obj.id || obj.player_id)) {
                        spelersDict[obj.dcid || obj.id || obj.player_id] = obj.name;
                    }
                    Object.values(obj).forEach(val => bouwWoordenboek(val));
                }
                bouwWoordenboek(dataContainer);

                function zoekWedstrijden(obj) {
                    if (!obj || typeof obj !== 'object') return;
                    if ('p1' in obj || 'd1' in obj) { 
                        obj._bron_url = bUrl; 
                        obj._bracket_type = bracketType;
                        matchesList.push(obj); 
                    } 
                    else { Object.values(obj).forEach(val => zoekWedstrijden(val)); }
                }
                zoekWedstrijden(bronMap);
            } catch(e) { console.error("Fout bij Bracket URL:", bUrl); }
        }

        if (tournament.matchlistUrl) {
            let mUrls = tournament.matchlistUrl.split(',').map(u => u.trim()).filter(u => u !== "");
            for (let mUrl of mUrls) {
                try {
                    let mlRes = await axios.get(mUrl).catch(() => axios.post(mUrl, {}));
                    if (mlRes.data && mlRes.data.payload && mlRes.data.payload.completed) {
                        matchlistData = matchlistData.concat(mlRes.data.payload.completed);
                    } else if (Array.isArray(mlRes.data)) {
                        matchlistData = matchlistData.concat(mlRes.data);
                    }
                } catch(e) { console.error("Fout bij Matchlist URL:", mUrl); }
            }
        }

        let alleRecaps = [];
        matchlistData.forEach(match => {
            if (match.mi && match.hc && match.ac) {
                alleRecaps.push({ id: match.mi, p1: match.hc.toLowerCase(), p2: match.ac.toLowerCase() });
            }
        });

        let rondeTellingen = {};
        matchesList.forEach(m => {
            let matchId = (m.id || m.match_id || "").toString();
            let rndMatch = matchId.match(/^(\d+)[_-]/);
            if (rndMatch) {
                let rndKey = m._bron_url + "_" + rndMatch[1]; 
                rondeTellingen[rndKey] = (rondeTellingen[rndKey] || 0) + 1;
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

            let rondeNaam = m._bracket_type === "Groepsfase" ? "Groepsfase" : "Ronde ?";

            // --- NIEUW: Poule letters detecteren (bijv. ID: "C5" -> "Poule C") ---
            if (m._bracket_type === "Groepsfase" && matchId) {
                let pouleMatch = matchId.match(/^([A-Za-z]+)\d+$/);
                if (pouleMatch) {
                    rondeNaam = "Poule " + pouleMatch[1].toUpperCase();
                }
            }

            let rondeMatch = matchId.match(/^(\d+)-/);
            if (rondeMatch) {
                    let rndKey = m._bron_url + "_" + rondeMatch[1];
                    let aW = rondeTellingen[rndKey];
                    if (aW === 1) rondeNaam = "Finale";
                    else if (aW === 2) rondeNaam = "Halve Finale";
                    else if (aW === 4) rondeNaam = "Kwartfinale";
                    else if (aW === 8) rondeNaam = "Laatste 16";
                    else if (aW === 16) rondeNaam = "Laatste 32";
                    else if (aW === 32) rondeNaam = "Laatste 64";
                    else rondeNaam = "Ronde " + rondeMatch[1];
                }

                // PLAK DE BRACKET NAAM ERACHTER (BEHALVE BIJ GROEPEN)
                if (m._bracket_type && m._bracket_type !== "Groepsfase" && m._bracket_type !== "") {
                    rondeNaam += ` (${m._bracket_type})`;
                }

                let markerData = m.ch && m.ch.v ? m.ch.v : null;
                let markerNaam = "";
                if (Array.isArray(markerData) || typeof markerData === 'number') markerNaam = getSpelerNaam(markerData);
                else if (typeof markerData === 'string') markerNaam = markerData;

                return {
                    id: matchId,
                    _bron_url: m._bron_url,
                    ronde: rondeNaam,
                    player1: getSpelerNaam(m.d1 || m.p1),
                    player2: getSpelerNaam(m.d2 || m.p2),
                    marker: markerNaam,
                    score1: m.s1 !== null && m.s1 !== undefined ? m.s1 : "",
                    score2: m.s2 !== null && m.s2 !== undefined ? m.s2 : "",
                    board: m.bn || m.b || m.board || m.bd || "?",
                    time: m.tm || m.t || m.time || m.st || "Niet bekend",
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

        for (let match of eigenWedstrijden) {
            match.status = (match.isFinished || (match.score1 !== "" && match.score2 !== "")) ? "gespeeld" : "gepland";
            match.isMogelijk = false;
            
            let isSpeler = dartersLower.find(d => match.player1.toLowerCase().includes(d) || match.player2.toLowerCase().includes(d));
            let isMarker = dartersLower.find(d => match.marker && match.marker.toLowerCase().includes(d));

            if (!isSpeler && isMarker && match.status === "gespeeld") continue; 

            match.rol = (!isSpeler && isMarker) ? "marker" : "speler";

            // --- PUSH MELDING LOGICA MET DE CHECKBOX FILTERS ---
            let isBetrokken = isSpeler || isMarker;

            if (match.status === "gepland" && isBetrokken && !db.notifiedMatches.includes(match.id)) {
                let stuurMelding = false;
                let titel = "";

                if (match.time && match.time.includes(':')) {
                    let parts = match.time.split(':');
                    let amsterdamTime = new Date().toLocaleString("en-US", {timeZone: "Europe/Amsterdam"});
                    let amsDate = new Date(amsterdamTime);
                    let currentTotalMins = (amsDate.getHours() * 60) + amsDate.getMinutes();
                    let matchTotalMins = (parseInt(parts[0], 10) * 60) + parseInt(parts[1], 10);
                    let timeDiff = matchTotalMins - currentTotalMins;
                    if (timeDiff < -1000) timeDiff += 1440; 
                    
                    if (timeDiff <= 10 && timeDiff >= 0) {
                        stuurMelding = true;
                        titel = "🎯 Over 10 minuten de volgende wedstrijd";
                    }
                } else {
                    stuurMelding = true;
                    titel = "🎯 Nieuwe wedstrijd gepland!";
                }

                if (stuurMelding) {
                    db.notifiedMatches.push(match.id);
                    
                    if (!isFirstRun && db.subscriptions.length > 0) {
                        if (!isSpeler && isMarker) titel += " (SCHRIJVEN)";

                        const payload = JSON.stringify({
                            title: titel,
                            body: `${match.player1} tegen ${match.player2}\nBord: ${match.board} | Tijd: ${match.time}`
                        });
                        
                        let activeSubs = [];
                        
                        await Promise.all(db.subscriptions.map(async (sub) => {
                            // CONTROLE: Hee, wil deze telefoon de push voor dit toernooi eigenlijk wel?
                            let wilHoren = false;
                            
                            // Check of de telefoon in dít toernooi vinkjes heeft gezet
                            if (sub.preferences && sub.preferences[tournament.name]) {
                                let gekozenSpelers = sub.preferences[tournament.name];
                                if (gekozenSpelers.length > 0) {
                                    // Ja! Zit de speler van deze wedstrijd in zijn lijstje?
                                    wilHoren = gekozenSpelers.some(filter => 
                                        match.player1.toLowerCase().includes(filter) || 
                                        match.player2.toLowerCase().includes(filter) || 
                                        (match.marker && match.marker.toLowerCase().includes(filter))
                                    );
                                }
                            }

                            if (wilHoren) {
                                try {
                                    await webpush.sendNotification(sub, payload);
                                    activeSubs.push(sub);
                                } catch (err) {
                                    if (err.statusCode !== 410 && err.statusCode !== 404) {
                                        activeSubs.push(sub);
                                    }
                                }
                            } else {
                                // Wil 'm niet horen, maar het abonnement is nog wel actief!
                                activeSubs.push(sub);
                            }
                        }));
                        
                        if (db.subscriptions.length !== activeSubs.length) {
                            db.subscriptions = activeSubs;
                        }
                    }
                    nieuwGeplandCount++;
                }
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

            let uniekeMatchID = match._bron_url + "_" + match.id;
            definitieveLijst.push(match);
            toegevoegdeIds.add(uniekeMatchID);
        }

        if (nieuwGeplandCount > 0) writeDB(db);

        eigenWedstrijden.forEach(match => {
            let isSpeler = tournament.darters.find(d => (match.player1 && match.player1.toLowerCase().includes(d.toLowerCase())) || (match.player2 && match.player2.toLowerCase().includes(d.toLowerCase())));
            let magDoor = isSpeler && ((match.status === "gepland") || (match.status === "gespeeld" && match.resultaat === "win"));

            if (magDoor && match.id && match.id.includes('-')) {
                let matchRegex = match.id.match(/^(\d+)-(\d+)$/);
                if (matchRegex) {
                    let nextId = (parseInt(matchRegex[1]) + 1) + "-" + Math.ceil(parseInt(matchRegex[2]) / 2); 
                    let mogelijkeMatch = rawMatches.find(rm => rm.id === nextId && rm._bron_url === match._bron_url);

                    if (mogelijkeMatch) {
                        let isAlGeweest = mogelijkeMatch.isFinished === true || mogelijkeMatch.score1 !== "";
                        let uniekeVolgendeID = mogelijkeMatch._bron_url + "_" + mogelijkeMatch.id;
                        if (!toegevoegdeIds.has(uniekeVolgendeID) && !isAlGeweest) {
                            definitieveLijst.push({ ...mogelijkeMatch, isMogelijk: true, status: "mogelijk", mogelijkVoor: isSpeler, rol: "speler" });
                            toegevoegdeIds.add(uniekeVolgendeID);
                        }
                    }
                }
            }
        });

        definitieveLijst.sort((a, b) => {
            const volgorde = { "gepland": 1, "mogelijk": 2, "gespeeld": 3 };
            if (volgorde[a.status] !== volgorde[b.status]) return volgorde[a.status] - volgorde[b.status];
            
            let tijdA = (a.time && !["Onbekend", "Niet bekend", "Later"].includes(a.time)) ? a.time : "24:00";
            let tijdB = (b.time && !["Onbekend", "Niet bekend", "Later"].includes(b.time)) ? b.time : "24:00";
            let rondeA = a.id ? (parseInt(a.id.split('-')[0]) || 0) : 0;
            let rondeB = b.id ? (parseInt(b.id.split('-')[0]) || 0) : 0;

            if (a.status === "gespeeld") {
                return tijdB.localeCompare(tijdA) || (rondeB - rondeA) || ((parseInt(b.board) || 999) - (parseInt(a.board) || 999));
            } else {
                return tijdA.localeCompare(tijdB) || (rondeA - rondeB) || ((parseInt(a.board) || 999) - (parseInt(b.board) || 999));
            }
        });

        return definitieveLijst;

    } catch (error) {
        console.error("Fout:", error.message);
        return [];
    }
}

app.get('/api/matches', async (req, res) => {
    const list = await fetchMatchesForTournament(req.query.tournament);
    res.json(list);
});

// --- ADMIN: HANDMATIGE PUSH MELDING VERSTUREN ---
// (Deze negeert de nieuwe filters en stuurt je omroepbericht naar IEDEREEN)
app.post('/api/admin/send-push', async (req, res) => {
    const b64auth = (req.headers.authorization || '').split(' ')[1] || '';
    const [login, password] = Buffer.from(b64auth, 'base64').toString().split(':');
    if (login !== ADMIN_USER || password !== ADMIN_PASS) return res.status(401).send("Onbevoeg
