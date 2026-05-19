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
    res.status(401).send('Inloggen verest voor beheer.');
});

app.use(express.static(path.join(__dirname, '../public')));

const DB_FILE = path.join(__dirname, 'database.json');

// --- DATABASE & PUSH SETUP (MET SUPERSNELLE MEMORY-CACHE!) ---
let memDB = null;

function readDB() {
    if (memDB) return memDB; 

    if (!fs.existsSync(DB_FILE)) {
        memDB = { tournaments: [], subscriptions: [], notifiedMatches: [], notifiedPoules: [] };
        return memDB;
    }
    
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
    
    memDB = db; 
    return memDB;
}

function writeDB(data) {
    memDB = data; 
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
        let spelers = new Set();

        function voegNaamToe(naam) {
            if (!naam || typeof naam !== 'string') return;
            const n = naam.trim();
            if (n.length >= 2) spelers.add(n);
        }

        function zoekNamen(obj) {
            if (obj && typeof obj === 'object') {
                if (obj.name) voegNaamToe(obj.name);
                if (obj.hc) voegNaamToe(obj.hc);
                if (obj.ac) voegNaamToe(obj.ac);
                if (obj.hcf) voegNaamToe(obj.hcf);
                if (obj.acf) voegNaamToe(obj.acf);
                if (obj.p1 && typeof obj.p1 === 'string') voegNaamToe(obj.p1);
                if (obj.p2 && typeof obj.p2 === 'string') voegNaamToe(obj.p2); 
                Object.values(obj).forEach(val => zoekNamen(val));
            }
        }

        async function probeerUrl(u) {
            try {
                const r = await axios.post(u, {}).catch(() => axios.get(u));
                const dataContainer = r.data?.payload || r.data || {};
                zoekNamen(dataContainer);
            } catch (_) {}
        }

        // 1) Originele bracket/poule URL
        await probeerUrl(url);

        // 2) Fallbacks op event-niveau (voor toernooien die nog niet gestart zijn)
        const eventMatch = String(url).match(/\/event\/([^\/\?]+)/i);
        if (eventMatch) {
            const eventId = eventMatch[1];
            const fallbackUrls = [
                `https://tv.dartconnect.com/api/event/${eventId}`,
                `https://tv.dartconnect.com/api/event/${eventId}/players`,
                `https://tv.dartconnect.com/event/${eventId}/state/players?fetch_type=initial`,
                `https://tv.dartconnect.com/event/${eventId}/state/matches?fetch_type=initial`
            ];

            for (const u of fallbackUrls) {
                if (spelers.size >= 8) break; // genoeg namen, niet onnodig doorvragen
                await probeerUrl(u);
            }
        }
        
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
                let eventName = (dataContainer.bracketData && dataContainer.bracketData.engname) || dataContainer.engname || "";
                if (isStructural && String(eventName).toLowerCase().includes("round robin")) {
                    isStructural = false;
                }

                let playerInitialMatchNr = {}; 

                if (isStructural) {
                    bronMap[0].forEach((m, mIndex) => {
                        if (!m || typeof m !== 'object') return;
                        let players = [];
                        if (m.d1) players = players.concat(m.d1);
                        if (m.d2) players = players.concat(m.d2);
                        if (m.p1) players = players.concat(m.p1);
                        if (m.p2) players = players.concat(m.p2);
                        
                        players.forEach(p => {
                            if (p !== null && p !== undefined && p !== -1) {
                                playerInitialMatchNr[p.toString()] = mIndex;
                            }
                        });
                    });

                    bronMap.forEach((roundArray, rIndex) => {
                        let rName = "Ronde " + (rIndex + 1);
                        let matchCount = roundArray.length;
                        
                        if (matchCount === 32) rName = "Laatste 64";
                        else if (matchCount === 16) rName = "Laatste 32";
                        else if (matchCount === 8) rName = "Laatste 16";
                        else if (matchCount === 4) rName = "Kwartfinale";
                        else if (matchCount === 2) rName = "Halve Finale";
                        else if (matchCount === 1) rName = "Finale";

                        roundArray.forEach((m, mIndex) => {
                            if (!m || typeof m !== 'object') return;
                            if ('p1' in m || 'd1' in m) {
                                m._bron_url = bUrl;
                                m._bracket_type = bracketType;
                                m._tree_round = rName;
                                m._tree_round_nr = rIndex + 1;
                                
                                let logicalMatchNr = -1;
                                let players = [];
                                if (m.d1) players = players.concat(m.d1);
                                if (m.d2) players = players.concat(m.d2);
                                if (m.p1) players = players.concat(m.p1);
                                if (m.p2) players = players.concat(m.p2);
                                
                                for (let p of players) {
                                    if (p !== null && p !== undefined && p !== -1 && playerInitialMatchNr[p.toString()] !== undefined) {
                                        logicalMatchNr = Math.floor(playerInitialMatchNr[p.toString()] / Math.pow(2, rIndex));
                                        break;
                                    }
                                }
                                
                                if (logicalMatchNr === -1 || isNaN(logicalMatchNr)) {
                                    logicalMatchNr = mIndex; 
                                }
                                
                                m._tree_match_nr = logicalMatchNr;
                                let safeMatchNr = isNaN(logicalMatchNr) ? mIndex : logicalMatchNr;
                                m._custom_id = (rIndex + 1) + "-" + (safeMatchNr + 1);

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

        let matchlistData = [];
        let mUrlsToFetch = new Set(); 

        bracketUrls.forEach(bUrl => {
            let eventMatch = bUrl.match(/\/event\/([^\/]+)/i);
            if (eventMatch) {
                // 🚀 SYNC VIA DE NIEUWE STATE API
                mUrlsToFetch.add(`https://tv.dartconnect.com/event/${eventMatch[1]}/state/matches?fetch_type=initial`);
                mUrlsToFetch.add(`https://tv.dartconnect.com/api/event/${eventMatch[1]}/matches`);
            }
        });
        
        if (tournament.matchlistUrl) {
            tournament.matchlistUrl.split(',').map(u => u.trim()).filter(u => u !== "").forEach(u => mUrlsToFetch.add(u));
        }

        for (let mUrl of Array.from(mUrlsToFetch)) {
            try {
                let mlRes = await axios.get(mUrl).catch(() => axios.post(mUrl, {}));
                if (mlRes.data) {
                    // VERTAAL-FIX: Zet de nieuwe State API data om naar de universele structuur die de app verwacht
                    if (mlRes.data.matches_live || mlRes.data.matches_completed) {
                        if (mlRes.data.matches_completed) {
                            Object.entries(mlRes.data.matches_completed).forEach(([k, c]) => {
                                let normalized = {
                                    mi: c.mi || k,
                                    hc: c.hc || c.p1,
                                    ac: c.ac || c.p2,
                                    hs: c.hs !== undefined ? c.hs : c.s1,
                                    as: c.as !== undefined ? c.as : c.s2,
                                    _is_completed_now: true,
                                    // Bewaar de extra goudmijntjes:
                                    sk: c.sk || "",
                                    hp5: c.hp5 || "",
                                    ap5: c.ap5 || "",
                                    m: c.m || "",
                                    hic: c.hic || "",
                                    aic: c.aic || "",
                                    bns: c.bns || ""
                                };
                                matchlistData.push(normalized);
                            });
                        }
                        if (mlRes.data.matches_live) {
                            Object.entries(mlRes.data.matches_live).forEach(([k, a]) => {
                                let normalized = {
                                    mi: a.mi || k,
                                    hc: a.hc || a.p1,
                                    ac: a.ac || a.p2,
                                    hs: a.hs !== undefined ? a.hs : a.s1,
                                    as: a.as !== undefined ? a.as : a.s2,
                                    _is_active_now: true,
                                    sk: a.sk || "",
                                    hp5: a.hp5 || "",
                                    ap5: a.ap5 || "",
                                    m: a.m || "",
                                    hic: a.hic || "",
                                    aic: a.aic || "",
                                    bns: a.bns || ""
                                };
                                matchlistData.push(normalized);
                            });
                        }
                    } 
                    else if (mlRes.data.payload) {
                        if (mlRes.data.payload.completed) {
                            mlRes.data.payload.completed.forEach(c => {
                                c._is_completed_now = true;
                                matchlistData.push(c);
                            });
                        }
                        if (mlRes.data.payload.active) {
                            mlRes.data.payload.active.forEach(a => {
                                a._is_active_now = true;
                                matchlistData.push(a);
                            });
                        }
                    } 
                    else if (Array.isArray(mlRes.data)) {
                        matchlistData = matchlistData.concat(mlRes.data);
                    }
                }
            } catch(e) { console.error("Fout bij ophalen Auto-Matchlist URL:", mUrl); }
        }

        let alleRecaps = [];
        let liveMatchDict = {}; 
        let liveMatchByNameDict = {};
        let activeScores = {}; 
        let activeStatuses = new Set(); 

        function cleanNameForMatching(str) {
            if (!str) return "";
            return String(str).toLowerCase()
                .normalize("NFD")
                .replace(/[\u0300-\u036f]/g, "")
                .replace(/[^a-z0-9\s]/g, "")
                .split(/\s+/)
                .filter(w => w.length > 0)
                .sort()
                .join("");
        }

        matchlistData.forEach(match => {
            let p1Name = match.hc || match.p1;
            let p2Name = match.ac || match.p2;

            if (match.mi && p1Name && p2Name) {
                alleRecaps.push({ id: match.mi.toString(), p1: p1Name, p2: p2Name });
            }
            
            if (match.mi) {
                liveMatchDict[match.mi.toString()] = match;
            }

            if (p1Name && p2Name) {
                let cleanP1 = cleanNameForMatching(p1Name);
                let cleanP2 = cleanNameForMatching(p2Name);
                liveMatchByNameDict[cleanP1 + "_" + cleanP2] = match;
                liveMatchByNameDict[cleanP2 + "_" + cleanP1] = match; 
            }

            let mogelijkeIds = [];
            if (match.mi) mogelijkeIds.push(match.mi.toString());
            if (match.match_id) mogelijkeIds.push(match.match_id.toString().replace(/_/g, '-'));

            mogelijkeIds.forEach(pId => {
                let s1Val = match.hs !== undefined ? match.hs : match.s1;
                let s2Val = match.as !== undefined ? match.as : match.s2;
                if (s1Val !== undefined && s1Val !== null && s2Val !== undefined && s2Val !== null) {
                    activeScores[pId] = { hs: s1Val, as: s2Val };
                }
                if (match._is_active_now) {
                    activeStatuses.add(pId);
                }
            });
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

            let dbId = m.id ? m.id.toString() : "";
            
            let p1Name = getSpelerNaam(m.d1 || m.p1);
            let p2Name = getSpelerNaam(m.d2 || m.p2);
            let targetP1 = cleanNameForMatching(p1Name);
            let targetP2 = cleanNameForMatching(p2Name);

            let actMatch = liveMatchDict[dbId];
            if (!actMatch && targetP1 !== "onbekend" && targetP2 !== "onbekend" && targetP1 !== "" && targetP2 !== "") {
                actMatch = liveMatchByNameDict[targetP1 + "_" + targetP2];
            }

            let fS1 = m.s1 !== null && m.s1 !== undefined ? m.s1 : "";
            let fS2 = m.s2 !== null && m.s2 !== undefined ? m.s2 : "";
            let isActive = activeStatuses.has(matchId) || activeStatuses.has(dbId);
            let detectedRecapId = "";
            let detectedWatchId = ""; 
            let isKlaarVolgensLiveLijst = false;

            // Extra velden initialiseren
            let avg1 = "";
            let avg2 = "";
            let writer = markerNaam; 
            let country1 = "";
            let country2 = "";

            if (actMatch) {
                let isSwapped = false;
                let mlAc = cleanNameForMatching(actMatch.ac || actMatch.p2 || "");
                if (targetP1 === mlAc) isSwapped = true;

                let s1Val = actMatch.hs !== undefined ? actMatch.hs : actMatch.s1;
                let s2Val = actMatch.as !== undefined ? actMatch.as : actMatch.s2;

                if (s1Val !== undefined && s1Val !== null && s2Val !== undefined && s2Val !== null) {
                    fS1 = isSwapped ? s2Val : s1Val;
                    fS2 = isSwapped ? s1Val : s2Val;
                }
                
                if (actMatch._is_active_now) isActive = true;
                if (actMatch._is_completed_now) isKlaarVolgensLiveLijst = true;
                if (actMatch.mi) detectedRecapId = actMatch.mi.toString();
                
                detectedWatchId = actMatch.sk || actMatch.tk || actMatch.tv || actMatch.spectatorKey || actMatch.key || "";
                
                // DATA EXTRAHEREN UIT DE GEVONDEN STATE API FORMAT:
                avg1 = isSwapped ? (actMatch.ap5 || "") : (actMatch.hp5 || "");
                avg2 = isSwapped ? (actMatch.hp5 || "") : (actMatch.ap5 || "");
                if (actMatch.m) writer = actMatch.m;
                country1 = isSwapped ? (actMatch.aic || "") : (actMatch.hic || "");
                country2 = isSwapped ? (actMatch.hic || "") : (actMatch.aic || "");
            }

            let isFinished = (m.fn === true || isKlaarVolgensLiveLijst);
            if (isActive) {
                isFinished = false; 
            }

            if (fS1 === null || fS1 === "null") fS1 = "";
            if (fS2 === null || fS2 === "null") fS2 = "";

            let finalBoard = m.bn || m.b || m.board || m.bd || "?";
            if ((finalBoard === "?" || !finalBoard) && actMatch && actMatch.bns) {
                finalBoard = actMatch.bns.toString();
            }

            return {
                id: matchId, 
                db_id: dbId, 
                n: m.w || m.wn || m.n || m.next || m.winner_to, 
                p1m: m.p1_from || m.p1m || m.m1, 
                p2m: m.p2_from || m.p2m || m.m2, 
                raw_p1: m.p1 || m.d1, 
                raw_p2: m.p2 || m.d2, 
                _bron_url: m._bron_url,
                ronde: rondeNaam,
                player1: p1Name,
                player2: p2Name,
                marker: markerNaam,
                score1: fS1,
                score2: fS2,
                _is_active: isActive, 
                _detected_recap_id: detectedRecapId,
                watchId: detectedWatchId,
                board: finalBoard,
                time: m.tm || m.t || m.time || m.st || "Niet bekend",
                toernooi: tournament.name,
                isFinished: isFinished,
                isBye: m.by === true, 
                _bracket_type: m._bracket_type,
                _tree_round_nr: m._tree_round_nr,
                _tree_match_nr: m._tree_match_nr,
                // DOORGEVEN NAAR FRONTEND:
                avg1: avg1,
                avg2: avg2,
                writer: writer,
                country1: country1,
                country2: country2
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
            if (match.isBye) return false;
            return dartersLower.some(d => match.player1.toLowerCase().includes(d) || match.player2.toLowerCase().includes(d) || (match.marker && match.marker.toLowerCase().includes(d)));
        });

        for (let match of eigenWedstrijden) {
            let hasScores = (match.score1 !== "" && match.score2 !== "");
            let isReallyActive = match._is_active || (!match.isFinished && hasScores); 
            
            match.status = match.isFinished ? "gespeeld" : (isReallyActive ? "bezig" : "gepland");
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
                            const payload = JSON.stringify({ title: titel, body: body, icon: '/icon-192x192.png', badge: '/icon-192x192.png' });
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
                                body: `${match.player1} tegen ${match.player2}\nBord: ${match.board} | Tijd: ${match.time}`,
                                icon: '/icon-192x192.png',
                                badge: '/icon-192x192.png'
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

            match.recapId = match._detected_recap_id || "";

            let isWalkover = (match.score1 === 'W' || match.score1 === 'X' || match.score1 === 'F' || match.score2 === 'W' || match.score2 === 'X' || match.score2 === 'F');

            if (isWalkover) {
                match.recapId = ""; 
            } else if (!match.recapId && (match.status === "gespeeld" || match.status === "bezig") && match.player1 !== "Onbekend" && match.player2 !== "Onbekend") {
                let bestRecapId = "";
                let bestScore = 0;

                alleRecaps.forEach(r => {
                    const getScore = (bName, rName) => {
                        let bWords = bName.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 2);
                        let rWords = rName.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 2);
                        if (bWords.length === 0 || rWords.length === 0) return 0;
                        let overlap = rWords.filter(rw => bWords.includes(rw)).length;
                        return overlap / rWords.length; 
                    };

                    let scoreA = getScore(match.player1, r.p1) + getScore(match.player2, r.p2);
                    let scoreB = getScore(match.player1, r.p2) + getScore(match.player2, r.p1);
                    let maxScore = Math.max(scoreA, scoreB);

                    if (maxScore > bestScore && maxScore >= 0.8) {
                        bestScore = maxScore;
                        bestRecapId = r.id;
                    }
                });

                if (bestRecapId) match.recapId = bestRecapId;
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
            let magDoor = isSpeler && ((match.status === "gepland") || (match.status === "bezig") || (match.status === "gespeeld" && match.resultaat === "win"));

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
                    
                    if (match._tree_round_nr !== undefined && match._tree_match_nr !== undefined && rm._tree_round_nr !== undefined && rm._tree_match_nr !== undefined) {
                        let volgendeRonde = match._tree_round_nr + 1;
                        let volgendeMatchNr = Math.floor(match._tree_match_nr / 2); 
                        if (rm._tree_round_nr === volgendeRonde && rm._tree_match_nr === volgendeMatchNr) {
                            return true;
                        }
                    }

                    if (match.id.includes('-') && match._tree_round_nr === undefined) {
                        let parts = match.id.match(/^(\d+)-(\d+)$/);
                        if (parts && rm.id) {
                            let volgendeRonde = parseInt(parts[1]) + 1;
                            let volgendeMatchNr = Math.ceil(parseInt(parts[2]) / 2); 
                            let rmParts = rm.id.match(/^(\d+)-(\d+)$/);
                            if (rmParts && parseInt(rmParts[1]) === siguiendoRonde && parseInt(rmParts[2]) === volgendeMatchNr) {
                                return true;
                            }
                        }
                    }
                    return false;
                });

                if (mogelijkeMatch) {
                    let isAlGeweest = mogelijkeMatch.isFinished === true || mogelijkeMatch.score1 !== "";
                    let uniekeVolgendeID = mogelijkeMatch._bron_url + "_" + mogelijkeMatch.id;
                    
                    let heeftAlEchteMatchInDezeRonde = definitieveLijst.some(m => 
                        m.status !== "mogelijk" && 
                        m.ronde === mogelijkeMatch.ronde && 
                        (m.player1.toLowerCase().includes(isSpeler.toLowerCase()) || m.player2.toLowerCase().includes(isSpeler.toLowerCase()))
                    );

                    if (!toegevoegdeIds.has(uniekeVolgendeID) && !isAlGeweest && !heeftAlEchteMatchInDezeRonde) {
                        definitieveLijst.push({ ...mogelijkeMatch, isMogelijk: true, status: "mogelijk", mogelijkVoor: isSpeler, rol: "speler" });
                        toegevoegdeIds.add(uniekeVolgendeID);
                    }
                }
            }
        });

        // --- JOUW ORIGINELE PERFECTE TIJDLIJN SORTERING ---
        definitieveLijst.sort((a, b) => {
            const volgorde = { "bezig": 1, "gepland": 2, "mogelijk": 3, "gespeeld": 4 };
            if (volgorde[a.status] !== volgorde[b.status]) return volgorde[a.status] - volgorde[b.status];
            
            const getNumericTime = (timeStr) => {
                if (!timeStr || ["Onbekend", "Niet bekend", "Later"].includes(timeStr)) return 24;
                let parts = timeStr.split(':');
                if (parts.length === 2) {
                    return parseInt(parts[0], 10) + (parseInt(parts[1], 10) / 60);
                }
                return 24;
            };

            let tA = getNumericTime(a.time);
            let tB = getNumericTime(b.time);
            
            let rA = a._tree_round_nr || (a.id ? (parseInt(a.id.split('-')[0]) || 0) : 0);
            let rB = b._tree_round_nr || (b.id ? (parseInt(b.id.split('-')[0]) || 0) : 0);

            if (tA < 12 && rA >= 5) tA += 24;
            if (tB < 12 && rB >= 5) tB += 24;

            let timelineIdxA = (tA * 100) + (rA * 10);
            let timelineIdxB = (tB * 100) + (rB * 10);

            if (a.status === "gespeeld") {
                return (timelineIdxB - timelineIdxA) || ((parseInt(b.board) || 999) - (parseInt(a.board) || 999));
            } else {
                return (timelineIdxA - timelineIdxB) || ((parseInt(a.board) || 999) - (parseInt(b.board) || 999));
            }
        });

        return definitieveLijst;

    } catch (error) {
        console.error("Fout:", error.message);
        return [];
    }
}

let matchCache = {};
let cacheTimestamps = {};

app.get('/api/matches', async (req, res) => {
    const tName = req.query.tournament;
    
    if (matchCache[tName] && cacheTimestamps[tName] && (Date.now() - cacheTimestamps[tName] < 10000)) {
        return res.json(matchCache[tName]);
    }
    
    const list = await fetchMatchesForTournament(tName);
    matchCache[tName] = list;
    cacheTimestamps[tName] = Date.now();
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
        body: body || "",
        icon: '/icon-192x192.png',
        badge: '/icon-192x192.png'
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
                console.log('App verwerkt door een gebruiker.');
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
        body: "Paul Krohne tegen Heine Uuldriks\\nBord: 201 | Tijd: 14:20",
        icon: '/icon-192x192.png',
        badge: '/icon-192x192.png'
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
    
    for (let t of db.tournaments) {
        const nieuwLijstje = await fetchMatchesForTournament(t.name);
        matchCache[t.name] = nieuwLijstje;
        cacheTimestamps[t.name] = Date.now();
    }
    
    if (isFirstRun) {
        isFirstRun = false;
        console.log("[HARTSLAG] Eerste run voltooid. Geheugen is vol, app is nu supersnel.");
    }
}

runHeartbeat();
setInterval(runHeartbeat, 60000);
app.listen(PORT, () => console.log(`🎯 Server draait op http://localhost:${PORT}`));
