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
    if (!fs.existsSync(DB_FILE)) return { tournaments: [] };
    let db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    if (!db.tournaments) db.tournaments = [];
    db.tournaments.forEach(t => { if (!t.darters) t.darters = []; });
    return db;
}

function writeDB(data) {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

app.get('/api/settings', (req, res) => res.json(readDB()));
app.post('/api/settings', (req, res) => {
    writeDB(req.body);
    res.json({ success: true, message: "Instellingen opgeslagen!" });
});

app.get('/api/tournaments', (req, res) => {
    const db = readDB();
    res.json(db.tournaments.map(t => t.name));
});

app.get('/api/matches', async (req, res) => {
    const requestedTournament = req.query.tournament;
    const db = readDB();
    const tournament = db.tournaments.find(t => t.name === requestedTournament);

    if (!tournament) return res.json([]);

    let rawMatches = [];

    try {
        const response = await axios.post(tournament.url, {});
        
        let dataContainer = response.data.payload || response.data || {};
        let bronMap = dataContainer.proBracket || dataContainer.bracketData || dataContainer;
        
        let spelersDict = {};
        function bouwWoordenboek(obj) {
            if (!obj || typeof obj !== 'object') return;
            if (obj.name && (obj.dcid || obj.id || obj.player_id)) {
                let spelerId = obj.dcid || obj.id || obj.player_id;
                spelersDict[spelerId] = obj.name;
            }
            Object.values(obj).forEach(val => bouwWoordenboek(val));
        }
        bouwWoordenboek(dataContainer);

        let matchesList = [];
        function zoekWedstrijden(obj) {
            if (!obj || typeof obj !== 'object') return;
            if ('p1' in obj || 'd1' in obj) {
                matchesList.push(obj);
            } else {
                Object.values(obj).forEach(val => zoekWedstrijden(val));
            }
        }
        zoekWedstrijden(bronMap);

        function getSpelerNaam(idOrArray) {
            if (!idOrArray) return "Onbekend";
            if (Array.isArray(idOrArray)) {
                const validIds = idOrArray.filter(id => id && id !== -1);
                if (validIds.length === 0) return "Onbekend";
                const namen = validIds.map(id => spelersDict[id] || `Speler ${id}`);
                return namen.join(" & ");
            }
            if (idOrArray === -1) return "Onbekend";
            return spelersDict[idOrArray] || `Speler ${idOrArray}`;
        }

        if (matchesList.length > 0) {
            const matchesMetToernooi = matchesList.map(m => {
                let matchId = m.id || m.match_id || "";
                if (typeof matchId === 'string') matchId = matchId.replace('_', '-');

                let markerData = m.ch && m.ch.v ? m.ch.v : null;
                let markerNaam = "";
                if (Array.isArray(markerData) || typeof markerData === 'number') {
                    markerNaam = getSpelerNaam(markerData);
                } else if (typeof markerData === 'string') {
                    markerNaam = markerData;
                }

                return {
                    id: matchId,
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

    } catch (error) {
        console.error("Fout:", error.message);
        return res.status(500).json({ error: "Kon data niet ophalen" });
    }

    // --- FILTEREN, VOORSPELLEN EN SORTEREN ---
    const dartersLower = (tournament.darters || []).map(d => d.toLowerCase());
    let definitieveLijst = [];
    let toegevoegdeIds = new Set();

    let eigenWedstrijden = rawMatches.filter(match => {
        return dartersLower.some(d => 
            match.player1.toLowerCase().includes(d) || 
            match.player2.toLowerCase().includes(d) || 
            (match.marker && match.marker.toLowerCase().includes(d))
        );
    });

    eigenWedstrijden.forEach(match => {
        match.status = (match.isFinished || (match.score1 !== "" && match.score2 !== "")) ? "gespeeld" : "gepland";
        match.isMogelijk = false;
        
        let isSpeler = dartersLower.find(d => match.player1.toLowerCase().includes(d) || match.player2.toLowerCase().includes(d));
        let isMarker = dartersLower.find(d => match.marker && match.marker.toLowerCase().includes(d));

        if (!isSpeler && isMarker && match.status === "gespeeld") {
            return; 
        }

        match.rol = (!isSpeler && isMarker) ? "marker" : "speler";

        if (match.status === "gespeeld" && isSpeler) {
            const isP1 = match.player1.toLowerCase().includes(isSpeler);
            const s1 = (match.score1 === 'W' || match.score1 === 'X') ? 99 : (match.score1 === 'F' ? -1 : parseInt(match.score1) || 0);
            const s2 = (match.score2 === 'W' || match.score2 === 'X') ? 99 : (match.score2 === 'F' ? -1 : parseInt(match.score2) || 0);
            match.resultaat = (isP1 && s1 > s2) || (!isP1 && s2 > s1) ? "win" : "verlies";
        }

        definitieveLijst.push(match);
        toegevoegdeIds.add(match.id);
    });

    eigenWedstrijden.forEach(match => {
        let isSpeler = tournament.darters.find(d => 
            (match.player1 && match.player1.toLowerCase().includes(d.toLowerCase())) || 
            (match.player2 && match.player2.toLowerCase().includes(d.toLowerCase()))
        );

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
        return tijdA.localeCompare(tijdB) || (parseInt(a.board) || 999) - (parseInt(b.board) || 999);
    });

    res.json(definitieveLijst);
});

app.listen(PORT, () => console.log(`🎯 Server draait op http://localhost:${PORT}`));
