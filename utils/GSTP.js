const crypto = require('crypto');

class GSTP {
    constructor(botId, tcpPort) {
        this.botId = botId;
        this.tcpPort = tcpPort;
    }

    T = {
        YO: "YO",
        SUP: "SUP",
        UUP: "UUP",
        YUP: "YUP",
        FRIENDS: "FRIENDS",
        BLAST: "BLAST",
        DM: "DM",
        BET: "BET",
        NOPE: "NOPE",
        CHILL: "CHILL",
        OOPS: "OOPS",
        GTG: "GTG"
    };

    now() {
        return Date.now();
    }

    ewma(prev, x, a) {
        if (typeof a !== "number") a = 0.3;
        if (prev === null || typeof prev === "undefined") return x;
        return a * x + (1 - a) * prev;
    }

    myHost() {
        return "127.0.0.1";
    } // replace with 100.x for Tailscale in prod

    uid() {
        if (typeof crypto.randomUUID === "function") {
            return crypto.randomUUID();
        }
        return crypto.randomBytes(16).toString("hex");
    }

    enc(obj) {
        const b = Buffer.from(JSON.stringify(obj));
        const h = Buffer.alloc(4);
        h.writeUInt32BE(b.length);
        return Buffer.concat([h, b]);
    }

    makeDecoder(onMsg) {
        let buf = Buffer.alloc(0);
        return (chunk) => {
            buf = Buffer.concat([buf, chunk]);
            while (buf.length >= 4) {
                const L = buf.readUInt32BE(0);
                if (buf.length < 4 + L) break;
                const body = buf.subarray(4, 4 + L);
                buf = buf.subarray(4 + L);
                try {
                    const o = JSON.parse(body.toString("utf8"));
                    onMsg(o);
                } catch (e) {
                    /* ignore parse errors */
                }
            }
        };
    }

    mkYO() {
        return {
            v: 1,
            t: this.T.YO,
            id: this.uid(),
            rid: null,
            ttl: 8,
            ts: this.now(),
            src: this.botId,
            sig: null,
            body: {
                me: this.botId,
                port: this.tcpPort,
                flex: ["pubsub"],
                win: 64
            }
        };
    }

    mkSUP(rid) {
        return {
            v: 1,
            t: this.T.SUP,
            id: this.uid(),
            rid: rid,
            ttl: 8,
            ts: this.now(),
            src: this.botId,
            sig: null,
            body: {
                ok: true,
                me: this.botId,
                win: 64
            }
        };
    }

    mkUUP() {
        return {
            v: 1,
            t: this.T.UUP,
            id: this.uid(),
            rid: null,
            ttl: 8,
            ts: this.now(),
            src: this.botId,
            sig: null,
            body: {
                t: this.now()
            }
        };
    }

    mkYUP(t) {
        return {
            v: 1,
            t: this.T.YUP,
            id: this.uid(),
            rid: null,
            ttl: 8,
            ts: this.now(),
            src: this.botId,
            sig: null,
            body: {
                t: t
            }
        };
    }

    mkFRIENDS(l) {
        return {
            v: 1,
            t: this.T.FRIENDS,
            id: this.uid(),
            rid: null,
            ttl: 8,
            ts: this.now(),
            src: this.botId,
            sig: null,
            body: {
                list: l
            }
        };
    }

    mkBLAST(topic, data) {
        return {
            v: 1,
            t: this.T.BLAST,
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

    mkDM(to, op, data, ttl) {
        return {
            v: 1,
            t: this.T.DM,
            id: this.uid(),
            rid: null,
            ttl: (typeof ttl === "number" ? ttl : 8),
            ts: this.now(),
            src: this.botId,
            sig: null,
            body: {
                to: to,
                op: op,
                data: data
            }
        };
    }

    mkBET(rid, reason) {
        if (typeof reason !== "string") reason = "";
        return {
            v: 1,
            t: this.T.BET,
            id: this.uid(),
            rid: rid,
            ttl: 8,
            ts: this.now(),
            src: this.botId,
            sig: null,
            body: {
                reason: reason
            }
        };
    }

    mkNOPE(rid, reason) {
        if (typeof reason !== "string") reason = "";
        return {
            v: 1,
            t: this.T.NOPE,
            id: this.uid(),
            rid: rid,
            ttl: 8,
            ts: this.now(),
            src: this.botId,
            sig: null,
            body: {
                reason: reason
            }
        };
    }

    clampWin(w) {
        const n = parseInt(w, 10);
        if (isNaN(n)) return 64;
        if (n < 1) return 1;
        if (n > 256) return 256;
        return n;
    }

    mkCHILL(win) {
        return {
            v: 1,
            t: this.T.CHILL,
            id: this.uid(),
            rid: null,
            ttl: 8,
            ts: this.now(),
            src: this.botId,
            sig: null,
            body: {
                win: this.clampWin(win)
            }
        };
    }

    mkGTG(why) {
        if (typeof why !== "string") why = "";
        return {
            v: 1,
            t: this.T.GTG,
            id: this.uid(),
            rid: null,
            ttl: 8,
            ts: this.now(),
            src: this.botId,
            sig: null,
            body: {
                why: why
            }
        };
    }

    sampleKnown(arr, k) {
        if (typeof k !== "number") k = 16;
        const copy = Array.from(arr);
        for (let i = copy.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            const tmp = copy[i];
            copy[i] = copy[j];
            copy[j] = tmp;
        }
        return copy.slice(0, k);
    }

    cloneWithTTL(msg, ttl) {
        const m = Object.assign({}, msg);
        m.ttl = ttl;
        return m;
    }

    attachSrc(msg, src) {
        const m = Object.assign({}, msg);
        m.src = src;
        return m;
    }
}

module.exports = GSTP;