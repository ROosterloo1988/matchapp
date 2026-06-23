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

// --- TENANT IDENTIFICATION (subdomain-based) ---
app.use((req, res, next) => {
    const hostname = req.hostname || 'localhost';
    const parts = hostname.split('.');
    let tenantId = '__master__';

    // Extract subdomain as tenant ID (e.g., org1.dartapp.nl → org1)
    if (parts.length > 2 && parts[0] !== 'localhost' && parts[0] !== 'www') {
        tenantId = parts[0].toLowerCase();
    }

    req.tenant = tenantId;
    next();
});

// --- ADMIN BEVEILIGING (MULTI-TENANT BASIC AUTH) ---
const DEFAULT_MASTER_USER = "admin";
const DEFAULT_MASTER_PASS = "dutchopen2026";

app.use('/admin.html', (req, res, next) => {
    const b64auth = (req.headers.authorization || '').split(' ')[1] || '';
    const [login, password] = Buffer.from(b64auth, 'base64').toString().split(':');

    if (!login || !password) {
        res.set('WWW-Authenticate', 'Basic realm="Admin Area"');
        return res.status(401).send('Inloggen vereist voor beheer.');
    }

    const db = readDB();
    const tenant = db.tenants.find(t => t.id === req.tenant);

    if (!tenant) {
        res.set('WWW-Authenticate', 'Basic realm="Admin Area"');
        return res.status(401).send('Tenant niet gevonden.');
    }

    // Check tenant credentials
    const credMatch = login === tenant.adminUser && password === (tenant.adminPass || DEFAULT_MASTER_PASS);

    if (credMatch) {
        req.tenantData = tenant;
        return next();
    }

    res.set('WWW-Authenticate', 'Basic realm="Admin Area"');
    res.status(401).send('Ongeldig inloggegevens.');
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
        memDB = {
            tenants: [{ id: '__master__', adminUser: 'admin', adminPassHash: null, createdAt: new Date().toISOString() }],
            tournaments: [],
            subscriptions: [],
            notifiedMatches: [],
            notifiedPoules: [],
            vapidKeys: null
        };
        return memDB;
    }

    let db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    if (!db.tournaments) db.tournaments = [];
    if (!db.subscriptions) db.subscriptions = [];
    if (!db.notifiedMatches) db.notifiedMatches = [];
    if (!db.notifiedPoules) db.notifiedPoules = [];
    if (!db.tenants) db.tenants = [{ id: '__master__', adminUser: 'admin', adminPassHash: null, createdAt: new Date().toISOString() }];
    db.tournaments.forEach(t => { if (!t.darters) t.darters = []; if (!t.tenant) t.tenant = '__master__'; });
    db.subscriptions.forEach(s => { if (!s.tenant) s.tenant = '__master__'; });
    db.notifiedMatches.forEach(m => { if (!m.tenant) m.tenant = '__master__'; });
    db.notifiedPoules.forEach(p => { if (!p.tenant) p.tenant = '__master__'; });

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
    const tournament = db.tournaments.find(t => t.name === req.query.tournament && t.tenant === req.tenant);
    res.json(tournament && tournament.darters ? tournament.darters : []);
});

