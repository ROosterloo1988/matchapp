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
    if (!fs.existsSync(DB_FILE)) return { tournaments: [], subscriptions: [], notifiedMatches: [], notifiedPoules: [] };
    let db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    if (!db.tournaments) db.tournaments = [];
    if (!db.subscriptions) db.subscriptions = [];
    if (!db.notifiedMatches) db.notifiedMatches = [];
    if (!db.notifiedPoules) db.notifiedPoules = [];
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

app.get('/api/darters', (req, res) => {
    const db = readDB();
    const tournament = db.tournaments.find(t => t.name === req.query.tournament);
    res.json(tournament && tournament.darters ? tournament.darters : []);
});

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

    if (tournament && Array.isArray(players)) {
        existingSub.preferences[tournament] = players.map(p => p.toLowerCase());
    }
    
    writeDB(db);
    res.status(201).json({});
});

app.get('/api/settings', (req, res) => res.json(readDB()));
app.post('/api/settings', (req, res) => {
    const b64auth = (req.headers.authorization || '').split(' ')[1] || '';
    const [login, password] = Buffer.from(b64auth, 'base64').toString().split(':');
    if (login !== ADMIN_USER || password !== ADMIN_PASS) return res.status(401).send("Onbevoegd");

    writeDB(req.body);
    res.json({ success: true, message: "Instellingen opgeslagen!" });
});

app.get('/api/tournaments', (req, res) => {
    const publicTournaments = readDB().tournaments.filter(t => !t.unlisted);
    res.json(publicTournaments.map(t => t.name));
});

app.get('/api/tournaments/valid', (req, res) => {
    res.json(readDB().tournaments.map(t => t.name));
});

app.post('/api/user-add-tournament', async (req, res) => {
    const { name, url, darters } = req.body;
    const db = readDB();

    if (!db.tournaments.find(t => t.name === name)) {
        db.tournaments.push({ 
            name, url, matchlistUrl: "", darters, 
            unlisted: true 
        });
        writeDB(db);
    } else {
        let existingT = db.tournaments.find(t => t.name === name);
        if(existingT && existingT.unlisted) {
            darters.forEach(d => { if(!existingT.darters.includes(d)) existingT.darters.push(d); });
            writeDB(db);
        }
    }
    res.json({ success: true });
});

app.post('/api/fetch-players-preview', async (req, res) => {
    const { url } = req.body;
    try {
        const response = await axios.post(url, {});
        let dataContainer = response.data.payload || response.data || {};
        let spelers = new Set();

        function zoekNamen(obj) {
            if (obj && typeof obj === 'object') {
                if (obj.name) spelers.add(obj.name);
                Object.values(obj).forEach(val => zoekNamen(val));
            }
        }
        zoekNamen(dataContainer);
        res.json(Array.from(spelers));
    } catch (e) {
        res.status(500).json({ error: "Kon spelers niet ophalen" });
    }
});

let isFirstRun = true;

