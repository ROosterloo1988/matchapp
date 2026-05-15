const axios = require('axios');

async function fetchMatches(url, tournamentName, bracketType) {
    try {
        const response = await axios.get(url);
        let matches = response.data.matches || (Array.isArray(response.data) ? response.data : []);
        
        return matches.map(m => {
            let p1 = m.participantHome ? m.participantHome.displayName : "Onbekend";
            let p2 = m.participantGuest ? m.participantGuest.displayName : "Onbekend";
            let marker = m.writer ? m.writer.displayName : "";
            
            let time = "Niet bekend";
            if (m.beginDate) time = m.beginDate.substring(11, 16);
            else if (m.dateReady) time = m.dateReady.substring(11, 16);
            else if (m.created) time = m.created.substring(11, 16);

            let rNaam = "Ronde ?";
            if (m.round && m.round.name) {
                rNaam = m.round.name.replace(/Group /i, 'Poule ');
            }
            if (bracketType === "Groepsfase" && !rNaam.toLowerCase().includes("poule")) rNaam = "Groepsfase";

            return {
                id: (m.id || "").toString(),
                player1: p1,
                player2: p2,
                marker: marker,
                ronde: rNaam,
                _type: bracketType,
                _bUrl: url,
                time: time,
                board: m.board || "?",
                score1: m.legsHome !== null ? m.legsHome : "",
                score2: m.legsAway !== null ? m.legsAway : "",
                isFinished: m.statusCd === "FINISH",
                toernooi: tournamentName,
                source: '2kdarts'
            };
        });
    } catch (e) {
        console.error("Fout in 2K Darts module (" + url + "):", e.message);
        return [];
    }
}

module.exports = { fetchMatches };
