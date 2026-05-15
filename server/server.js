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

// --- ADMIN BEVEILIGING ---
const ADMIN_USER = "matchapp";
const ADMIN_PASS = "dutchopen2026"; 

app.use('/admin.html', (req, res, next) => {
    const b64auth = (req.headers.authorization || '').split(' ')[1] || '';
    const [login, password] = Buffer.from(b64auth, 'base64').toString().split(':');
    if (login === ADMIN_USER && password === ADMIN_PASS) return next();
    res.set('WWW-Authenticate', 'Basic realm="Admin Area"');
    res.status(401).send('Inloggen vereist.');
});

app.use(express.static(path.join(__dirname, '../public')));
const DB_FILE = path.join(__dirname, 'database.json');

// --- DATABASE SETUP ---
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

function writeDB(data) { fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2)); }

const initialDb = readDB();
webpush.setVapidDetails('mailto:jouw@email.nl', initialDb.vapidKeys.publicKey, initialDb.vapidKeys.privateKey);

app.get('/api/vapidPublicKey', (req, res) => res.send(readDB().vapidKeys.publicKey));
app.get('/api/darters', (req, res) => {
    const db = readDB();
    const t = db.tournaments.find(t => t.name === req.query.tournament);
    res.json(t ? t.darters : []);
});