app.post('/api/subscribe', (req, res) => {
    const { subscription, tournament, players } = req.body;
    const db = readDB();

    let existingSub = db.subscriptions.find(sub => sub.endpoint === subscription.endpoint && sub.tenant === req.tenant);

    if (!existingSub) {
        existingSub = subscription;
        existingSub.preferences = {};
        existingSub.tenant = req.tenant;
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
    const tenantId = req.tenant;
    return res.json({
        tournaments: db.tournaments.filter(t => t.tenant === tenantId),
        subscriptions: db.subscriptions.filter(s => s.tenant === tenantId),
        notifiedMatches: db.notifiedMatches.filter(m => m.tenant === tenantId),
        notifiedPoules: db.notifiedPoules.filter(p => p.tenant === tenantId),
        vapidKeys: db.vapidKeys
    });
});

app.post('/api/settings', (req, res) => {
    const b64auth = (req.headers.authorization || '').split(' ')[1] || '';
    const [login, password] = Buffer.from(b64auth, 'base64').toString().split(':');

    if (!login || !password) return res.status(401).send("Onbevoegd");

    const db = readDB();
    const tenant = db.tenants.find(t => t.id === req.tenant);

    if (!tenant || (login !== tenant.adminUser || password !== (tenant.adminPass || DEFAULT_MASTER_PASS))) {
        return res.status(401).send("Onbevoegd");
    }

    // Update only tenant-specific data
    const tenantId = req.tenant;
    const body = req.body;

    if (body.tournaments) {
        db.tournaments = db.tournaments.filter(t => t.tenant !== tenantId).concat(
            body.tournaments.map(t => ({ ...t, tenant: tenantId }))
        );
    }
    if (body.subscriptions) {
        db.subscriptions = db.subscriptions.filter(s => s.tenant !== tenantId).concat(
            body.subscriptions.map(s => ({ ...s, tenant: tenantId }))
        );
    }
    if (body.notifiedMatches) {
        db.notifiedMatches = db.notifiedMatches.filter(m => m.tenant !== tenantId).concat(
            body.notifiedMatches.map(m => ({ ...m, tenant: tenantId }))
        );
    }
    if (body.notifiedPoules) {
        db.notifiedPoules = db.notifiedPoules.filter(p => p.tenant !== tenantId).concat(
            body.notifiedPoules.map(p => ({ ...p, tenant: tenantId }))
        );
    }

    writeDB(db);
    res.json({ success: true, message: "Instellingen opgeslagen!" });
});

app.get('/api/tournaments', (req, res) => {
    const db = readDB();
    const publicTournaments = db.tournaments.filter(t => !t.unlisted && t.tenant === req.tenant);
    res.json(publicTournaments.map(t => t.name));
});

app.get('/api/tournaments/valid', (req, res) => {
    const db = readDB();
    res.json(db.tournaments.filter(t => t.tenant === req.tenant).map(t => t.name));
});


app.get('/api/tournament-config', (req, res) => {
    const db = readDB();
    const tournament = db.tournaments.find(t => t.name === req.query.tournament && t.tenant === req.tenant);

    if (!tournament) {
        return res.status(404).json({ error: 'Toernooi niet gevonden.' });
    }

    const urls = (tournament.url || '').split(',').map(u => u.trim()).filter(Boolean);
    const hasPoulePhase = urls.length >= 2;

    res.json({
        name: tournament.name,
        url: tournament.url || '',
        darters: Array.isArray(tournament.darters) ? tournament.darters : [],
        unlisted: !!tournament.unlisted,
        hasPoulePhase
    });
});

app.post('/api/user-add-tournament', async (req, res) => {
    const { name, url, darters } = req.body;
    const db = readDB();

    if (!db.tournaments.find(t => t.name === name && t.tenant === req.tenant)) {
        db.tournaments.push({
            name, url, matchlistUrl: "", darters,
            unlisted: true, tenant: req.tenant
        });
        writeDB(db);
    } else {
        let existingT = db.tournaments.find(t => t.name === name && t.tenant === req.tenant);
        if(existingT && existingT.unlisted) {
            darters.forEach(d => { if(!existingT.darters.includes(d)) existingT.darters.push(d); });
            writeDB(db);
        }
    }
    res.json({ success: true });
});

// --- DE VERNIEUWDE SPELER PREVIEW (MET FALLBACK VOOR ONGEPLANDE TOERNOOIEN) ---
app.post('/api/fetch-players-preview', async (req, res) => {
    const { url } = req.body;
    let spelers = new Set();
    const dcHeaders = await getDcHeaders();

    function zoekNamen(obj) {
        if (obj && typeof obj === 'object') {
            if (obj.name) spelers.add(obj.name);
            if (obj.full_name) spelers.add(obj.full_name); // Check voor de pre-draw API
            Object.values(obj).forEach(val => zoekNamen(val));
        }
    }

    // Probeer alle URLs (voor multi-discipline toernooien)
    const urls = (url || '').split(',').map(u => u.trim()).filter(Boolean);
    for (const singleUrl of urls) {
        try {
            const response = await axios.post(singleUrl, {}, { headers: dcHeaders, timeout: 8000 });
            let dataContainer = response.data.payload || response.data || {};
            zoekNamen(dataContainer);
        } catch (e) {
            console.error("Fout bij ophalen spelers via URL:", singleUrl);
        }
    }

    // SLIM REDMIDDEL: Als er nog geen spelers zijn gevonden
    if (spelers.size === 0 && url) {
        const firstUrl = urls[0];
        let match = firstUrl.match(/\/api\/event\/([^\/]+)\/(?:bracket|round-robin)\/(\d+)/i);
        if (match) {
            let tName = match[1];
            let eId = match[2];

            // Probeer alle sub-events van het event ophalen en spelers eruit halen
            try {
                const matchesUrl = `https://tv.dartconnect.com/api/event/${tName}/matches`;
                const matchesResp = await axios.post(matchesUrl, {}, { headers: dcHeaders, timeout: 8000 });
                const subEvents = matchesResp.data?.payload?.events || [];

                // Fetch each sub-event to find players
                for (const se of subEvents) {
                    const seUrl = `https://tv.dartconnect.com/api/event/${tName}/bracket/${se.id}`;
                    try {
                        const seResp = await axios.post(seUrl, {}, { headers: dcHeaders, timeout: 8000 });
                        zoekNamen(seResp.data.payload || seResp.data || {});
                    } catch (e) {
                        // continue
                    }
                }
            } catch (err) {
                console.error("Fout bij fallback sub-events fetch:", err.message);
            }

            // Laatste fallback: confirmation endpoint
            if (spelers.size === 0) {
                let fallbackUrl = `https://tv.dartconnect.com/api/event/${tName}/confirmation/${eId}/players`;
                try {
                    console.log("Geen spelers gevonden. Fallback inschakelen:", fallbackUrl);
                    const fallbackResponse = await axios.post(fallbackUrl, {}, { headers: dcHeaders, timeout: 8000 });
                    let fallbackData = fallbackResponse.data.payload || fallbackResponse.data || {};
                    zoekNamen(fallbackData);
                } catch (err) {
                    console.error("Fout bij ophalen spelers via fallback URL:", fallbackUrl);
                }
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
async function fetchMatchesForTournament(requestedTournament, extraDarters = [], tenantId = '__master__') {
    const db = readDB();
    const tournament = db.tournaments.find(t => t.name === requestedTournament && t.tenant === tenantId);
    if (!tournament) return [];

    let rawMatches = [];
    let dcMatchesList = [];
    let spelersDict = {};

    const dcHeaders = await getDcHeaders();

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
                const response = await axios.post(bUrl, {}, { headers: dcHeaders, timeout: 10000 });
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
                mUrlsToFetch.add(`https://tv.dartconnect.com/event/${eventMatch[1]}/state/matches?fetch_type=initial`);
                mUrlsToFetch.add(`https://tv.dartconnect.com/api/event/${eventMatch[1]}/matches`);
            }
        });
        
        if (tournament.matchlistUrl) {
            tournament.matchlistUrl.split(',').map(u => u.trim()).filter(u => u !== "").forEach(u => mUrlsToFetch.add(u));
        }

        for (let mUrl of Array.from(mUrlsToFetch)) {
            try {
                let mlRes = await axios.get(mUrl, { headers: dcHeaders, timeout: 8000 }).catch(() => axios.post(mUrl, {}, { headers: dcHeaders, timeout: 8000 }));
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

            // --- HET NIEUWE, ROBUUSTE RONDE-DETECTIE SYSTEEM ---
            let rondeNaam = "Ronde ?";
            
            // 1. Detecteer de fase op basis van Event Label (el) of bracket type
            let fase = "";
            if (m.el === "Winner's KO") fase = "Winnaarsronde";
            else if (m.el === "Consolation KO") fase = "Verliezersronde";
            else if (m.el === "Round Robin" || m._bracket_type === "Groepsfase") fase = "Poule";
            else fase = m.el || "";

            // 2. Vertaal de 'r' (T-code) naar leesbare tekst (bijv. T16 -> Laatste 16)
            if (m.r && typeof m.r === 'string' && m.r.startsWith('T')) {
                let aantal = parseInt(m.r.substring(1), 10);
                if (aantal === 1) rondeNaam = "Finale";
                else if (aantal === 2) rondeNaam = "Halve Finale";
                else if (aantal === 4) rondeNaam = "Kwartfinale";
                else if (aantal === 8) rondeNaam = "Laatste 16";
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

        // Fallback: als bracket-parse niets opleverde maar matchlist wel data heeft,
        // bouw wedstrijden direct uit matchlistData (werkt voor round-robin events)
        if (dcConverted.length === 0 && matchlistData.length > 0) {
            matchlistData.forEach(match => {
                const p1Name = match.hcf || match.hc || match.p1;
                const p2Name = match.acf || match.ac || match.p2;
                if (!p1Name || !p2Name) return;
                const matchId = (match.mi || match.match_id || "").toString();
                let rondeNaam = "Ronde ?";
                if (match.el && match.el.toLowerCase().includes("round robin")) {
                    rondeNaam = match.r && isNaN(match.r) ? "Poule " + match.r : "Poule";
                } else if (match.r && typeof match.r === 'string' && match.r.startsWith('T')) {
                    const n = parseInt(match.r.substring(1), 10);
                    rondeNaam = n === 1 ? "Finale" : n === 2 ? "Halve Finale" : n === 4 ? "Kwartfinale" : "Laatste " + n;
                } else if (match.rn) {
                    rondeNaam = match.rn;
                }
                const fS1 = match.hs !== undefined ? match.hs : (match.s1 !== undefined ? match.s1 : "");
                const fS2 = match.as !== undefined ? match.as : (match.s2 !== undefined ? match.s2 : "");
                const isActive = !!match._is_active_now;
                const isFinished = !isActive && !!(match._is_completed_now || match.sta === 'C' || match.sta === 'P' || match.sta === 'F');
                rawMatches.push({
                    id: matchId, db_id: matchId, n: null, p1m: null, p2m: null,
                    raw_p1: null, raw_p2: null, _bron_url: null,
                    ronde: rondeNaam, player1: String(p1Name), player2: String(p2Name),
                    marker: match.m || "", score1: fS1 !== null ? fS1 : "", score2: fS2 !== null ? fS2 : "",
                    _is_active: isActive, _detected_recap_id: matchId,
                    watchId: match.sk || match.tk || match.tv || "",
                    board: match.bns || match.bn || "?",
                    time: match.tm || match.t || match.st || "Niet bekend",
                    toernooi: tournament.name, isFinished, isBye: match.by === true,
                    _bracket_type: "", _tree_round_nr: 0, _tree_match_nr: 0,
                    avg1: match.hp5 || "", avg2: match.ap5 || "",
                    writer: match.m || "", country1: match.hic || "", country2: match.aic || ""
                });
            });
        }

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
                    if (!db.notifiedPoules.includes(pouleKey)) {
                        db.notifiedPoules.push(pouleKey);
                        let spelersInPoule = Array.from(pouleIndelingen[match.ronde] || []);
                        
                        if (!isFirstRun && db.subscriptions.length > 0) {
                            let activeSubs = [];
                            await Promise.all(db.subscriptions.map(async (sub) => {
                                let wilHoren = false;
                                let mijnGevolgdeSpeler = "";

                                if (sub.preferences && sub.preferences[tournament.name]) {
                                    let gekozenSpelers = sub.preferences[tournament.name];
                                    if (gekozenSpelers.length > 0) {
                                        mijnGevolgdeSpeler = gekozenSpelers.find(filter => match.player1.toLowerCase().includes(filter) || match.player2.toLowerCase().includes(filter));
                                        if (mijnGevolgdeSpeler) wilHoren = true;
                                    }
                                }

                                if (wilHoren) {
                                    try {
                                        // Maak de tekst PERSOONLIJK (Zet mijn gevolgde speler vooraan)
                                        let ik = spelersInPoule.find(p => p.toLowerCase().includes(mijnGevolgdeSpeler)) || mijnGevolgdeSpeler;
                                        let anderen = spelersInPoule.filter(p => p !== ik);
                                        let body = `${ik} is ingedeeld in ${match.ronde} met: ${anderen.join(', ')}`;
                                        
                                        const persoonlijkPayload = JSON.stringify({ title: `📊 Poule Indeling Bekend!`, body: body, icon: '/icon-192x192.png', badge: '/icon-192x192.png' });
                                        await webpush.sendNotification(sub, persoonlijkPayload);
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
                            let schrijfTekst = match.writer ? `\nSchrijver: ${match.writer}` : "";
                            let activeSubs = [];
                            
                            await Promise.all(db.subscriptions.map(async (sub) => {
                                let subIsSpeler = false;
                                let subIsMarker = false;

                                if (sub.preferences && sub.preferences[tournament.name]) {
                                    let gekozenSpelers = sub.preferences[tournament.name];
                                    if (gekozenSpelers.length > 0) {
                                        subIsSpeler = gekozenSpelers.some(filter => match.player1.toLowerCase().includes(filter) || match.player2.toLowerCase().includes(filter));
                                        subIsMarker = gekozenSpelers.some(filter => match.marker && match.marker.toLowerCase().includes(filter));
                                    }
                                }

                                if (subIsSpeler || subIsMarker) {
                                    try {
                                        let persoonlijkeTitel = titel;
                                        // Plak alléén (SCHRIJVEN) in de titel als DEZE specifieke gebruiker de schrijver volgt
                                        if (!subIsSpeler && subIsMarker) persoonlijkeTitel += " (SCHRIJVEN)";
                                        
                                        const persoonlijkPayload = JSON.stringify({
                                            title: persoonlijkeTitel,
                                            body: `${match.player1} tegen ${match.player2}\nBord: ${match.board} | Tijd: ${match.time}${schrijfTekst}`,
                                            icon: '/icon-192x192.png',
                                            badge: '/icon-192x192.png'
                                        });

                                        await webpush.sendNotification(sub, persoonlijkPayload);
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
                const parseScore = (s) => (s === 'W' || s === 99) ? 99 : ((s === 'X' || s === 'F' || s === -1) ? -1 : parseInt(s) || 0);
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
                        definitieveLijst.push({ ...mogelijkeMatch, isMogelijk: true, status: "mogelijk", mogelijkVoor: isSpeler, rol: "speler" });
                        toegevoegdeIds.add(uniekeVolgendeID);
                    }
                }
            }
        });

        // --- JOUW ORIGINELE PERFECTE TIJDLIJN SORTERING (MET SLIMME NOODREM) ---
        definitieveLijst.sort((a, b) => {
            const volgorde = { "bezig": 1, "gepland": 2, "mogelijk": 3, "gespeeld": 4 };
            if (volgorde[a.status] !== volgorde[b.status]) return volgorde[a.status] - volgorde[b.status];
            
           // Haal het logische rondenummer op. Als er een T-code is (bijv. T16), rekenen we terug.
            // Hoe kleiner het T-nummer (bijv. T2 = Halve finale), hoe verder in het toernooi, dus hoe hoger het rondenummer.
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

        return definitieveLijst;

    } catch (error) {
        console.error("Fout:", error.message);
        return [];
    }
}


let pouleStandingsCache = {};
let pouleStandingsCacheTTL = 30000; // 30 seconds

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

    const pouleUrl = urls[0];
    if (!pouleUrl || !pouleUrl.includes('/bracket/')) {
        return res.status(400).json({ error: 'Geen poule (bracket) link gevonden voor dit toernooi.' });
    }

    // Check cache freshness
    const cached = pouleStandingsCache[tName];
    if (cached && cached.cachedAt && (Date.now() - cached.cachedAt) < pouleStandingsCacheTTL) {
        if (debugParse) console.log(`[poule-standings][${tName}] cache hit (${Date.now() - cached.cachedAt}ms fresh)`);
        return res.json({ ...cached, stale: false, cached: true });
    }

    const dcHeaders = await getDcHeaders();
    try {
        const startedAt = Date.now();
        const response = await axios.post(pouleUrl, {}, { timeout: 8000, headers: dcHeaders });
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
            updatedAt: new Date().toISOString(),
            cachedAt: Date.now()
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
    const list = await fetchMatchesForTournament(tName, extraPlayers, req.tenant);
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
setInterval(runHeartbeat, 15000);

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

// --- DARTCONNECT INTEGRATIE ---

const DC_BASE_HEADERS = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/plain, */*',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Referer': 'https://tv.dartconnect.com/',
    'X-Requested-With': 'XMLHttpRequest',
};

// Haal CSRF token op van DartConnect (Laravel Sanctum)
let dcCsrfCache = null;
let dcCsrfFetchedAt = 0;

async function getDcHeaders() {
    // Cache CSRF token voor 30 minuten
    if (dcCsrfCache && (Date.now() - dcCsrfFetchedAt) < 30 * 60 * 1000) {
        return dcCsrfCache;
    }
    try {
        const r = await axios.get('https://tv.dartconnect.com/sanctum/csrf-cookie', {
            headers: DC_BASE_HEADERS,
            timeout: 6000,
        });
        const cookies = r.headers['set-cookie'] || [];
        const xsrfRaw = cookies.find(c => c.startsWith('XSRF-TOKEN='));
        const sessionRaw = cookies.find(c => c.startsWith('tv_session_18jan='));

        if (!xsrfRaw) throw new Error('Geen XSRF-TOKEN ontvangen');

        const xsrfToken = decodeURIComponent(xsrfRaw.split('=')[1].split(';')[0]);
        const cookieStr = cookies.map(c => c.split(';')[0]).join('; ');

        dcCsrfCache = {
            ...DC_BASE_HEADERS,
            'Cookie': cookieStr,
            'X-XSRF-TOKEN': xsrfToken,
        };
        dcCsrfFetchedAt = Date.now();
        console.log('[DC] CSRF token vernieuwd');
    } catch (e) {
        console.log('[DC] CSRF ophalen mislukt:', e.message);
        dcCsrfCache = DC_BASE_HEADERS; // fallback zonder CSRF
    }
    return dcCsrfCache;
}

// Haal alle aankomende events op van DartConnect (dartconnect + pdc categorie)
app.get('/api/dartconnect-browse', async (req, res) => {
    const today = new Date();
    const todayStr = today.toISOString().slice(0, 10);
    const oneWeekAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const seenIds = new Set();
    const allEvents = [];
    const errors = [];

    const endpoints = [
        { url: 'https://tv.dartconnect.com/api/events/dartconnect/soon',      keys: ['comingSoonEvents'] },
        { url: 'https://tv.dartconnect.com/api/events/dartconnect/scheduled', keys: ['liveEvents','scheduledEvents','reoccuringEvents'] },
        { url: 'https://tv.dartconnect.com/api/events/pdc/soon',              keys: ['comingSoonEvents'] },
        { url: 'https://tv.dartconnect.com/api/events/pdc/scheduled',        keys: ['liveEvents','scheduledEvents','reoccuringEvents'] },
    ];

    const dcHeaders = await getDcHeaders();
    for (const { url, keys } of endpoints) {
        try {
            const r = await axios.post(url, {}, { timeout: 8000, headers: dcHeaders });
            const data = r.data || {};
            const isSoonEndpoint = url.includes('/soon');
            for (const key of keys) {
                for (const e of (data[key] || [])) {
                    const id = e.id || e.league_id;
                    const name = e.dctv_title || e.league_name;
                    if (!id || !name) continue;
                    if (seenIds.has(String(id))) continue;
                    const isLive = e.now_playing === 1;
                    // Voor /soon: alleen vandaag en later
                    // Voor /scheduled: alleen vorige week tot vandaag
                    if (isSoonEndpoint && e.start_date && e.start_date < todayStr) continue;
                    if (!isSoonEndpoint && e.start_date && e.start_date < oneWeekAgo) continue;
                    seenIds.add(String(id));
                    allEvents.push({
                        id: String(id),
                        name,
                        date: e.start_date || null,
                        country: e.country_code || e.league_country_iso2 || null,
                        isNL: (e.country_code || e.league_country_iso2) === 'NL',
                        isLive,
                    });
                }
            }
        } catch (e) {
            errors.push(`${url.split('/').slice(-2).join('/')}: ${e.response?.status || e.message}`);
        }
    }

    // Sortering: NL eerst, dan live, dan op datum
    allEvents.sort((a, b) => {
        if (a.isNL !== b.isNL) return a.isNL ? -1 : 1;
        if (a.isLive !== b.isLive) return a.isLive ? -1 : 1;
        if (a.date && b.date) return a.date.localeCompare(b.date);
        return 0;
    });

    res.json({ count: allEvents.length, events: allEvents, errors });
});

// Detecteer de structuur van een event op basis van payload.events
app.get('/api/dartconnect-detect-format', async (req, res) => {
    const { eventId } = req.query;
    if (!eventId) return res.status(400).json({ error: 'eventId vereist' });

    const base = `https://tv.dartconnect.com/api/event/${eventId}`;

    const dcHeaders = await getDcHeaders();
    let subEvents = [];
    try {
        const r = await axios.post(`${base}/matches`, {}, { timeout: 8000, headers: dcHeaders });
        subEvents = r.data?.payload?.events || [];
    } catch (e) {
        return res.status(500).json({ error: `Kon event niet ophalen: ${e.message}` });
    }

    if (subEvents.length === 0) {
        return res.json({ eventId, format: 1, disciplines: [], urls: `${base}/bracket/1`, subEvents: [] });
    }

    // Helper: format + URLs berekenen voor een set sub-events
    function buildDiscipline(name, parts) {
        const rr = parts.filter(p => p.event_type === 'roundrobin');
        const ko = parts.filter(p => p.event_type === 'elimination');
        let format = 1;
        if (rr.length > 0 && ko.length >= 2) format = 3;
        else if (rr.length > 0 && ko.length === 1) format = 2;
        const urls = [];
        rr.forEach(p => urls.push(`${base}/bracket/${p.id}`));
        ko.forEach(p => urls.push(`${base}/bracket/${p.id}`));
        return { name, format, urls: urls.join(','), subEvents: parts.map(p => ({ id: p.id, type: p.event_type, label: p.event_label })) };
    }

    // ≤3 sub-events → altijd 1 toernooi (format 1/2/3), geen label-parsing nodig
    if (subEvents.length <= 3) {
        const d = buildDiscipline('', subEvents);
        return res.json({ eventId, format: d.format, urls: d.urls, multiDiscipline: false, disciplines: [] });
    }

    // >3 sub-events → groepeer per discipline via label-stripping
    const disciplineMap = {};
    for (const se of subEvents) {
        const label = se.event_label || '';
        const discipline = label
            .replace(/\s+(Winner'?s?\s+)?KO$/i, '')
            .replace(/\s+Cons(olation)?\s+(KO|Bracket)$/i, '')
            .replace(/\s+RR$/i, '')
            .replace(/\s+Round\s+Robin$/i, '')
            .replace(/\s+(Knock\s*out|Bracket)$/i, '')
            .replace(/\s+Elimination\s*\d*$/i, '')
            .trim() || label;

        if (!disciplineMap[discipline]) disciplineMap[discipline] = [];
        disciplineMap[discipline].push(se);
    }

    const disciplineNames = Object.keys(disciplineMap);

    // Als label-stripping niet hielp en alles 1 op 1 gemapt is, toch als 1 discipline behandelen
    if (disciplineNames.length <= 1 || disciplineNames.every(n => disciplineMap[n].length === 1)) {
        const d = buildDiscipline('', subEvents);
        return res.json({ eventId, format: d.format, urls: d.urls, multiDiscipline: false, disciplines: [] });
    }

    const disciplines = disciplineNames.map(name => buildDiscipline(name, disciplineMap[name]));
    return res.json({ eventId, format: null, urls: null, multiDiscipline: true, disciplines });
});

app.listen(PORT, () => console.log(`🎯 Server draait op http://localhost:${PORT}`));
