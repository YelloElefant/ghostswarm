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
                me: this.botId,
                status: state.getStatus()
            }
        };
    }

    mkSUTATS(rid) {
        return {
            v: 1,
            t: this.T.SUTATS,
            id: this.uid(),
            rid: rid,
            ttl: 8,
            ts: this.now(),
            src: this.botId,
            sig: null,
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