app.post('/api/subscribe', (req, res) => {
    const { subscription, tournament, players } = req.body;
    const db = readDB();
    let existingSub = db.subscriptions.find(sub => sub.endpoint === subscription.endpoint);
    if (!existingSub) {
        existingSub = subscription;
        existingSub.preferences = {}; 
        db.subscriptions.push(existingSub);
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
    res.json({ success: true });
});

app.get('/api/tournaments', (req, res) => res.json(readDB().tournaments.map(t => t.name)));

let isFirstRun = true;

// --- DATA MOTOR ---
async function fetchMatchesForTournament(requestedTournament) {
    const db = readDB();
    const tournament = db.tournaments.find(t => t.name === requestedTournament);
    if (!tournament) return [];

    let spelersDict = {};
    let matchesList = [];

    try {
        let bracketUrls = tournament.url.split(',').map(u => u.trim()).filter(u => u !== "");
        for (let i = 0; i < bracketUrls.length; i++) {
            let bracketType = "";
            if (bracketUrls.length === 3) {
                bracketType = i === 0 ? "Groepsfase" : (i === 1 ? "WR" : "VR");
            } else if (bracketUrls.length === 2) {
                bracketType = i === 0 ? "Groepsfase" : "Knockout";
            }

            try {
                const response = await axios.post(bracketUrls[i], {});
                let data = response.data.payload || response.data || {};
                let bron = data.proBracket || data.bracketData || data;

                function bouwDict(obj) {
                    if (obj && typeof obj === 'object') {
                        if (obj.name && (obj.dcid || obj.id)) spelersDict[obj.dcid || obj.id] = obj.name;
                        Object.values(obj).forEach(val => bouwDict(val));
                    }
                }
                bouwDict(data);

                function zoekM(obj) {
                    if (obj && typeof obj === 'object') {
                        if ('p1' in obj || 'd1' in obj) { obj._bUrl = bracketUrls[i]; obj._type = bracketType; matchesList.push(obj); }
                        else Object.values(obj).forEach(val => zoekM(val));
                    }
                }
                zoekM(bron);
            } catch(e) {}
        }

        // --- POULE DEELNEMERS VERZAMELEN ---
        let pouleIndelingen = {}; 
        let rawMatches = matchesList.map(m => {
            let id = (m.id || m.match_id || "").toString().replace('_', '-');
            let rNaam = m._type === "Groepsfase" ? "Groepsfase" : "Ronde ?";
            
            if (m._type === "Groepsfase" && id) {
                let pM = id.match(/^([A-Za-z]+)\d+$/);
                if (pM) rNaam = "Poule " + pM[1].toUpperCase();
            }

            function getNaam(val) {
                if (!val) return "Onbekend";
                if (Array.isArray(val)) return val.filter(v => v && v !== -1).map(v => spelersDict[v] || `Speler ${v}`).join(" & ");
                return spelersDict[val] || `Speler ${val}`;
            }

            let p1 = getNaam(m.d1 || m.p1);
            let p2 = getNaam(m.d2 || m.p2);

            // Sla spelers op per poule voor de melding
            if (rNaam.startsWith("Poule ")) {
                if (!pouleIndelingen[rNaam]) pouleIndelingen[rNaam] = new Set();
                if (p1 !== "Onbekend") pouleIndelingen[rNaam].add(p1);
                if (p2 !== "Onbekend") pouleIndelingen[rNaam].add(p2);
            }

            return {
                id, player1: p1, player2: p2, ronde: rNaam, _type: m._type, _bUrl: m._bUrl,
                time: m.tm || m.t || m.time || "Niet bekend", board: m.bn || m.b || "?",
                score1: m.s1 ?? "", score2: m.s2 ?? "", isFinished: m.fn === true, toernooi: tournament.name
            };
        });

        const dartersLower = (tournament.darters || []).map(d => d.toLowerCase());
        let eigenMatches = rawMatches.filter(m => dartersLower.some(d => m.player1.toLowerCase().includes(d) || m.player2.toLowerCase().includes(d)));
        let definitieveLijst = [];
        let nieuwGeplandCount = 0;

        for (let match of eigenMatches) {
            match.status = (match.isFinished || (match.score1 !== "" && match.score2 !== "")) ? "gespeeld" : "gepland";
            if (match._type && match._type !== "Groepsfase") match.ronde += ` (${match._type})`;

            // --- PUSH LOGICA ---
            if (match.status === "gepland") {
                let isPoule = match.ronde.startsWith("Poule ");
                let hasTime = match.time.includes(':');
                let darterInMatch = dartersLower.find(d => match.player1.toLowerCase().includes(d) || match.player2.toLowerCase().includes(d));

                if (isPoule && !hasTime && darterInMatch) {
                    let pouleKey = `${tournament.name}_${darterInMatch}_${match.ronde}`;
                    if (!db.notifiedPoules.includes(pouleKey)) {
                        db.notifiedPoules.push(pouleKey);
                        let spelers = Array.from(pouleIndelingen[match.ronde] || []);
                        let ik = spelers.find(p => p.toLowerCase().includes(darterInMatch)) || darterInMatch;
                        let anderen = spelers.filter(p => p !== ik);
                        
                        await verstuurBericht(db, tournament.name, match, 
                            `📊 Poule Indeling Bekend!`, 
                            `${ik} zit in ${match.ronde} met: ${anderen.join(', ')}`);
                        nieuwGeplandCount++;
                    }
                } else if (!db.notifiedMatches.includes(match.id)) {
                    let stuur = false;
                    let titel = "";
                    if (hasTime) {
                        let ams = new Date(new Date().toLocaleString("en-US", {timeZone: "Europe/Amsterdam"}));
                        let diff = (parseInt(match.time.split(':')[0])*60 + parseInt(match.time.split(':')[1])) - (ams.getHours()*60 + ams.getMinutes());
                        if (diff <= 10 && diff >= 0) { stuur = true; titel = "🎯 Over 10 minuten!"; }
                    } else if (!isPoule) { stuur = true; titel = "🎯 Nieuwe wedstrijd!"; }

                    if (stuur) {
                        db.notifiedMatches.push(match.id);
                        await verstuurBericht(db, tournament.name, match, titel, `${match.player1} vs ${match.player2}\nBord: ${match.board}`);
                        nieuwGeplandCount++;
                    }
                }
            }
            definitieveLijst.push(match);
        }
        if (nieuwGeplandCount > 0) writeDB(db);
        return definitieveLijst.sort((a,b) => a.status === "gespeeld" ? b.time.localeCompare(a.time) : a.time.localeCompare(b.time));
    } catch (e) { return []; }
}

async function verstuurBericht(db, tName, match, titel, body) {
    if (isFirstRun || db.subscriptions.length === 0) return;
    const payload = JSON.stringify({ title: titel, body: body });
    for (let sub of db.subscriptions) {
        let wil = sub.preferences && sub.preferences[tName] && sub.preferences[tName].some(f => match.player1.toLowerCase().includes(f) || match.player2.toLowerCase().includes(f));
        if (wil) { try { await webpush.sendNotification(sub, payload); } catch(e) {} }
    }
}

app.get('/api/matches', async (req, res) => res.json(await fetchMatchesForTournament(req.query.tournament)));
app.post('/api/admin/send-push', async (req, res) => {
    const { title, body } = req.body;
    const db = readDB();
    const payload = JSON.stringify({ title: title || "🎯 DartApp", body: body || "" });
    for (let sub of db.subscriptions) { try { await webpush.sendNotification(sub, payload); } catch(e) {} }
    res.json({ success: true });
});

setInterval(async () => { const db = readDB(); for (let t of db.tournaments) await fetchMatchesForTournament(t.name); isFirstRun = false; }, 60000);
app.listen(PORT, () => console.log(`🎯 Draait op poort ${PORT}`));
