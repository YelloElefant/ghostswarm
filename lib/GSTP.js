const crypto = require('crypto');

class GSTP {
    constructor(botId, tcpPort) {
        this.botId = botId;
        this.tcpPort = tcpPort;
    }

    T = {
        YO: "YO",
        OY: "OY",
        DM: "DM",
        MD: "MD",
        BROADCAST: "BROADCAST",
        TSACDAORB: "TSACDAORB",
        STATUS: "STATUS",
        SUTATS: "SUTATS",
        LIST: "LIST",
        TSIL: "TSIL",
        TORRENT: "TORRENT",
        SWARM: "SWARM",
        HAVE: "HAVE",
        GET: "GET",
        TEG: "TEG",
        CLOSE: "CLOSE",
    };

    mkYO() {
        return {
            v: 1,
            t: this.T.YO,
            id: this.uid(),
            rid: this.uid(),
            ttl: 8,
            ts: this.now(),
            src: this.botId,
            sig: null,
            body: {
                me: this.botId,
                port: this.tcpPort,
                win: 64
            }
        };
    }

    mkOY(rid) {
        return {
            v: 1,
            t: this.T.OY,
            id: this.uid(),
            rid: rid,
            ttl: 8,
            ts: this.now(),
            src: this.botId,
            sig: null,
            body: {
                ok: true,
                me: this.botId,
            }
        };
    }

    mkDM(to, data) {
        return {
            v: 1,
            t: this.T.DM,
            id: this.uid(),
            rid: this.uid(),
            ttl: 8,
            ts: this.now(),
            src: this.botId,
            sig: null,
            body: {
                to: to,
                data: data
            }
        };
    }

    mkMD(rid, data) {
        return {
            v: 1,
            t: this.T.MD,
            id: this.uid(),
            rid: rid,
            ttl: 8,
            ts: this.now(),
            src: this.botId,
            sig: null,
            body: {
                to: rid,
                data: data
            }
        };
    }

    mkSTATUS() {
        return {
            v: 1,
            t: this.T.STATUS,
            id: this.uid(),
            rid: this.uid(),
            ttl: 8,
            ts: this.now(),
            src: this.botId,
            sig: null,
            body: {
                me: this.botId
            }
        };
    }

    mkSUTATS(rid, status) {
        return {
            v: 1,
            t: this.T.SUTATS,
            id: this.uid(),
            rid: rid,
            ttl: 8,
            ts: this.now(),
            src: this.botId,
            sig: null,
            body: {
                me: this.botId,
                status: status
            }
        };
    }

    mkLIST() {
        return {
            v: 1,
            t: this.T.LIST,
            id: this.uid(),
            rid: this.uid(),
            ttl: 8,
            ts: this.now(),
            src: this.botId,
            sig: null,
            body: {
                me: this.botId
            }
        };
    }

    mkTSIL(rid, torrents) {
        return {
            v: 1,
            t: this.T.TSIL,
            id: this.uid(),
            rid: rid,
            ttl: 8,
            ts: this.now(),
            src: this.botId,
            sig: null,
            body: {
                me: this.botId,
                torrents: torrents
            }
        };
    }

    mkTORRENT(torrent) {
        return {
            v: 1,
            t: this.T.TORRENT,
            id: this.uid(),
            rid: null,
            ttl: 8,
            ts: this.now(),
            src: this.botId,
            sig: null,
            body: {
                torrent: torrent
            }
        };
    }

    // Tells every bot to start (on) or stop downloading a torrent
    mkSWARM(hash, on) {
        return this.pkt(this.T.SWARM, null, { hash, on });
    }

    // Announces which chunks we hold for a torrent (hex bitfield)
    mkHAVE(hash, have) {
        return this.pkt(this.T.HAVE, null, { hash, have });
    }

    // Requests one chunk; the TEG reply carries rid = this packet's id
    mkGET(hash, index) {
        return this.pkt(this.T.GET, this.uid(), { hash, index });
    }

    mkTEG(rid, body) {
        return this.pkt(this.T.TEG, rid, body);
    }

    pkt(t, rid, body) {
        return {
            v: 1,
            t: t,
            id: this.uid(),
            rid: rid,
            ttl: 8,
            ts: this.now(),
            src: this.botId,
            sig: null,
            body: body
        };
    }

    mkBROADCAST(topic, data) {
        return {
            v: 1,
            t: this.T.BROADCAST,
            id: this.uid(),
            rid: null,
            ttl: 8,
            ts: this.now(),
            src: this.botId,
            sig: null,
            body: {
                topic: topic,
                data: data
            }
        };
    }

    mkTSACDAORB() {
        return {
            v: 1,
            t: this.T.TSACDAORB,
            id: this.uid(),
            rid: null,
            ttl: 8,
            ts: this.now(),
            src: this.botId,
            sig: null,
        };
    }

    uid() {
        return crypto.randomBytes(16).toString("hex");
    }

    now() {
        return Date.now();
    }
}

module.exports = GSTP;