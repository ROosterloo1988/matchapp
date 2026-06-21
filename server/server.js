const express = require('express');
const cors = require('cors');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const webpush = require('web-push');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

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

const systemStatus = {
    startedAt: new Date().toISOString(),
    poule: { lastSuccessAt: null, lastErrorAt: null, lastErrorMessage: null, staleServedCount: 0, lastDurationMs: null },
    matches: { cacheHits: 0, cacheMisses: 0, lastFetchAt: null, lastDurationMs: null },
    push: { lastSuccessAt: null, lastErrorAt: null, lastErrorMessage: null, lastSuccessCount: 0, lastFailureCount: 0 },
    recentErrors: []
};

function addSystemError(scope, message) {
    const entry = { at: new Date().toISOString(), scope, message: String(message || 'onbekende fout') };
    systemStatus.recentErrors.unshift(entry);
    if (systemStatus.recentErrors.length > 20) systemStatus.recentErrors.length = 20;
}

const DB_FILE = path.join(__dirname, 'database.json');

// --- DATABASE & PUSH SETUP (MET SUPERSNELLE MEMORY-CACHE!) ---
let memDB = null;

function readDB() {
    if (memDB) return memDB; 

    if (!fs.existsSync(DB_FILE)) {
        memDB = { tournaments: [], subscriptions: [], notifiedMatches: {}, notifiedPoules: {}, notifiedResults: {} };
        return memDB;
    }
    
    let db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    if (!db.tournaments) db.tournaments = [];
    if (!db.subscriptions) db.subscriptions = [];
    if (!db.notifiedMatches) db.notifiedMatches = {};
    if (!db.notifiedPoules) db.notifiedPoules = {};
    if (!db.notifiedResults) db.notifiedResults = {};
    db.tournaments.forEach(t => { if (!t.darters) t.darters = []; });

    // Migrate legacy array format to per-subscription object format
    if (Array.isArray(db.notifiedMatches)) {
        const endpoints = db.subscriptions.map(s => s.endpoint);
        const obj = {};
        db.notifiedMatches.forEach(id => { obj[id] = [...endpoints]; });
        db.notifiedMatches = obj;
    }
    if (Array.isArray(db.notifiedPoules)) {
        const endpoints = db.subscriptions.map(s => s.endpoint);
        const obj = {};
        db.notifiedPoules.forEach(key => { obj[key] = [...endpoints]; });
        db.notifiedPoules = obj;
    }
    
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

app.get('/api/settings', (req, res) => {
    const db = readDB();
    // Stuur alleen het gedeelte dat de admin nodig heeft, niet de grote runtime-data
    res.json({ tournaments: db.tournaments, vapidKeys: db.vapidKeys });
});
app.post('/api/settings', (req, res) => {
    const b64auth = (req.headers.authorization || '').split(' ')[1] || '';
    const [login, password] = Buffer.from(b64auth, 'base64').toString().split(':');
    if (login !== ADMIN_USER || password !== ADMIN_PASS) return res.status(401).send("Onbevoegd");

    const db = readDB();
    if (Array.isArray(req.body.tournaments)) db.tournaments = req.body.tournaments;
    writeDB(db);
    res.json({ success: true, message: "Instellingen opgeslagen!" });
});

app.get('/api/tournaments', (req, res) => {
    const publicTournaments = readDB().tournaments.filter(t => !t.unlisted);
    res.json(publicTournaments.map(t => t.name));
});

app.get('/api/tournaments/valid', (req, res) => {
    res.json(readDB().tournaments.map(t => t.name));
});


app.get('/api/tournament-config', (req, res) => {
    const db = readDB();
    const tournament = db.tournaments.find(t => t.name === req.query.tournament);

    if (!tournament) {
        return res.status(404).json({ error: 'Toernooi niet gevonden.' });
    }

    const urls = (tournament.url || '').split(',').map(u => u.trim()).filter(Boolean);
    const hasRoundRobin = urls.some(u => u.includes('/round-robin/'));
    const likelyPouleAsFirstBracket = urls.length >= 2 && urls[0].includes('/bracket/');

    res.json({
        name: tournament.name,
        url: tournament.url || '',
        darters: Array.isArray(tournament.darters) ? tournament.darters : [],
        unlisted: !!tournament.unlisted,
        hasPoulePhase: hasRoundRobin || likelyPouleAsFirstBracket
    });
});

app.post('/api/user-add-tournament', async (req, res) => {
    const { name, url, darters } = req.body;
    const db = readDB();

    const existingT = db.tournaments.find(t => t.name === name);
    if (!existingT) {
        db.tournaments.push({
            name, url, matchlistUrl: "", darters,
            unlisted: true
        });
        writeDB(db);
    } else {
        // Voeg ontbrekende spelers toe, case-insensitief vergelijken om duplicaten te voorkomen
        const bestaandeLower = existingT.darters.map(d => d.toLowerCase());
        darters.forEach(d => {
            if (!bestaandeLower.includes(d.toLowerCase())) {
                existingT.darters.push(d);
                bestaandeLower.push(d.toLowerCase());
            }
        });
        writeDB(db);
    }
    res.json({ success: true });
});

// --- DE VERNIEUWDE SPELER PREVIEW (MET FALLBACK VOOR ONGEPLANDE TOERNOOIEN) ---
app.post('/api/fetch-players-preview', async (req, res) => {
    const { url } = req.body;
    let spelers = new Set();

    function zoekNamen(obj) {
        if (obj && typeof obj === 'object') {
            if (obj.name) spelers.add(obj.name);
            if (obj.full_name) spelers.add(obj.full_name); // Check voor de pre-draw API
            Object.values(obj).forEach(val => zoekNamen(val));
        }
    }

    try {
        const response = await axios.post(url, {});
        let dataContainer = response.data.payload || response.data || {};
        zoekNamen(dataContainer);
    } catch (e) {
        console.error("Fout bij ophalen spelers via standaard URL:", url);
    }

    // SLIM REDMIDDEL: Als er nog geen loting is (0 spelers gevonden)
    if (spelers.size === 0 && url) {
        // Haal het tournament id en event id uit de standaard bracket link
        let match = url.match(/\/api\/event\/([^\/]+)\/(?:bracket|round-robin)\/(\d+)/i);
        if (match) {
            let tName = match[1];
            let eId = match[2];
            let fallbackUrl = `https://tv.dartconnect.com/api/event/${tName}/confirmation/${eId}/players`;
            
            try {
                console.log("Geen loting gevonden. Fallback inschakelen:", fallbackUrl);
                const fallbackResponse = await axios.post(fallbackUrl, {});
                let fallbackData = fallbackResponse.data.payload || fallbackResponse.data || {};
                zoekNamen(fallbackData);
            } catch (err) {
                console.error("Fout bij ophalen spelers via fallback URL:", fallbackUrl);
            }
        }
    }

    if (spelers.size > 0) {
        res.json(Array.from(spelers));
    } else {
        res.status(500).json({ error: "Geen spelers gevonden. Controleer de URL of de status van het toernooi." });
    }
});

let isFirstRun = true;

// --- DE CENTRALE DATA MOTOR ---
async function fetchMatchesForTournament(requestedTournament, extraDarters = []) {
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
                    if (obj.full_name && (obj.dcid || obj.id || obj.player_id)) {
                        spelersDict[obj.dcid || obj.id || obj.player_id] = obj.full_name; // Fallback integratie
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

                    // Bepaal bracket-grootte op basis van de eerste ronde (inclusief nulls/byes)
                    const eersteRondeGrootte = bronMap[0] ? bronMap[0].length : 0;

                    bronMap.forEach((roundArray, rIndex) => {
                        let spelersOverig = eersteRondeGrootte * 2 / Math.pow(2, rIndex);
                        let rName;
                        if (spelersOverig === 2) rName = "Finale";
                        else if (spelersOverig === 4) rName = "Halve Finale";
                        else if (spelersOverig === 8) rName = "Kwartfinale";
                        else if (spelersOverig > 8) rName = "Laatste " + Math.round(spelersOverig);
                        else rName = "Ronde " + (rIndex + 1);

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
                    if (mlRes.data.matches_live || mlRes.data.matches_completed) {
                        if (mlRes.data.matches_completed) {
                            Object.entries(mlRes.data.matches_completed).forEach(([k, c]) => {
                                c._is_completed_now = true;
                                if (!c.mi && !c.match_id) c.mi = k; 
                                matchlistData.push(c);
                            });
                        }
                        if (mlRes.data.matches_live) {
                            Object.entries(mlRes.data.matches_live).forEach(([k, a]) => {
                                a._is_active_now = true;
                                if (!a.mi && !a.match_id) a.mi = k;
                                matchlistData.push(a);
                            });
                        }
                    } 
                    else if (mlRes.data.payload) {
                        if (mlRes.data.payload.completed) {
                            let compArr = mlRes.data.payload.completed;
                            compArr.forEach(c => c._is_completed_now = true); 
                            matchlistData = matchlistData.concat(compArr);
                        }
                        if (mlRes.data.payload.active) {
                            let activeArr = mlRes.data.payload.active;
                            activeArr.forEach(a => a._is_active_now = true); 
                            matchlistData = matchlistData.concat(activeArr);
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
        let bmiScopedDict = {}; // keyed op "${ei}_${bmi}" om conflicten tussen disciplines te voorkomen
        let activeScores = {};
        let activeStatuses = new Set();

        function cleanNameForMatching(str) {
            if (!str) return "";
            return String(str).toLowerCase()
                .normalize("NFD")
                .replace(/<[^>]*>?/gm, " ")
                .replace(/[\u0300-\u036f]/g, "")
                .replace(/[^a-z0-9\s]/g, " ")
                .split(/\s+/)
                .filter(w => w.length > 0)
                .sort()
                .join("");
        }

        matchlistData.forEach(match => {
            // 1. Zeker weten dat de actieve status klopt (O = Ongoing, W = Waiting, C = Completed, P = Played)
            if (match.sta === 'O' || match.sta === 'W') {
                match._is_active_now = true;
                match._is_completed_now = false;
            } else if (match.sta === 'C' || match.sta === 'P' || match.sta === 'F') {
                match._is_active_now = false; 
                match._is_completed_now = true;
            }

            let p1Name = match.hcf || match.hc || match.p1;
            let p2Name = match.acf || match.ac || match.p2;

            if (match.mi && p1Name && p2Name) {
                alleRecaps.push({ id: match.mi.toString(), p1: p1Name, p2: p2Name });
            }
            
            // 2. ALLEEN VEILIGE, LANGE ID'S GEBRUIKEN
            // (We hebben bmi en tmi verwijderd, want korte ID's zoals 'A1' overschrijven elkaar bij singles!)
            let mogelijkeLiveIds = [];
            if (match.mi) mogelijkeLiveIds.push(match.mi.toString());
            if (match.match_id) {
                mogelijkeLiveIds.push(match.match_id.toString());
                mogelijkeLiveIds.push(match.match_id.toString().replace(/_/g, '-'));
            }

            mogelijkeLiveIds.forEach(id => {
                liveMatchDict[id] = match;
            });

            // Sla ook op per event+bmi zodat we bij de bracket-lookup de juiste discipline vinden
            if (match.bmi && match.ei) {
                bmiScopedDict[`${match.ei}_${match.bmi}`] = match;
            }

            // 3. Namen-Schoonmaker: Dit is ons super-vangnet voor koppels én singles!
            if (p1Name && p2Name) {
                let cleanP1 = cleanNameForMatching(p1Name);
                let cleanP2 = cleanNameForMatching(p2Name);
                liveMatchByNameDict[cleanP1 + "_" + cleanP2] = match;
                liveMatchByNameDict[cleanP2 + "_" + cleanP1] = match; 
            }

            mogelijkeLiveIds.forEach(pId => {
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
        let bmiToRCode = {};       // bracket match ID → T-code (unscoped, fallback)
        let bmiScopedToRCode = {}; // "${ei}_${bmi}" → T-code (scoped per sub-event)
        dcMatchesList.forEach(m => {
            let matchId = (m._custom_id || m.match_id || m.id || "").toString();
            let rndMatch = matchId.match(/^(\d+)[_-]/);
            if (rndMatch) {
                let rndKey = m._bron_url + "_" + rndMatch[1];
                rondeTellingen[rndKey] = (rondeTellingen[rndKey] || 0) + 1;
            }
        });
        matchlistData.forEach(m => {
            if (m.bmi && m.r) {
                bmiToRCode[m.bmi.toString()] = m.r;
                if (m.ei) bmiScopedToRCode[`${m.ei}_${m.bmi}`] = m.r;
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

            // --- HET NIEUWE, ROBUUSTE RONDE-DETECTIE SYSTEEM ---
            let rondeNaam = "Ronde ?";

            // 1. Detecteer de fase op basis van Event Label (el) of bracket type
            let fase = "";
            if (m.el === "Winner's KO") fase = "Winnaarsronde";
            else if (m.el === "Consolation KO") fase = "Verliezersronde";
            else if (m.el === "Round Robin" || m._bracket_type === "Groepsfase") fase = "Poule";
            else fase = m.el || "";

            // Verrijk met T-code uit matchlist, scoped op sub-event om conflicten te vermijden
            let rawBracketId = (m.id || "").toString();
            if (!m.r) {
                let bracketEiMatch = (m._bron_url || "").match(/\/bracket\/(\d+)/i);
                let scopedKey = bracketEiMatch ? `${bracketEiMatch[1]}_${rawBracketId}` : null;
                m.r = (scopedKey && bmiScopedToRCode[scopedKey]) || bmiToRCode[rawBracketId];
            }

            // 2. Vertaal de 'r' (T-code) naar leesbare tekst (bijv. T16 -> Laatste 16)
            if (m.r && typeof m.r === 'string' && m.r.startsWith('T')) {
                let aantal = parseInt(m.r.substring(1), 10);
                if (aantal === 2) rondeNaam = "Finale";
                else if (aantal === 4) rondeNaam = "Halve Finale";
                else if (aantal === 8) rondeNaam = "Kwartfinale";
                else rondeNaam = "Laatste " + aantal;

                // Plak de fase erachter voor extra duidelijkheid (bijv. "Kwartfinale (Verliezersronde)")
                if (fase && fase !== "Knockout" && fase !== "Poule") {
                    rondeNaam += ` (${fase})`;
                }
            } 
            // 3. Specifieke afhandeling voor Poules (bijv. el: "Round Robin" + r: "E" -> Poule E)
            else if (fase === "Poule" && m.r && isNaN(m.r)) {
                rondeNaam = "Poule " + m.r;
            }
            // 4. Mocht de T-code missen, val dan veilig terug op de oude bekende namen
            else if (m.rn) rondeNaam = m.rn;
            else if (m.round_name) rondeNaam = m.round_name;
            else if (m._tree_round && m._tree_round !== "Ronde ?") rondeNaam = m._tree_round;
            
            // Extra backup voor poule-weergave op basis van het ID
            if (fase === "Poule" && rondeNaam === "Ronde ?" && matchId) {
                let pouleMatch = matchId.match(/^([A-Za-z]+)\d+$/);
                if (pouleMatch) rondeNaam = "Poule " + pouleMatch[1].toUpperCase();
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
            // Probeer scoped lookup op event-ID + bmi om round robin vs KO conflicts te voorkomen
            if (!actMatch && dbId) {
                let bracketEi = (m._bron_url || "").match(/\/bracket\/(\d+)/i);
                if (bracketEi) actMatch = bmiScopedDict[`${bracketEi[1]}_${dbId}`];
            }
            if (!actMatch && targetP1 !== "onbekend" && targetP2 !== "onbekend" && targetP1 !== "" && targetP2 !== "") {
                actMatch = liveMatchByNameDict[targetP1 + "_" + targetP2];
            }

            let fS1 = m.s1 !== null && m.s1 !== undefined ? m.s1 : "";
            let fS2 = m.s2 !== null && m.s2 !== undefined ? m.s2 : "";
            let isActive = activeStatuses.has(matchId) || activeStatuses.has(dbId);
            let detectedRecapId = "";
            let detectedWatchId = ""; 
            let isKlaarVolgensLiveLijst = false;

            let avg1 = "";
            let avg2 = "";
            let writer = markerNaam; 
            let country1 = "";
            let country2 = "";

            if (actMatch) {
                let isSwapped = false;
                let liveP1Name = actMatch.hcf || actMatch.hc || actMatch.p1 || "";
                let mlAc = cleanNameForMatching(liveP1Name);
                if (targetP1 !== mlAc) isSwapped = true;

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

        const combinedDarters = [...(tournament.darters || []), ...(Array.isArray(extraDarters) ? extraDarters : [])];
        const dartersLower = [...new Set(combinedDarters.map(d => (d || '').toLowerCase()).filter(Boolean))];
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
                    let pouleKey = `${tournament.name}_${match.ronde}`;
                    if (!db.notifiedPoules[pouleKey]) db.notifiedPoules[pouleKey] = [];

                    let subsToNotify = db.subscriptions.filter(sub => {
                        if (!sub.preferences || !sub.preferences[tournament.name]) return false;
                        let gekozenSpelers = sub.preferences[tournament.name];
                        if (gekozenSpelers.length === 0) return false;
                        let raakt = gekozenSpelers.find(f => match.player1.toLowerCase().includes(f) || match.player2.toLowerCase().includes(f));
                        return raakt && !db.notifiedPoules[pouleKey].includes(sub.endpoint);
                    });

                    if (subsToNotify.length > 0) {
                        let spelersInPoule = Array.from(pouleIndelingen[match.ronde] || []);
                        let deadEndpoints = [];

                        if (!isFirstRun) {
                            await Promise.all(subsToNotify.map(async (sub) => {
                                let mijnGevolgdeSpeler = sub.preferences[tournament.name].find(f =>
                                    match.player1.toLowerCase().includes(f) || match.player2.toLowerCase().includes(f));
                                try {
                                    let ik = spelersInPoule.find(p => p.toLowerCase().includes(mijnGevolgdeSpeler)) || mijnGevolgdeSpeler;
                                    let anderen = spelersInPoule.filter(p => p !== ik);
                                    let body = `${ik} is ingedeeld in ${match.ronde} met: ${anderen.join(', ')}`;
                                    const persoonlijkPayload = JSON.stringify({ title: `📊 Poule Indeling Bekend!`, body, icon: '/icon-192x192.png', badge: '/icon-192x192.png' });
                                    await webpush.sendNotification(sub, persoonlijkPayload);
                                    db.notifiedPoules[pouleKey].push(sub.endpoint);
                                    console.log(`[PUSH] ✅ Poule verstuurd: ${pouleKey} → ...${sub.endpoint.slice(-20)}`);
                                } catch (err) {
                                    console.error(`[PUSH] ❌ Fout bij poule ${pouleKey} → ...${sub.endpoint.slice(-20)}: status=${err.statusCode} msg=${err.message}`);
                                    addSystemError('push', `poule ${pouleKey}: ${err.statusCode} ${err.message}`);
                                    if (err.statusCode === 410 || err.statusCode === 404) {
                                        deadEndpoints.push(sub.endpoint);
                                    }
                                    // Niet markeren bij fout — volgende hartslag probeert opnieuw
                                }
                            }));
                            if (deadEndpoints.length > 0) db.subscriptions = db.subscriptions.filter(s => !deadEndpoints.includes(s.endpoint));
                        } else {
                            subsToNotify.forEach(sub => db.notifiedPoules[pouleKey].push(sub.endpoint));
                        }
                        nieuwGeplandCount++;
                    }
                } else {
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
                    } else if (!isPoule && match.player1 !== "Onbekend" && match.player2 !== "Onbekend") {
                        stuurMelding = true;
                        titel = "🎯 Nieuwe wedstrijd gepland!";
                    }

                    if (stuurMelding) {
                        if (!db.notifiedMatches[match.id]) db.notifiedMatches[match.id] = [];

                        let subsToNotify = db.subscriptions.filter(sub => {
                            if (!sub.preferences || !sub.preferences[tournament.name]) return false;
                            let gekozenSpelers = sub.preferences[tournament.name];
                            if (gekozenSpelers.length === 0) return false;
                            let subIsSpeler = gekozenSpelers.some(f => match.player1.toLowerCase().includes(f) || match.player2.toLowerCase().includes(f));
                            let subIsMarker = gekozenSpelers.some(f => match.marker && match.marker.toLowerCase().includes(f));
                            return (subIsSpeler || subIsMarker) && !db.notifiedMatches[match.id].includes(sub.endpoint);
                        });

                        if (subsToNotify.length > 0) {
                            if (!isFirstRun) {
                                let schrijfTekst = match.writer ? `\nSchrijver: ${match.writer}` : "";
                                let deadEndpoints = [];

                                await Promise.all(subsToNotify.map(async (sub) => {
                                    let gekozenSpelers = sub.preferences[tournament.name];
                                    let subIsSpeler = gekozenSpelers.some(f => match.player1.toLowerCase().includes(f) || match.player2.toLowerCase().includes(f));
                                    let subIsMarker = gekozenSpelers.some(f => match.marker && match.marker.toLowerCase().includes(f));
                                    try {
                                        let persoonlijkeTitel = titel;
                                        if (!subIsSpeler && subIsMarker) persoonlijkeTitel += " (SCHRIJVEN)";
                                        const persoonlijkPayload = JSON.stringify({
                                            title: persoonlijkeTitel,
                                            body: `${match.player1} tegen ${match.player2}\nBord: ${match.board} | Tijd: ${match.time}${schrijfTekst}`,
                                            icon: '/icon-192x192.png',
                                            badge: '/icon-192x192.png'
                                        });
                                        await webpush.sendNotification(sub, persoonlijkPayload);
                                        db.notifiedMatches[match.id].push(sub.endpoint);
                                        console.log(`[PUSH] ✅ Verstuurd: ${match.id} → ...${sub.endpoint.slice(-20)}`);
                                        systemStatus.push.lastSuccessAt = new Date().toISOString();
                                    } catch (err) {
                                        console.error(`[PUSH] ❌ Fout bij ${match.id} → ...${sub.endpoint.slice(-20)}: status=${err.statusCode} msg=${err.message}`);
                                        addSystemError('push', `match ${match.id}: ${err.statusCode} ${err.message}`);
                                        if (err.statusCode === 410 || err.statusCode === 404) {
                                            deadEndpoints.push(sub.endpoint);
                                        }
                                        // Niet markeren als gemeld bij fout — volgende hartslag probeert het opnieuw
                                    }
                                }));
                                if (deadEndpoints.length > 0) db.subscriptions = db.subscriptions.filter(s => !deadEndpoints.includes(s.endpoint));
                            } else {
                                subsToNotify.forEach(sub => db.notifiedMatches[match.id].push(sub.endpoint));
                            }
                            nieuwGeplandCount++;
                        }
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
                const parseScore = (s) => (s === 'W' || s === 99) ? 99 : ((s === 'X' || s === 'F' || s === -1) ? -1 : parseInt(s) || 0);
                const s1 = parseScore(match.score1);
                const s2 = parseScore(match.score2);
                match.resultaat = (isP1 && s1 > s2) || (!isP1 && s2 > s1) ? "win" : "verlies";

                // Uitslag-notificatie sturen
                if (!db.notifiedResults[match.id]) db.notifiedResults[match.id] = [];
                let subsVoorUitslag = db.subscriptions.filter(sub => {
                    if (!sub.preferences || !sub.preferences[tournament.name]) return false;
                    let gekozen = sub.preferences[tournament.name];
                    return gekozen.length > 0
                        && gekozen.some(f => match.player1.toLowerCase().includes(f) || match.player2.toLowerCase().includes(f))
                        && !db.notifiedResults[match.id].includes(sub.endpoint);
                });

                if (!isFirstRun && subsVoorUitslag.length > 0 && match.score1 !== "" && match.score2 !== "") {
                    let uitslag = `${match.player1} ${match.score1} - ${match.score2} ${match.player2}`;
                    let deadEndpoints = [];
                    await Promise.all(subsVoorUitslag.map(async (sub) => {
                        let gekozen = sub.preferences[tournament.name];
                        let mijnSpeler = gekozen.find(f => match.player1.toLowerCase().includes(f) || match.player2.toLowerCase().includes(f));
                        let isWin = mijnSpeler && ((match.player1.toLowerCase().includes(mijnSpeler) && s1 > s2) || (match.player2.toLowerCase().includes(mijnSpeler) && s2 > s1));
                        let emoji = isWin ? "🏆" : "❌";
                        let resultTekst = isWin ? "GEWONNEN" : "VERLOREN";
                        try {
                            await webpush.sendNotification(sub, JSON.stringify({
                                title: `${emoji} ${resultTekst}: ${match.ronde}`,
                                body: uitslag,
                                icon: '/icon-192x192.png',
                                badge: '/icon-192x192.png'
                            }));
                            db.notifiedResults[match.id].push(sub.endpoint);
                            console.log(`[PUSH] ✅ Uitslag verstuurd: ${match.id} → ...${sub.endpoint.slice(-20)}`);
                        } catch (err) {
                            console.error(`[PUSH] ❌ Uitslag fout: ${match.id}: ${err.statusCode} ${err.message}`);
                            if (err.statusCode === 410 || err.statusCode === 404) deadEndpoints.push(sub.endpoint);
                        }
                    }));
                    if (deadEndpoints.length > 0) db.subscriptions = db.subscriptions.filter(s => !deadEndpoints.includes(s.endpoint));
                    nieuwGeplandCount++;
                } else if (isFirstRun) {
                    subsVoorUitslag.forEach(sub => db.notifiedResults[match.id].push(sub.endpoint));
                }
            }

            let uniekeMatchID = match._bron_url + "_" + match.id;
            definitieveLijst.push(match);
            toegevoegdeIds.add(uniekeMatchID);
        }

        if (nieuwGeplandCount > 0) writeDB(db);

        eigenWedstrijden.forEach(match => {
            let isSpeler = dartersLower.find(d => (match.player1 && match.player1.toLowerCase().includes(d)) || (match.player2 && match.player2.toLowerCase().includes(d)));
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

                    let heeftAlEchteMatchInDezeRonde = definitieveLijst.some(m =>
                        m.status !== "mogelijk" &&
                        m.ronde === mogelijkeMatch.ronde &&
                        (m.player1.toLowerCase().includes(isSpeler.toLowerCase()) || m.player2.toLowerCase().includes(isSpeler.toLowerCase()))
                    );

                    if (!toegevoegdeIds.has(uniekeVolgendeID) && !isAlGeweest && !heeftAlEchteMatchInDezeRonde) {
                        // Bepaal de potentiële tegenstander voor de mogelijke volgende ronde
                        let mogelijkeTegenstander = "";
                        let p1Naam = mogelijkeMatch.player1 && mogelijkeMatch.player1 !== "Onbekend" ? mogelijkeMatch.player1 : null;
                        let p2Naam = mogelijkeMatch.player2 && mogelijkeMatch.player2 !== "Onbekend" ? mogelijkeMatch.player2 : null;
                        let mijnKant = (p1Naam && p1Naam.toLowerCase().includes(isSpeler)) ? "p1" : "p2";
                        let anderKant = mijnKant === "p1" ? p2Naam : p1Naam;

                        if (anderKant) {
                            mogelijkeTegenstander = anderKant;
                        } else {
                            // Tegenstander nog onbekend — zoek wie er in de andere bracket-match speelt
                            let bronId = mogelijkeMatch.id ? mogelijkeMatch.id.toString().replace(/-/g, '_') : null;
                            if (bronId) {
                                let [rNr, mNr] = bronId.split('_').map(Number);
                                // De andere invoer van deze match is een broer-match
                                let broerIds = [`${rNr - 1}_${(mNr - 1) * 2 + 1}`, `${rNr - 1}_${(mNr - 1) * 2 + 2}`];
                                let broerMatches = definitieveLijst.filter(m => {
                                    let mId = (m.id || "").toString().replace(/-/g, '_');
                                    return m._bron_url === mogelijkeMatch._bron_url && broerIds.includes(mId);
                                });
                                let anderSpeler = broerMatches.flatMap(m => [m.player1, m.player2]).find(n => n && n !== "Onbekend" && !n.toLowerCase().includes(isSpeler));
                                if (anderSpeler) mogelijkeTegenstander = anderSpeler;
                            }
                        }

                        definitieveLijst.push({ ...mogelijkeMatch, isMogelijk: true, status: "mogelijk", mogelijkVoor: isSpeler, mogelijkeTegenstander, rol: "speler" });
                        toegevoegdeIds.add(uniekeVolgendeID);
                    }
                } else if (match._tree_round_nr !== undefined && match._tree_match_nr !== undefined) {
                    // Volgend-ronde slot bestaat nog niet in de data — genereer een synthetische "mogelijk" kaart
                    let volgendeRondeNr = match._tree_round_nr + 1;
                    let volgendeMatchNrInRonde = Math.floor(match._tree_match_nr / 2);

                    // Haal de naam van de volgende ronde op uit een bestaande match in die ronde, anders afleiden
                    let matchInVolgendeRonde = rawMatches.find(rm =>
                        rm._bron_url === match._bron_url && rm._tree_round_nr === volgendeRondeNr
                    );
                    let volgendeRondeNaam;
                    if (matchInVolgendeRonde) {
                        volgendeRondeNaam = matchInVolgendeRonde.ronde;
                    } else {
                        const rondeVertalingen = { "Laatste 16": "Kwartfinale", "Laatste 32": "Laatste 16", "Laatste 64": "Laatste 32", "Laatste 128": "Laatste 64", "Kwartfinale": "Halve Finale", "Halve Finale": "Finale" };
                        let baseRonde = (match.ronde || "").replace(/\s*\(.*\)$/, "").trim();
                        if (!rondeVertalingen[baseRonde]) return; // geen bekende volgende ronde (bijv. na de Finale)
                        volgendeRondeNaam = rondeVertalingen[baseRonde];
                    }

                    // Niet toevoegen als speler al een echte match heeft in die ronde
                    let heeftAlEchteMatchInVolgendeRonde = definitieveLijst.some(m =>
                        m.status !== "mogelijk" &&
                        m.ronde === volgendeRondeNaam &&
                        (m.player1.toLowerCase().includes(isSpeler.toLowerCase()) || m.player2.toLowerCase().includes(isSpeler.toLowerCase()))
                    );

                    let syntheticId = `${match._bron_url}_synthetic_r${volgendeRondeNr}_m${volgendeMatchNrInRonde}`;

                    if (!toegevoegdeIds.has(syntheticId) && !heeftAlEchteMatchInVolgendeRonde) {
                        // Zoek de broer-match (sibling) in dezelfde ronde — de winnaar daarvan is de mogelijke tegenstander
                        let broerMatchNr = match._tree_match_nr ^ 1;
                        let broerMatch = rawMatches.find(rm =>
                            rm._bron_url === match._bron_url &&
                            rm._tree_round_nr === match._tree_round_nr &&
                            rm._tree_match_nr === broerMatchNr
                        );

                        let mogelijkeTegenstander = "";
                        if (broerMatch) {
                            if (broerMatch.isFinished) {
                                mogelijkeTegenstander = broerMatch.resultaat === "win" ? broerMatch.player1 : broerMatch.player2;
                            } else {
                                let broerSpelers = [broerMatch.player1, broerMatch.player2].filter(n => n && n !== "Onbekend" && !n.toLowerCase().includes(isSpeler));
                                if (broerSpelers.length === 1) mogelijkeTegenstander = broerSpelers[0];
                                else if (broerSpelers.length === 2) mogelijkeTegenstander = `winnaar ${broerSpelers[0]} / ${broerSpelers[1]}`;
                            }
                        }

                        definitieveLijst.push({
                            id: `synthetic_r${volgendeRondeNr}_m${volgendeMatchNrInRonde}`,
                            _bron_url: match._bron_url,
                            _bron_label: match._bron_label,
                            player1: isSpeler,
                            player2: mogelijkeTegenstander || "Onbekend",
                            ronde: volgendeRondeNaam,
                            status: "mogelijk",
                            isMogelijk: true,
                            mogelijkVoor: isSpeler,
                            mogelijkeTegenstander,
                            score1: "", score2: "",
                            resultaat: "",
                            isFinished: false,
                            _tree_round_nr: volgendeRondeNr,
                            _tree_match_nr: volgendeMatchNrInRonde,
                            rol: "speler"
                        });
                        toegevoegdeIds.add(syntheticId);
                    }
                }
            }
        });

        // Tweede synthese-pass: ook rondes die ontbreken NA een al-gesynthetiseerde "mogelijk"-kaart invullen
        const rondeVertalingen2 = { "Laatste 16": "Kwartfinale", "Laatste 32": "Laatste 16", "Laatste 64": "Laatste 32", "Laatste 128": "Laatste 64", "Kwartfinale": "Halve Finale", "Halve Finale": "Finale" };
        const syntheticCards = definitieveLijst.filter(m => m.isMogelijk && m._tree_round_nr !== undefined && typeof m.id === 'string' && m.id.startsWith('synthetic_'));
        syntheticCards.forEach(synthetic => {
            const isSpeler = synthetic.mogelijkVoor;
            if (!isSpeler) return;

            let volgendeRondeNr = synthetic._tree_round_nr + 1;
            let volgendeMatchNrInRonde = Math.floor(synthetic._tree_match_nr / 2);

            // Kijk of het volgende slot al in rawMatches bestaat
            let bestaatInRaw = rawMatches.some(rm =>
                rm._bron_url === synthetic._bron_url &&
                rm._tree_round_nr === volgendeRondeNr &&
                rm._tree_match_nr === volgendeMatchNrInRonde
            );
            if (bestaatInRaw) return; // echte data beschikbaar, geen synthese nodig

            let syntheticId2 = `${synthetic._bron_url}_synthetic_r${volgendeRondeNr}_m${volgendeMatchNrInRonde}`;
            if (toegevoegdeIds.has(syntheticId2)) return;

            let heeftAlEchteMatch = definitieveLijst.some(m =>
                m.status !== "mogelijk" &&
                (m.player1.toLowerCase().includes(isSpeler.toLowerCase()) || m.player2.toLowerCase().includes(isSpeler.toLowerCase()))
            );
            // Niet toevoegen als speler al een echte niet-gespeelde match heeft
            if (heeftAlEchteMatch && definitieveLijst.some(m => m.status !== "mogelijk" && m.status !== "gespeeld" && (m.player1.toLowerCase().includes(isSpeler.toLowerCase()) || m.player2.toLowerCase().includes(isSpeler.toLowerCase())))) return;

            let matchInVolgendeRonde = rawMatches.find(rm => rm._bron_url === synthetic._bron_url && rm._tree_round_nr === volgendeRondeNr);
            let volgendeRondeNaam2;
            if (matchInVolgendeRonde) {
                volgendeRondeNaam2 = matchInVolgendeRonde.ronde;
            } else {
                let baseRonde = (synthetic.ronde || "").replace(/\s*\(.*\)$/, "").trim();
                if (!rondeVertalingen2[baseRonde]) return; // geen bekende volgende ronde (bijv. na de Finale)
                volgendeRondeNaam2 = rondeVertalingen2[baseRonde];
            }

            definitieveLijst.push({
                id: `synthetic_r${volgendeRondeNr}_m${volgendeMatchNrInRonde}`,
                _bron_url: synthetic._bron_url,
                _bron_label: synthetic._bron_label,
                player1: isSpeler,
                player2: "Onbekend",
                ronde: volgendeRondeNaam2,
                status: "mogelijk",
                isMogelijk: true,
                mogelijkVoor: isSpeler,
                mogelijkeTegenstander: "",
                score1: "", score2: "",
                resultaat: "",
                isFinished: false,
                _tree_round_nr: volgendeRondeNr,
                _tree_match_nr: volgendeMatchNrInRonde,
                rol: "speler"
            });
            toegevoegdeIds.add(syntheticId2);
        });

        // --- JOUW ORIGINELE PERFECTE TIJDLIJN SORTERING (MET SLIMME NOODREM) ---
        definitieveLijst.sort((a, b) => {
            const volgorde = { "bezig": 1, "gepland": 2, "mogelijk": 3, "gespeeld": 4 };
            if (volgorde[a.status] !== volgorde[b.status]) return volgorde[a.status] - volgorde[b.status];
            
           // Haal het logische rondenummer op. Als er een T-code is (bijv. T16), rekenen we terug.
            // Hoe kleiner het T-nummer (bijv. T2 = Finale), hoe verder in het toernooi, dus hoe hoger het rondenummer.
            let rA = a._tree_round_nr || 0;
            if (a.r && typeof a.r === 'string' && a.r.startsWith('T')) {
                let aantal = parseInt(a.r.substring(1), 10);
                rA = 1000 - aantal; // Zorgt voor de juiste chronologische volgorde (4096 -> 16 -> 4 -> 2)
            } else if (a.id && a.id.includes('-')) {
                rA = parseInt(a.id.split('-')[0], 10) || 0;
            }

            let rB = b._tree_round_nr || 0;
            if (b.r && typeof b.r === 'string' && b.r.startsWith('T')) {
                let aantal = parseInt(b.r.substring(1), 10);
                rB = 1000 - aantal;
            } else if (b.id && b.id.includes('-')) {
                rB = parseInt(b.id.split('-')[0], 10) || 0;
            }

            // Controleer of de wedstrijden wel echt een bekende tijd hebben
            let hasTimeA = a.time && !["Onbekend", "Niet bekend", "Later", "?"].includes(a.time);
            let hasTimeB = b.time && !["Onbekend", "Niet bekend", "Later", "?"].includes(b.time);

            // --- DE SLIMME NOODREM ---
            // Als minimaal één van de twee géén tijd heeft, is de Ronde de baas!
            // Zo voorkom je dat een eerdere ronde zonder tijd, onder een latere ronde mét tijd valt.
            if (!hasTimeA || !hasTimeB) {
                if (rA !== rB) {
                    return a.status === "gespeeld" ? (rB - rA) : (rA - rB);
                }
            }

            // --- JOUW TIJDLIJN-WISKUNDE (Voor als ze wél allebei een tijd hebben!) ---
            const getNumericTime = (timeStr) => {
                if (!timeStr || ["Onbekend", "Niet bekend", "Later", "?"].includes(timeStr)) return 24;
                let parts = timeStr.split(':');
                if (parts.length === 2) {
                    return parseInt(parts[0], 10) + (parseInt(parts[1], 10) / 60);
                }
                return 24;
            };

            let tA = getNumericTime(a.time);
            let tB = getNumericTime(b.time);

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

        // Verwijder "mogelijk" kaarten als speler al uitgeschakeld is of het toernooi voorbij is
        const alleGespeeld = definitieveLijst.every(m => m.isMogelijk || m.status === "gespeeld");
        definitieveLijst = definitieveLijst.filter(m => {
            if (!m.isMogelijk) return true;
            // Toernooi helemaal afgelopen: geen "mogelijk" kaarten meer tonen
            if (alleGespeeld) return false;
            // Speler heeft een KO-verlies gehad: uitgeschakeld
            const isSpeler = (m.mogelijkVoor || "").toLowerCase();
            if (!isSpeler) return true;
            const heeftVerloren = definitieveLijst.some(real =>
                !real.isMogelijk &&
                real.status === "gespeeld" &&
                real.resultaat === "verlies" &&
                (real.player1.toLowerCase().includes(isSpeler) || real.player2.toLowerCase().includes(isSpeler))
            );
            return !heeftVerloren;
        });

        return definitieveLijst;

    } catch (error) {
        console.error("Fout:", error.message);
        return [];
    }
}


let pouleStandingsCache = {};

app.get('/api/poule-standings', async (req, res) => {
    const tName = req.query.tournament;
    if (!tName) return res.status(400).json({ error: 'Toernooi ontbreekt.' });

    const db = readDB();
    const tournament = db.tournaments.find(t => t.name === tName);
    if (!tournament || !tournament.url) {
        return res.status(404).json({ error: 'Toernooi of URL niet gevonden.' });
    }

    const debugParse = req.query.debug === '1';
    const urls = tournament.url.split(',').map(u => u.trim()).filter(Boolean);

    let rrUrl = urls.find(u => u.includes('/round-robin/'));
    if (!rrUrl) {
        const bracketUrl = urls.find(u => u.includes('/bracket/'));
        if (bracketUrl) {
            rrUrl = bracketUrl.replace('/bracket/', '/round-robin/');
        }
    }

    if (!rrUrl) {
        return res.status(400).json({ error: 'Geen poule (round-robin of bracket) link gevonden voor dit toernooi.' });
    }

    try {
        const startedAt = Date.now();
        const response = await axios.post(rrUrl, {}, { timeout: 8000 });
        const dataContainer = response.data.payload || response.data || {};

        const found = [];
        function zoekStanden(obj) {
            if (!obj || typeof obj !== 'object') return;
            if (obj.opponent && obj.rr_group !== undefined && obj.mp !== undefined && obj.mw !== undefined) {
                found.push(obj);
            }
            Object.values(obj).forEach(v => zoekStanden(v));
        }
        zoekStanden(dataContainer);

        if (found.length === 0) {
            return res.status(404).json({ error: 'Geen poulestand gevonden in de API-respons.' });
        }

        const grouped = {};
        found.forEach(row => {
            const group = (row.rr_group || '?').toString();
            if (!grouped[group]) grouped[group] = [];
            grouped[group].push({
                rank: row.init_rank || row.final_rank || null,
                player: row.opponent || 'Onbekend',
                mp: row.mp ?? 0,
                mw: row.mw ?? 0,
                gld: row.gld ?? 0,
                lw: row.lw ?? 0,
                ppr: row.ppr ?? null
            });
        });

        Object.values(grouped).forEach(rows => {
            rows.sort((a, b) => (a.rank || 999) - (b.rank || 999));
        });

        if (debugParse) {
            const rowCount = Object.values(grouped).reduce((acc, rows) => acc + rows.length, 0);
            console.log(`[poule-standings][${tName}] groups=${Object.keys(grouped).length} rows=${rowCount}`);
        }

        const payload = {
            tournament: tName,
            groups: grouped,
            stale: false,
            updatedAt: new Date().toISOString()
        };

        pouleStandingsCache[tName] = payload;
        systemStatus.poule.lastSuccessAt = payload.updatedAt;
        systemStatus.poule.lastDurationMs = Date.now() - startedAt;
        res.json(payload);
    } catch (e) {
        console.error('Fout bij ophalen poulestand:', e.message);
        systemStatus.poule.lastErrorAt = new Date().toISOString();
        systemStatus.poule.lastErrorMessage = e.message;
        addSystemError('poule-standings', e.message);

        const cached = pouleStandingsCache[tName];
        if (cached && cached.groups) {
            systemStatus.poule.staleServedCount += 1;
            return res.json({
                ...cached,
                stale: true,
                staleReason: 'upstream_error'
            });
        }

        res.status(500).json({ error: 'Fout bij ophalen poulestand.' });
    }
});

let matchCache = {};
let cacheTimestamps = {};

app.get('/api/live-scores', async (req, res) => {
    const tName = req.query.tournament;
    if (!tName) return res.status(400).json({ error: 'Geef ?tournament=... mee' });

    const db = readDB();
    const tournament = db.tournaments.find(t => t.name === tName);
    if (!tournament) return res.status(404).json({ error: 'Toernooi niet gevonden' });

    const bracketUrls = tournament.url.split(',').map(u => u.trim()).filter(Boolean);
    let scores = {};

    for (let bUrl of bracketUrls) {
        let eventMatch = bUrl.match(/\/event\/([^\/]+)/i);
        if (!eventMatch) continue;
        let mUrls = [
            `https://tv.dartconnect.com/event/${eventMatch[1]}/state/matches?fetch_type=initial`,
            `https://tv.dartconnect.com/api/event/${eventMatch[1]}/matches`
        ];
        for (let mUrl of mUrls) {
            try {
                let mlRes = await axios.get(mUrl).catch(() => axios.post(mUrl, {}));
                let data = mlRes.data?.payload || mlRes.data || {};
                let actief = data.active || data.matches_live || {};
                let entries = Array.isArray(actief) ? actief : Object.values(actief);
                entries.forEach(m => {
                    let id = (m.bmi || m.mi || m.match_id || "").toString();
                    if (id) scores[id] = { hs: m.hs ?? m.s1, as: m.as ?? m.s2, actief: true };
                });
            } catch(e) {}
        }
    }

    res.json(scores);
});

app.get('/api/matches', async (req, res) => {
    const tName = req.query.tournament;

    let extraPlayers = [];
    if (Array.isArray(req.query.extraPlayers)) {
        extraPlayers = req.query.extraPlayers;
    } else if (typeof req.query.extraPlayers === 'string') {
        extraPlayers = req.query.extraPlayers.split(',');
    }

    extraPlayers = extraPlayers.map(p => p.trim()).filter(Boolean);

    const extrasKey = extraPlayers
        .map(p => p.toLowerCase())
        .sort((a, b) => a.localeCompare(b))
        .join('|');
    const cacheKey = `${tName}::${extrasKey}`;

    if (matchCache[cacheKey] && cacheTimestamps[cacheKey] && (Date.now() - cacheTimestamps[cacheKey] < 10000)) {
        systemStatus.matches.cacheHits += 1;
        return res.json(matchCache[cacheKey]);
    }

    systemStatus.matches.cacheMisses += 1;
    const startedAt = Date.now();
    const list = await fetchMatchesForTournament(tName, extraPlayers);
    matchCache[cacheKey] = list;
    cacheTimestamps[cacheKey] = Date.now();
    systemStatus.matches.lastFetchAt = new Date().toISOString();
    systemStatus.matches.lastDurationMs = Date.now() - startedAt;

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
        body: "Paul Krohne tegen Heine Uuldriks\nBord: 201 | Tijd: 14:20",
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
        const allSubPlayers = db.subscriptions
            .flatMap(sub => (sub.preferences && sub.preferences[t.name]) || []);
        const extraFromSubs = [...new Set(allSubPlayers)];
        const nieuwLijstje = await fetchMatchesForTournament(t.name, extraFromSubs);
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

app.get('/api/admin/debug-matches', async (req, res) => {
    const tName = req.query.tournament;
    if (!tName) return res.status(400).json({ error: 'Geef ?tournament=... mee' });

    const db = readDB();
    const t = db.tournaments.find(x => x.name === tName);
    if (!t) return res.status(404).json({ error: 'Toernooi niet gevonden' });

    const allSubPlayers = db.subscriptions
        .flatMap(sub => (sub.preferences && sub.preferences[tName]) || []);
    const extraFromSubs = [...new Set(allSubPlayers)];

    const matches = await fetchMatchesForTournament(tName, extraFromSubs);

    const gepland = matches.filter(m => m.status === 'gepland');
    const endpoints = db.subscriptions.map(s => s.endpoint);
    const alGemeld = gepland.filter(m => {
        const notified = db.notifiedMatches[m.id] || [];
        return endpoints.length > 0 && endpoints.every(ep => notified.includes(ep));
    });
    const deelsGemeld = gepland.filter(m => {
        const notified = db.notifiedMatches[m.id] || [];
        return notified.length > 0 && !endpoints.every(ep => notified.includes(ep));
    });
    const nogNietGemeld = gepland.filter(m => !db.notifiedMatches[m.id] || db.notifiedMatches[m.id].length === 0);

    res.json({
        tournament: tName,
        url: t.url,
        extraFromSubs,
        totalMatches: matches.length,
        geplandCount: gepland.length,
        volledigGemeld: alGemeld.map(m => ({ id: m.id, player1: m.player1, player2: m.player2, time: m.time })),
        deelsGemeld: deelsGemeld.map(m => ({ id: m.id, player1: m.player1, player2: m.player2, time: m.time, notifiedEndpoints: (db.notifiedMatches[m.id] || []).map(ep => ep.slice(-20)) })),
        nogNietGemeld: nogNietGemeld.map(m => ({ id: m.id, player1: m.player1, player2: m.player2, time: m.time, ronde: m.ronde })),
    });
});

app.get('/api/admin/debug-mogelijk', async (req, res) => {
    const tName = req.query.tournament;
    if (!tName) return res.status(400).json({ error: 'Geef ?tournament=... mee' });
    const db = readDB();
    const t = db.tournaments.find(x => x.name === tName);
    if (!t) return res.status(404).json({ error: 'Toernooi niet gevonden' });

    const allSubPlayers = db.subscriptions.flatMap(sub => (sub.preferences && sub.preferences[tName]) || []);
    const extraFromSubs = [...new Set(allSubPlayers)];
    const matches = await fetchMatchesForTournament(tName, extraFromSubs);

    const mogelijk = matches.filter(m => m.status === 'mogelijk');
    const gepland = matches.filter(m => m.status === 'gepland');
    const gespeeld = matches.filter(m => m.status === 'gespeeld');

    res.json({
        totalMatches: matches.length,
        geplandCount: gepland.length,
        gespeeldCount: gespeeld.length,
        mogelijkCount: mogelijk.length,
        mogelijkMatches: mogelijk.map(m => ({
            id: m.id, ronde: m.ronde, player1: m.player1, player2: m.player2,
            mogelijkVoor: m.mogelijkVoor, mogelijkeTegenstander: m.mogelijkeTegenstander,
            _tree_round_nr: m._tree_round_nr, _tree_match_nr: m._tree_match_nr
        })),
        geplandSample: gepland.slice(0, 5).map(m => ({
            id: m.id, ronde: m.ronde, player1: m.player1, player2: m.player2,
            score1: m.score1, score2: m.score2, isFinished: m.isFinished,
            _tree_round_nr: m._tree_round_nr, _tree_match_nr: m._tree_match_nr
        })),
        gespeeldSample: gespeeld.slice(0, 3).map(m => ({
            id: m.id, ronde: m.ronde, player1: m.player1, player2: m.player2,
            resultaat: m.resultaat, _tree_round_nr: m._tree_round_nr, _tree_match_nr: m._tree_match_nr
        }))
    });
});

app.post('/api/admin/reset-notified', (req, res) => {
    const { tournament } = req.body;
    const db = readDB();

    if (tournament) {
        const t = db.tournaments.find(x => x.name === tournament);
        if (!t) return res.status(404).json({ error: 'Toernooi niet gevonden' });
        let count = 0;
        Object.keys(db.notifiedMatches).forEach(id => {
            // Match IDs are not tournament-scoped, so reset all (safe since matches have unique IDs)
            delete db.notifiedMatches[id];
            count++;
        });
        Object.keys(db.notifiedPoules).forEach(key => {
            if (key.startsWith(tournament + '_')) {
                delete db.notifiedPoules[key];
            }
        });
        writeDB(db);
        res.json({ success: true, message: `Reset ${count} match IDs en poule entries voor ${tournament}` });
    } else {
        db.notifiedMatches = {};
        db.notifiedPoules = {};
        writeDB(db);
        res.json({ success: true, message: 'Alle notified matches en poules gereset' });
    }
});


app.get('/api/admin/debug-raw', async (req, res) => {
    const tName = req.query.tournament;
    if (!tName) return res.status(400).json({ error: 'Geef ?tournament=... mee' });

    const db = readDB();
    const tournament = db.tournaments.find(t => t.name === tName);
    if (!tournament) return res.status(404).json({ error: 'Toernooi niet gevonden' });

    const bracketUrls = tournament.url.split(',').map(u => u.trim()).filter(Boolean);
    const resultaat = [];

    for (let bUrl of bracketUrls) {
        try {
            const response = await axios.post(bUrl, {});
            const dataContainer = response.data.payload || response.data || {};
            let proBracketArray = dataContainer.proBracket || (dataContainer.bracketData && dataContainer.bracketData.proBracket);
            let bronMap = proBracketArray || dataContainer.bracketData || dataContainer;
            let isStructural = Array.isArray(bronMap) && bronMap.length > 0 && Array.isArray(bronMap[0]);

            let rondeSamples = [];

            if (isStructural) {
                bronMap.forEach((roundArray, rIndex) => {
                    let eersteWedstrijd = roundArray.find(m => m && typeof m === 'object' && ('p1' in m || 'd1' in m));
                    if (eersteWedstrijd) {
                        rondeSamples.push({
                            rIndex,
                            matchCount: roundArray.length,
                            eersteWedstrijdVelden: eersteWedstrijd
                        });
                    }
                });
            } else {
                // Non-structural: collect a few raw match objects
                let gevonden = [];
                function zoek(obj, depth = 0) {
                    if (!obj || typeof obj !== 'object' || depth > 10) return;
                    if ('p1' in obj || 'd1' in obj) { gevonden.push(obj); return; }
                    Object.values(obj).forEach(v => zoek(v, depth + 1));
                }
                zoek(bronMap);
                rondeSamples = gevonden.slice(0, 10);
            }

            // Matchlist API
            let matchlistSamples = [];
            let eventMatch = bUrl.match(/\/event\/([^\/]+)/i);
            if (eventMatch) {
                let mUrl = `https://tv.dartconnect.com/api/event/${eventMatch[1]}/matches`;
                try {
                    let mlRes = await axios.get(mUrl).catch(() => axios.post(mUrl, {}));
                    let data = mlRes.data?.payload || mlRes.data || {};
                    let arr = [];
                    if (data.completed) arr = arr.concat(Array.isArray(data.completed) ? data.completed : Object.values(data.completed));
                    if (data.active) arr = arr.concat(Array.isArray(data.active) ? data.active : Object.values(data.active));
                    if (Array.isArray(mlRes.data)) arr = mlRes.data;
                    matchlistSamples = arr.slice(0, 5);
                } catch(e) { matchlistSamples = [{ error: e.message }]; }
            }

            // Bouw lokale bmiToRCode voor diagnostiek
            let localBmiToRCode = {};
            matchlistSamples.forEach(m => { if (m.bmi && m.r) localBmiToRCode[m.bmi.toString()] = m.r; });

            // Toon hoe de rondenamen er NA verwerking uitzien
            const eersteRondeGrootte = (isStructural && bronMap[0]) ? bronMap[0].length : 0;
            let rondeNaamPreview = [];
            if (isStructural) {
                bronMap.forEach((roundArray, rIndex) => {
                    let spelersOverig = eersteRondeGrootte * 2 / Math.pow(2, rIndex);
                    let structuralName = spelersOverig === 2 ? "Finale" : spelersOverig === 4 ? "Halve Finale" : spelersOverig === 8 ? "Kwartfinale" : spelersOverig > 8 ? "Laatste " + Math.round(spelersOverig) : "Ronde " + (rIndex + 1);
                    let eersteMatch = roundArray.find(m => m && typeof m === 'object' && ('p1' in m || 'd1' in m));
                    let bracketId = eersteMatch ? (eersteMatch.id || "").toString() : "?";
                    let tCode = localBmiToRCode[bracketId] || "(niet gevonden in matchlist samples)";
                    rondeNaamPreview.push({ rIndex, bracketId, structuralName, tCode });
                });
            }

            resultaat.push({ url: bUrl, isStructural, eersteRondeGrootte, rondeSamples, matchlistSamples, rondeNaamPreview });
        } catch(e) {
            resultaat.push({ url: bUrl, error: e.message });
        }
    }

    res.json(resultaat);
});

app.get('/api/admin/debug-notify', async (req, res) => {
    const { tournament: tName, matchId } = req.query;
    if (!tName || !matchId) return res.status(400).json({ error: 'Geef ?tournament=...&matchId=... mee' });

    const db = readDB();
    const tournament = db.tournaments.find(t => t.name === tName);
    if (!tournament) return res.status(404).json({ error: 'Toernooi niet gevonden' });

    const notifiedForMatch = db.notifiedMatches[matchId] || [];

    const subDiagnose = db.subscriptions.map(sub => {
        const prefs = sub.preferences && sub.preferences[tName];
        if (!prefs || prefs.length === 0) return { endpoint: sub.endpoint.slice(-20), reden: 'geen prefs voor dit toernooi' };
        // We need player names - check against a fake match since we don't have them here
        const alGemeld = notifiedForMatch.includes(sub.endpoint);
        return { endpoint: sub.endpoint.slice(-20), prefs, alGemeld, hasKeys: !!(sub.keys && sub.keys.p256dh && sub.keys.auth) };
    });

    // Try sending a test push to the first sub that has prefs for this tournament
    const testSub = db.subscriptions.find(s => s.preferences && s.preferences[tName] && s.preferences[tName].length > 0);
    let testResult = null;
    if (testSub) {
        try {
            const payload = JSON.stringify({ title: '🔔 Push diagnose test', body: `Tournament: ${tName}`, icon: '/icon-192x192.png', badge: '/icon-192x192.png' });
            await webpush.sendNotification(testSub, payload);
            testResult = { success: true, endpoint: testSub.endpoint.slice(-20) };
        } catch (err) {
            testResult = { success: false, endpoint: testSub.endpoint.slice(-20), statusCode: err.statusCode, message: err.message, body: err.body };
        }
    }

    res.json({ isFirstRun, tName, notifiedForMatch: notifiedForMatch.map(ep => ep.slice(-20)), subDiagnose, testResult });
});

app.get('/api/admin/debug-subscriptions', (req, res) => {
    const db = readDB();
    const result = db.tournaments.map(t => {
        const allSubPlayers = db.subscriptions
            .flatMap(sub => (sub.preferences && sub.preferences[t.name]) || []);
        const extraFromSubs = [...new Set(allSubPlayers)];
        return {
            tournament: t.name,
            unlisted: t.unlisted || false,
            dartersInDB: t.darters || [],
            extraFromSubscriptions: extraFromSubs,
            subscriptionsWithPrefs: db.subscriptions
                .filter(sub => sub.preferences && sub.preferences[t.name] && sub.preferences[t.name].length > 0)
                .map(sub => ({ endpoint: sub.endpoint.slice(-20), players: sub.preferences[t.name] }))
        };
    });
    res.json({ subscriptionCount: db.subscriptions.length, tournaments: result });
});

app.get('/api/admin/system-status', (req, res) => {
    res.json({
        uptimeSeconds: Math.floor(process.uptime()),
        startedAt: systemStatus.startedAt,
        poule: {
            ...systemStatus.poule,
            cacheTournaments: Object.keys(pouleStandingsCache).length
        },
        matches: {
            ...systemStatus.matches,
            cacheKeys: Object.keys(matchCache).length
        },
        push: systemStatus.push,
        recentErrors: systemStatus.recentErrors
    });
});

// --- DARTCONNECT API INTEGRATIE ---
app.get('/api/dartconnect-events', async (req, res) => {
    const { category = 'featured', limit = 50 } = req.query;

    const validCategories = ['featured', 'zmember', 'league'];
    if (!validCategories.includes(category)) {
        return res.status(400).json({ error: 'Ongeldige categorie. Kies uit: featured, zmember, league' });
    }

    try {
        const url = `https://tv.dartconnect.com/api/events/${category}/scheduled`;
        const response = await axios.post(url, {}, { timeout: 10000 });

        let events = [];
        const data = response.data?.payload || response.data || {};

        // Extraheer events uit de API response
        if (Array.isArray(data)) {
            events = data;
        } else if (data.events && Array.isArray(data.events)) {
            events = data.events;
        } else if (data.data && Array.isArray(data.data)) {
            events = data.data;
        }

        // Parse en filter de events
        const parsed = events
            .filter(e => e && e.event_id && (e.event_name || e.engname))
            .map(e => ({
                id: e.event_id,
                name: e.event_name || e.engname || 'Onbekend toernooi',
                date: e.start_date || e.date || null,
                venue: e.venue || e.location || null,
                category: category,
                eventUrl: `https://tv.dartconnect.com/event/${e.event_id}/bracket/1`,
                apiUrl: `https://tv.dartconnect.com/api/event/${e.event_id}/bracket/1`
            }))
            .sort((a, b) => {
                if (a.date && b.date) {
                    return new Date(a.date) - new Date(b.date);
                }
                return 0;
            })
            .slice(0, parseInt(limit, 10));

        res.json({
            category,
            count: parsed.length,
            events: parsed
        });
    } catch (error) {
        console.error(`Fout bij ophalen DartConnect events (${category}):`, error.message);
        res.status(500).json({
            error: 'Kon events niet ophalen van DartConnect',
            details: error.message
        });
    }
});

app.listen(PORT, () => console.log(`🎯 Server draait op http://localhost:${PORT}`));