// --- DE CENTRALE DATA MOTOR ---
async function fetchMatchesForTournament(requestedTournament) {
    const db = readDB();
    const tournament = db.tournaments.find(t => t.name === requestedTournament);
    if (!tournament) return [];

    let rawMatches = [];
    let dcMatchesList = [];
    let spelersDict = {};

    try {
        let bracketUrls = tournament.url.split(',').map(u => u.trim()).filter(u => u !== "");
        
        for (let i = 0; i < bracketUrls.length; i++) {
            let bUrl = bracketUrls[i];
            let bracketType = "";
            
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
                
                let proBracketArray = dataContainer.proBracket || (dataContainer.bracketData && dataContainer.bracketData.proBracket);
                let bronMap = proBracketArray || dataContainer.bracketData || dataContainer;

                function bouwWoordenboek(obj) {
                    if (!obj || typeof obj !== 'object') return;
                    if (obj.name && (obj.dcid || obj.id || obj.player_id)) {
                        spelersDict[obj.dcid || obj.id || obj.player_id] = obj.name;
                    }
                    Object.values(obj).forEach(val => bouwWoordenboek(val));
                }
                bouwWoordenboek(dataContainer);

                let isStructural = Array.isArray(bronMap) && bronMap.length > 0 && Array.isArray(bronMap[0]);

                if (isStructural) {
                    bronMap.forEach((roundArray, rIndex) => {
                        let rName = "Ronde " + (rIndex + 1);
                        let matchCount = roundArray.length;
                        
                        if (matchCount === 32) rName = "Laatste 64";
                        else if (matchCount === 16) rName = "Laatste 32";
                        else if (matchCount === 8) rName = "Laatste 16";
                        else if (matchCount === 4) rName = "Kwartfinale";
                        else if (matchCount === 2) rName = "Halve Finale";
                        else if (matchCount === 1) rName = "Finale";

                        roundArray.forEach(m => {
                            if (!m || typeof m !== 'object') return;
                            if ('p1' in m || 'd1' in m) {
                                m._bron_url = bUrl;
                                m._bracket_type = bracketType;
                                m._tree_round = rName;
                                
                                if (m.bn) {
                                    m._custom_id = (rIndex + 1) + "-" + m.bn;
                                }
                                dcMatchesList.push(m);
                            }
                        });
                    });
                } else {
                    function zoekWedstrijden(obj, currentRound = "Ronde ?") {
                        if (!obj || typeof obj !== 'object') return;
                        if ('p1' in obj || 'd1' in obj) { 
                            obj._bron_url = bUrl;
                            obj._bracket_type = bracketType;
                            obj._tree_round = currentRound;
                            dcMatchesList.push(obj); 
                        } 
                        else { 
                            Object.keys(obj).forEach(key => {
                                let nextRound = currentRound;
                                if (typeof key === 'string' && isNaN(key) && key !== "proBracket" && key !== "bracketData" && key !== "matches" && key !== "payload") {
                                    nextRound = key;
                                }
                                zoekWedstrijden(obj[key], nextRound); 
                            });
                        }
                    }
                    zoekWedstrijden(bronMap);
                }

            } catch(e) { console.error("Fout bij Bracket URL:", bUrl); }
        }

        // --- AUTO-DETECT MATCHLIST URL ---
        let matchlistData = [];
        let mUrlsToFetch = new Set(); 

        bracketUrls.forEach(bUrl => {
            let eventMatch = bUrl.match(/\/event\/([^\/]+)/i);
            if (eventMatch) {
                mUrlsToFetch.add(`https://tv.dartconnect.com/api/event/${eventMatch[1]}/matches`);
            }
        });
        
        if (tournament.matchlistUrl) {
            tournament.matchlistUrl.split(',').map(u => u.trim()).filter(u => u !== "").forEach(u => mUrlsToFetch.add(u));
        }

        for (let mUrl of Array.from(mUrlsToFetch)) {
            try {
                let mlRes = await axios.get(mUrl).catch(() => axios.post(mUrl, {}));
                if (mlRes.data && mlRes.data.payload && mlRes.data.payload.completed) {
                    matchlistData = matchlistData.concat(mlRes.data.payload.completed);
                } else if (Array.isArray(mlRes.data)) {
                    matchlistData = matchlistData.concat(mlRes.data);
                }
            } catch(e) { console.error("Fout bij ophalen Auto-Matchlist URL:", mUrl); }
        }

        let alleRecaps = [];
        matchlistData.forEach(match => {
            if (match.mi && match.hc && match.ac) {
                alleRecaps.push({ id: match.mi, p1: match.hc.toLowerCase(), p2: match.ac.toLowerCase() });
            }
        });

        let rondeTellingen = {};
        dcMatchesList.forEach(m => {
            let matchId = (m._custom_id || m.match_id || m.id || "").toString();
            let rndMatch = matchId.match(/^(\d+)[_-]/);
            if (rndMatch) {
                let rndKey = m._bron_url + "_" + rndMatch[1]; 
                rondeTellingen[rndKey] = (rondeTellingen[rndKey] || 0) + 1;
            }
        });

        function getSpelerNaam(idOrArray) {
            if (!idOrArray) return "Onbekend";
            
            if (typeof idOrArray === 'string') {
                if (idOrArray.startsWith('W-')) return "Winnaar ID " + idOrArray.replace('W-','');
                if (idOrArray.startsWith('L-')) return "Verliezer ID " + idOrArray.replace('L-','');
                if (spelersDict[idOrArray]) return spelersDict[idOrArray];
                return isNaN(idOrArray) ? idOrArray : `Speler ${idOrArray}`;
            }

            if (Array.isArray(idOrArray)) {
                const validIds = idOrArray.filter(id => id && id !== -1);
                if (validIds.length === 0) return "Onbekend";
                return validIds.map(id => spelersDict[id] || `Speler ${id}`).join(" & ");
            }
            if (idOrArray === -1) return "Onbekend";
            return spelersDict[idOrArray] || `Speler ${idOrArray}`;
        }

        const dcConverted = dcMatchesList.map(m => {
            let matchId = m._custom_id || m.match_id || m.id || "";
            if (typeof matchId === 'number') matchId = matchId.toString();
            if (typeof matchId === 'string') matchId = matchId.replace(/_/g, '-');

            let rondeNaam = "Ronde ?";
            if (m.rn) rondeNaam = m.rn;
            else if (m.round_name) rondeNaam = m.round_name;
            else if (m.rName) rondeNaam = m.rName;
            else if (m._tree_round && m._tree_round !== "Ronde ?") rondeNaam = m._tree_round;
            else if (m._bracket_type === "Groepsfase") rondeNaam = "Groepsfase";
            else if (m.r && !isNaN(m.r)) rondeNaam = "Ronde " + m.r;

            if (m._bracket_type === "Groepsfase" && matchId) {
                let pouleMatch = matchId.match(/^([A-Za-z]+)\d+$/);
                if (pouleMatch) rondeNaam = "Poule " + pouleMatch[1].toUpperCase();
            }

            let rondeMatch = matchId.match(/^(\d+)-/);
            if (rondeMatch && rondeNaam === "Ronde ?") {
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

            let markerData = m.ch && m.ch.v ? m.ch.v : null;
            let markerNaam = "";
            if (Array.isArray(markerData) || typeof markerData === 'number') markerNaam = getSpelerNaam(markerData);
            else if (typeof markerData === 'string') markerNaam = markerData;

            return {
                id: matchId, 
                db_id: m.id ? m.id.toString() : "", 
                n: m.w || m.wn || m.n || m.next || m.winner_to, 
                p1m: m.p1_from || m.p1m || m.m1, 
                p2m: m.p2_from || m.p2m || m.m2, 
                raw_p1: m.p1 || m.d1, 
                raw_p2: m.p2 || m.d2, 
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
                isFinished: m.fn === true,
                _bracket_type: m._bracket_type
            };
        });

        rawMatches = rawMatches.concat(dcConverted);

        let pouleIndelingen = {}; 
        rawMatches.forEach(m => {
            if (m._bracket_type && m._bracket_type !== "Groepsfase" && !m.ronde.includes('(')) m.ronde += ` (${m._bracket_type})`;
            
            if (m.ronde.startsWith("Poule ") || m.ronde.startsWith("Group ")) {
                if (!pouleIndelingen[m.ronde]) pouleIndelingen[m.ronde] = new Set();
                if (m.player1 !== "Onbekend") pouleIndelingen[m.ronde].add(m.player1);
                if (m.player2 !== "Onbekend") pouleIndelingen[m.ronde].add(m.player2);
            }
        });

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

            let isBetrokken = isSpeler || isMarker;

            if (match.status === "gepland" && isBetrokken) {
                let isPoule = match.ronde.startsWith("Poule ") || match.ronde.startsWith("Group ");
                let hasTime = match.time && match.time.includes(':');

                if (isPoule && !hasTime && isSpeler) {
                    let pouleKey = `${tournament.name}_${isSpeler}_${match.ronde}`;
                    if (!db.notifiedPoules.includes(pouleKey)) {
                        db.notifiedPoules.push(pouleKey);
                        let spelersInPoule = Array.from(pouleIndelingen[match.ronde] || []);
                        let ik = spelersInPoule.find(p => p.toLowerCase().includes(isSpeler)) || isSpeler;
                        let anderen = spelersInPoule.filter(p => p !== ik);
                        
                        let titel = `📊 Poule Indeling Bekend!`;
                        let body = `${ik} is ingedeeld in ${match.ronde} met: ${anderen.join(', ')}`;
                        
                        if (!isFirstRun && db.subscriptions.length > 0) {
                            const payload = JSON.stringify({ title: titel, body: body });
                            let activeSubs = [];
                            await Promise.all(db.subscriptions.map(async (sub) => {
                                let wilHoren = false;
                                if (sub.preferences && sub.preferences[tournament.name]) {
                                    let gekozenSpelers = sub.preferences[tournament.name];
                                    if (gekozenSpelers.length > 0) {
                                        wilHoren = gekozenSpelers.some(filter => match.player1.toLowerCase().includes(filter) || match.player2.toLowerCase().includes(filter));
                                    }
                                }
                                if (wilHoren) {
                                    try {
                                        await webpush.sendNotification(sub, payload);
                                        activeSubs.push(sub);
                                    } catch (err) {
                                        if (err.statusCode !== 410 && err.statusCode !== 404) activeSubs.push(sub);
                                    }
                                } else {
                                    activeSubs.push(sub);
                                }
                            }));
                            if (db.subscriptions.length !== activeSubs.length) db.subscriptions = activeSubs;
                        }
                        nieuwGeplandCount++;
                    }
                } else if (!db.notifiedMatches.includes(match.id)) {
                    let stuurMelding = false;
                    let titel = "";

                    if (hasTime) {
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
                    } else if (!isPoule) {
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
                                let wilHoren = false;
                                if (sub.preferences && sub.preferences[tournament.name]) {
                                    let gekozenSpelers = sub.preferences[tournament.name];
                                    if (gekozenSpelers.length > 0) {
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
                                        if (err.statusCode !== 410 && err.statusCode !== 404) activeSubs.push(sub);
                                    }
                                } else {
                                    activeSubs.push(sub);
                                }
                            }));
                            if (db.subscriptions.length !== activeSubs.length) db.subscriptions = activeSubs;
                        }
                        nieuwGeplandCount++;
                    }
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

            if (magDoor && match.id) {
                let mogelijkeMatch = rawMatches.find(rm => {
                    if (rm._bron_url !== match._bron_url) return false;
                    
                    if (match.n && rm.db_id == match.n) return true;
                    if (match.db_id && rm.p1m && rm.p1m == match.db_id) return true;
                    if (match.db_id && rm.p2m && rm.p2m == match.db_id) return true;

                    if (match.db_id) {
                        if (rm.raw_p1 === "W-" + match.db_id || rm.raw_p1 == match.db_id) return true;
                        if (rm.raw_p2 === "W-" + match.db_id || rm.raw_p2 == match.db_id) return true;
                    }
                    
                    if (match.id.includes('-')) {
                        let parts = match.id.match(/^(\d+)-(\d+)$/);
                        if (parts && rm.id) {
                            let volgendeRonde = parseInt(parts[1]) + 1;
                            let volgendeMatchNr = Math.ceil(parseInt(parts[2]) / 2); 
                            let rmParts = rm.id.match(/^(\d+)-(\d+)$/);
                            if (rmParts && parseInt(rmParts[1]) === volgendeRonde && parseInt(rmParts[2]) === volgendeMatchNr) {
                                return true;
                            }
                        }
                    }
                    return false;
                });

                if (mogelijkeMatch) {
                    let isAlGeweest = mogelijkeMatch.isFinished === true || mogelijkeMatch.score1 !== "";
                    let uniekeVolgendeID = mogelijkeMatch._bron_url + "_" + mogelijkeMatch.id;
                    if (!toegevoegdeIds.has(uniekeVolgendeID) && !isAlGeweest) {
                        definitieveLijst.push({ ...mogelijkeMatch, isMogelijk: true, status: "mogelijk", mogelijkVoor: isSpeler, rol: "speler" });
                        toegevoegdeIds.add(uniekeVolgendeID);
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

app.post('/api/admin/send-push', async (req, res) => {
    const b64auth = (req.headers.authorization || '').split(' ')[1] || '';
    const [login, password] = Buffer.from(b64auth, 'base64').toString().split(':');
    if (login !== ADMIN_USER || password !== ADMIN_PASS) return res.status(401).send("Onbevoegd");

    const { title, body } = req.body;
    const db = readDB();

    if (!db.subscriptions || db.subscriptions.length === 0) {
        return res.status(400).json({ error: "Niemand heeft nog meldingen aan staan!" });
    }

    const payload = JSON.stringify({
        title: title || "🎯 DartApp Bericht",
        body: body || ""
    });

    let successCount = 0;
    let actieveAbonnees = []; 

    for (let sub of db.subscriptions) {
        try {
            await webpush.sendNotification(sub, payload);
            successCount++;
            actieveAbonnees.push(sub); 
        } catch (err) {
            if (err.statusCode === 410 || err.statusCode === 404) {
                console.log('App verwijderd door een gebruiker.');
            } else {
                actieveAbonnees.push(sub);
            }
        }
    }

    if (db.subscriptions.length !== actieveAbonnees.length) {
        db.subscriptions = actieveAbonnees;
        writeDB(db);
    }

    res.json({ success: true, message: `✅ Succes! Melding verstuurd naar ${successCount} actieve apparaten.` });
});

app.get('/api/test-push', async (req, res) => {
    const db = readDB();
    if (!db.subscriptions || db.subscriptions.length === 0) {
        return res.send("<h1>❌ Geen abonnees gevonden!</h1><p>Heb je wel ergens in de app op de groene 'Zet Meldingen Aan' knop geklikt?</p>");
    }

    const payload = JSON.stringify({
        title: "🎯 Over 10 minuten de volgende wedstrijd",
        body: "Paul Krohne tegen Heine Uuldriks\nBord: 201 | Tijd: 14:20"
    });

    let successCount = 0;
    for (let sub of db.subscriptions) {
        try {
            await webpush.sendNotification(sub, payload);
            successCount++;
        } catch (err) {
            console.log('Test push faalde:', err.message);
        }
    }

    res.send(`<h1>✅ Test Voltooid!</h1><p>Er is succesvol een melding gestuurd naar ${successCount} van de ${db.subscriptions.length} geabonneerde apparaten.</p>`);
});

async function runHeartbeat() {
    const db = readDB();
    if (db.tournaments.length === 0) return;
    
    console.log(`[HARTSLAG] Checkt ${db.tournaments.length} toernooien voor nieuwe wedstrijden...`);
    for (let t of db.tournaments) {
        await fetchMatchesForTournament(t.name);
    }
    
    if (isFirstRun) {
        isFirstRun = false;
        console.log("[HARTSLAG] Eerste run voltooid. Vanaf nu worden er meldingen verstuurd.");
    }
}

runHeartbeat();
setInterval(runHeartbeat, 60000);
app.listen(PORT, () => console.log(`🎯 Server draait op http://localhost:${PORT}`));
