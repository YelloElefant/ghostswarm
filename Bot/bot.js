#!/usr/bin/env node
 // Node 16+ (CommonJS/ESM compatible run via `node bot.js`)
//
// ENV EXAMPLES:
//   BOT_ID=a PORT=5001 HTTP_PORT=8081 node bot.js
//   BOT_ID=b PORT=5002 HTTP_PORT=8082 PEERS=127.0.0.1:5001 node bot.js
//
// Features:
// - GSTP vibe types (YO/SUP/UUP/YUP/FRIENDS/BLAST/DM/BET/NOPE/CHILL/OOPS/GTG)
// - Raw TCP mesh (length-prefixed JSON), dedup + ttl, EWMA RTT
// - Admin HTTP: status, add target/dial, BLAST, DM (await ACK), CHILL, drop

const net = require("net");
const crypto = require("crypto");
const express = require("express");

// ---------- Config ----------
function envOr(name, fallback) {
    return (typeof process !== "undefined" &&
            process.env &&
            process.env[name] &&
            process.env[name].length > 0) ?
        process.env[name] :
        fallback;
}

// parse args --port <number tcp> --http <http number>
for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i] === "--port" && i + 1 < process.argv.length) {
        const p = parseInt(process.argv[i + 1], 10);
        if (!isNaN(p)) {
            process.env.PORT = p.toString();
            i++;
        }
    }
    if (process.argv[i] === "--http" && i + 1 < process.argv.length) {
        const p = parseInt(process.argv[i + 1], 10);
        if (!isNaN(p)) {
            process.env.HTTP_PORT = p.toString();
            i++;
        }
    }
}


const BOT_ID = envOr("BOT_ID", "bot_" + crypto.randomBytes(3).toString("hex"));
const TCP_PORT = parseInt(envOr("PORT", "5001"), 10);
const HTTP_PORT = parseInt(envOr("HTTP_PORT", "8080"), 10);
const MAX_PEERS = parseInt(envOr("MAX_PEERS", "4"), 10);
const PEERS_ENV = envOr("PEERS", "");
const SEED = PEERS_ENV ? PEERS_ENV.split(",").filter(Boolean) : [];

const ADMIN_TOKEN = envOr("ADMIN_TOKEN", "");

// ---------- Protocol ----------
const T = {
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

function now() {
    return Date.now();
}

function ewma(prev, x, a) {
    if (typeof a !== "number") a = 0.3;
    if (prev === null || typeof prev === "undefined") return x;
    return a * x + (1 - a) * prev;
}

function myHost() {
    return "127.0.0.1";
} // replace with 100.x for Tailscale in prod

function uid() {
    if (crypto && typeof crypto.randomUUID === "function") {
        return crypto.randomUUID();
    }
    return crypto.randomBytes(16).toString("hex");
}

function enc(obj) {
    const b = Buffer.from(JSON.stringify(obj));
    const h = Buffer.alloc(4);
    h.writeUInt32BE(b.length);
    return Buffer.concat([h, b]);
}

function makeDecoder(onMsg) {
    let buf = Buffer.alloc(0);
    return function(chunk) {
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

// ---------- State ----------
const conns = new Map(); // remoteId -> Conn
const targets = new Map(); // "host:port" -> {host,port,backoff}
const known = new Set(); // endpoints for FRIENDS sampling
const seen = new Set(); // message ids dedup
const peerWin = new Map(); // remoteId -> window (default 64)
const inflight = new Map(); // remoteId -> count
const pending = new Map(); // msg.id -> {resolve}

known.add(myHost() + ":" + TCP_PORT);
for (let i = 0; i < SEED.length; i++) {
    const hp = SEED[i];
    const parts = hp.split(":");
    if (parts.length === 2) {
        const h = parts[0],
            p = parseInt(parts[1], 10);
        if (!isNaN(p)) targets.set(hp, {
            host: h,
            port: p,
            backoff: 500
        });
    }
}

function clampWin(w) {
    const n = parseInt(w, 10);
    if (isNaN(n)) return 64;
    if (n < 1) return 1;
    if (n > 256) return 256;
    return n;
}

function countPeers() {
    return conns.size;
}

function sampleKnown(k) {
    if (typeof k !== "number") k = 16;
    const arr = Array.from(known);
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const tmp = arr[i];
        arr[i] = arr[j];
        arr[j] = tmp;
    }
    return arr.slice(0, k);
}

function addTarget(hp) {
    if (!hp) return;
    if (hp === myHost() + ":" + TCP_PORT) return;
    const parts = hp.split(":");
    if (parts.length !== 2) return;
    const h = parts[0],
        p = parseInt(parts[1], 10);
    if (isNaN(p)) return;
    known.add(hp);
    if (!targets.has(hp)) targets.set(hp, {
        host: h,
        port: p,
        backoff: 500
    });
}

// ---------- Message builders ----------
function mkYO() {
    return {
        v: 1,
        t: T.YO,
        id: uid(),
        rid: null,
        ttl: 8,
        ts: now(),
        src: BOT_ID,
        sig: null,
        body: {
            me: BOT_ID,
            port: TCP_PORT,
            flex: ["pubsub"],
            win: 64
        }
    };
}

function mkSUP(rid) {
    return {
        v: 1,
        t: T.SUP,
        id: uid(),
        rid: rid,
        ttl: 8,
        ts: now(),
        src: BOT_ID,
        sig: null,
        body: {
            ok: true,
            me: BOT_ID,
            win: 64
        }
    };
}

function mkUUP() {
    return {
        v: 1,
        t: T.UUP,
        id: uid(),
        rid: null,
        ttl: 8,
        ts: now(),
        src: BOT_ID,
        sig: null,
        body: {
            t: now()
        }
    };
}

function mkYUP(t) {
    return {
        v: 1,
        t: T.YUP,
        id: uid(),
        rid: null,
        ttl: 8,
        ts: now(),
        src: BOT_ID,
        sig: null,
        body: {
            t: t
        }
    };
}

function mkFRIENDS(l) {
    return {
        v: 1,
        t: T.FRIENDS,
        id: uid(),
        rid: null,
        ttl: 8,
        ts: now(),
        src: BOT_ID,
        sig: null,
        body: {
            list: l
        }
    };
}

function mkBLAST(topic, data) {
    return {
        v: 1,
        t: T.BLAST,
        id: uid(),
        rid: null,
        ttl: 8,
        ts: now(),
        src: BOT_ID,
        sig: null,
        body: {
            topic: topic,
            data: data
        }
    };
}

function mkDM(to, op, data, ttl) {
    return {
        v: 1,
        t: T.DM,
        id: uid(),
        rid: null,
        ttl: (typeof ttl === "number" ? ttl : 8),
        ts: now(),
        src: BOT_ID,
        sig: null,
        body: {
            to: to,
            op: op,
            data: data
        }
    };
}

function mkBET(rid, reason) {
    if (typeof reason !== "string") reason = "";
    return {
        v: 1,
        t: T.BET,
        id: uid(),
        rid: rid,
        ttl: 8,
        ts: now(),
        src: BOT_ID,
        sig: null,
        body: {
            reason: reason
        }
    };
}

function mkNOPE(rid, reason) {
    if (typeof reason !== "string") reason = "";
    return {
        v: 1,
        t: T.NOPE,
        id: uid(),
        rid: rid,
        ttl: 8,
        ts: now(),
        src: BOT_ID,
        sig: null,
        body: {
            reason: reason
        }
    };
}

function mkCHILL(win) {
    return {
        v: 1,
        t: T.CHILL,
        id: uid(),
        rid: null,
        ttl: 8,
        ts: now(),
        src: BOT_ID,
        sig: null,
        body: {
            win: clampWin(win)
        }
    };
}

function mkGTG(why) {
    if (typeof why !== "string") why = "";
    return {
        v: 1,
        t: T.GTG,
        id: uid(),
        rid: null,
        ttl: 8,
        ts: now(),
        src: BOT_ID,
        sig: null,
        body: {
            why: why
        }
    };
}

// ---------- Connection ----------
class Conn {
    constructor(socket, initiatedByMe, addrKey) {
        this.socket = socket;
        this.initiatedByMe = !!initiatedByMe;
        this.remoteAddrKey = addrKey || null; // "host:port"
        this.remoteId = null;
        this.lastSeen = now();
        this.rtt = null;
        this.queue = [];
        this.decoder = makeDecoder(this.onMsg.bind(this));

        socket.on("data", this.decoder);
        socket.on("drain", this.flush.bind(this));
        socket.on("error", function() {});
        socket.on("close", this.onClose.bind(this));
    }
    send(obj) {
        if (!this.socket || this.socket.destroyed) return;
        const ok = this.socket.write(enc(obj));
        if (!ok) this.queue.push(obj);
    }
    flush() {
        if (!this.socket || this.socket.destroyed) return;
        while (this.queue.length > 0) {
            const ok = this.socket.write(enc(this.queue[0]));
            if (!ok) return;
            this.queue.shift();
        }
    }
    close(reason) {
        try {
            this.socket.destroy();
        } catch (e) {}
    }

    onMsg(msg) {
        this.lastSeen = now();
        const body = msg && msg.body ? msg.body : {};
        if (msg && msg.t === T.YO) {
            if (!this.remoteId && typeof body.me === "string") this.remoteId = body.me;

            // single-socket rule
            const existing = this.remoteId && conns.get(this.remoteId);
            if (existing && existing !== this) {
                const keepThis = (BOT_ID < this.remoteId && this.initiatedByMe) ||
                    (BOT_ID > this.remoteId && !this.initiatedByMe);
                if (keepThis) existing.close("dup-replaced");
                else {
                    this.close("dup");
                    return;
                }
            }
            if (this.remoteId) conns.set(this.remoteId, this);
            if (this.remoteId) peerWin.set(this.remoteId, clampWin(body.win || 64));

            this.send(mkSUP(msg.id));
            this.send(mkFRIENDS(sampleKnown(16)));
            return;
        }

        if (msg && msg.t === T.SUP) {
            if (!this.remoteId && typeof body.me === "string") this.remoteId = body.me;
            if (this.remoteId && !conns.get(this.remoteId)) conns.set(this.remoteId, this);
            if (this.remoteId) peerWin.set(this.remoteId, clampWin(body.win || 64));
            return;
        }

        if (msg && msg.t === T.UUP) {
            const t = (typeof body.t === "number") ? body.t : now();
            this.send(mkYUP(t));
            return;
        }

        if (msg && msg.t === T.YUP) {
            const t = (typeof body.t === "number") ? body.t : now();
            this.rtt = ewma(this.rtt, now() - t, 0.3);
            return;
        }

        if (msg && msg.t === T.FRIENDS) {
            const list = body.list && Array.isArray(body.list) ? body.list : [];
            for (let i = 0; i < list.length; i++) {
                const hp = list[i];
                if (hp === myHost() + ":" + TCP_PORT) continue;
                known.add(hp);
                const parts = hp.split(":");
                if (parts.length === 2) {
                    const h = parts[0],
                        p = parseInt(parts[1], 10);
                    if (!isNaN(p) && !targets.has(hp)) targets.set(hp, {
                        host: h,
                        port: p,
                        backoff: 500
                    });
                }
            }
            return;
        }

        if (msg && msg.t === T.BLAST) {
            if (seen.has(msg.id)) return;
            seen.add(msg.id);
            const topic = typeof body.topic === "string" ? body.topic : "chat";
            const data = (typeof body.data !== "undefined") ? body.data : "";
            console.log("[" + BOT_ID + "] BLAST " + msg.src + " → " + topic + ":", data);
            const ttl = (typeof msg.ttl === "number" ? msg.ttl : 1) - 1;
            if (ttl >= 0) forwardGossipExcept(this.remoteId, cloneWithTTL(msg, ttl));
            return;
        }

        if (msg && msg.t === T.DM) {
            const to = body.to;
            const op = body.op;
            const data = body.data;
            if (to === BOT_ID) {
                if (op === "getStatus") {
                    // build status snapshot
                    var peers = [];
                    var entries = Array.from(conns.entries());
                    for (var i = 0; i < entries.length; i++) {
                        var rid = entries[i][0],
                            c2 = entries[i][1];
                        peers.push({
                            id: rid,
                            rtt: (typeof c2.rtt === "number") ? Math.round(c2.rtt) : null,
                            inflight: inflight.get(rid) || 0,
                            win: peerWin.get(rid) || 64,
                            lastSeenAgoMs: now() - c2.lastSeen
                        });
                    }
                    var snap = {
                        bot: BOT_ID,
                        tcp: {
                            host: myHost(),
                            port: TCP_PORT
                        },
                        peers: peers,
                        targets: Array.from(targets.keys()),
                        known: Array.from(known),
                        time: now()
                    };
                    var ack = mkBET(msg.id, "");
                    ack.body.status = snap; // put data in BET body
                    this.send(attachSrc(ack, BOT_ID));
                } else {
                    this.send(attachSrc(mkNOPE(msg.id, "unknown op"), BOT_ID));
                }
                return;
            }
            return;
        }

        if (msg && msg.t === T.BET) {
            const waiter = pending.get(msg.rid);
            if (waiter) {
                waiter.resolve(msg);
                pending.delete(msg.rid);
            }
            if (this.remoteId) {
                const cur = inflight.get(this.remoteId) || 0;
                inflight.set(this.remoteId, Math.max(0, cur - 1));
            }
            return;
        }

        if (msg && msg.t === T.NOPE) {
            const waiter = pending.get(msg.rid);
            if (waiter) {
                waiter.resolve(msg);
                pending.delete(msg.rid);
            }
            if (this.remoteId) {
                const cur = inflight.get(this.remoteId) || 0;
                inflight.set(this.remoteId, Math.max(0, cur - 1));
            }
            return;
        }

        if (msg && msg.t === T.CHILL) {
            if (this.remoteId) {
                const w = (body && typeof body.win !== "undefined") ? body.win : 64;
                peerWin.set(this.remoteId, clampWin(w));
            }
            return;
        }

        if (msg && msg.t === T.OOPS) {
            console.warn("[" + BOT_ID + "] OOPS from " + this.remoteId + ":", body);
            return;
        }

        if (msg && msg.t === T.GTG) {
            this.close("remote-gtg");
            return;
        }
    }

    onClose() {
        const entries = Array.from(conns.entries());
        for (let i = 0; i < entries.length; i++) {
            const rid = entries[i][0];
            const c = entries[i][1];
            if (c === this) conns.delete(rid);
        }
        if (this.initiatedByMe && this.remoteAddrKey) {
            const t = targets.get(this.remoteAddrKey);
            if (t) {
                t.backoff = Math.min((t.backoff || 500) * 1.7, 20000);
                const host = t.host,
                    port = t.port,
                    delay = t.backoff + Math.floor(Math.random() * 500);
                setTimeout(function() {
                    dial(host, port);
                }, delay);
            }
        }
    }
}

function attachSrc(msg, src) {
    const m = Object.assign({}, msg);
    m.src = src;
    return m;
}

function cloneWithTTL(msg, ttl) {
    const m = Object.assign({}, msg);
    m.ttl = ttl;
    return m;
}

// ---------- Mesh plumbing ----------
function dial(host, port) {
    if (countPeers() >= MAX_PEERS) return;
    const key = host + ":" + port;
    const socket = net.createConnection({
        host: host,
        port: port
    }, function() {
        const c = new Conn(socket, true, key);
        c.send(mkYO());
    });
    socket.on("error", function() {});
}

function forwardGossipExcept(exceptRemoteId, msg) {
    const entries = Array.from(conns.entries());
    for (let i = 0; i < entries.length; i++) {
        const rid = entries[i][0];
        const c = entries[i][1];
        if (rid === exceptRemoteId) continue;
        c.send(msg);
    }
}

// Heartbeats
setInterval(function() {
    const it = conns.values();
    for (const c of it) c.send(mkUUP());
}, 5000);

// Maintain peers up to cap
setInterval(function() {
    if (countPeers() >= MAX_PEERS) return;
    const it = targets.values();
    for (const t of it) {
        if (countPeers() >= MAX_PEERS) break;
        const hp = t.host + ":" + t.port;
        if (hp === myHost() + ":" + TCP_PORT) continue;
        dial(t.host, t.port);
    }
}, 1500);

// FRIENDS gossip
setInterval(function() {
    const list = sampleKnown(16);
    const it = conns.values();
    for (const c of it) c.send(mkFRIENDS(list));
}, 8000);

// Seen pruning
setInterval(function() {
    if (seen.size > 50000) seen.clear();
}, 60000);

// TCP server
const tcpServer = net.createServer(function(socket) {
    const c = new Conn(socket, false, null);
    c.send(mkYO());
});
tcpServer.listen(TCP_PORT, function() {
    console.log("[" + BOT_ID + "] TCP listening " + myHost() + ":" + TCP_PORT + " (max peers " + MAX_PEERS + ")");
});

// ---------- Admin HTTP ----------
const app = express();
app.use(express.json());

// Simple auth
app.use(function(req, res, next) {
    if (!ADMIN_TOKEN || ADMIN_TOKEN.length === 0) return next();
    if (req.header("x-admin-token") === ADMIN_TOKEN) return next();
    res.status(401).json({
        error: "unauthorized"
    });
});

// Dashboard (basic)
const path = require("path");
const {
    fileURLToPath
} = require("url");

app.use(express.static(path.join(__dirname, "public")));

// API: status
app.get("/api/status", function(req, res) {
    const peers = [];
    const entries = Array.from(conns.entries());
    for (let i = 0; i < entries.length; i++) {
        const rid = entries[i][0],
            c = entries[i][1];
        peers.push({
            id: rid,
            rtt: (c.rtt === null || typeof c.rtt === "undefined") ? null : Math.round(c.rtt),
            inflight: inflight.get(rid) || 0,
            win: peerWin.get(rid) || 64,
            lastSeenAgoMs: now() - c.lastSeen
        });
    }
    res.json({
        bot: BOT_ID,
        tcp: {
            host: myHost(),
            port: TCP_PORT
        },
        http: {
            port: HTTP_PORT
        },
        maxPeers: MAX_PEERS,
        peers: peers,
        targets: Array.from(targets.keys()),
        known: Array.from(known)
    });
});

// API: connect
app.post("/api/connect", function(req, res) {
    const hp = req.body && req.body.hp ? req.body.hp : "";
    if (!hp) return res.status(400).json({
        error: "hp required (host:port)"
    });
    addTarget(hp);
    const parts = hp.split(":");
    if (parts.length !== 2) return res.status(400).json({
        error: "bad host:port"
    });
    const h = parts[0],
        p = parseInt(parts[1], 10);
    if (isNaN(p)) return res.status(400).json({
        error: "bad port"
    });
    dial(h, p);
    res.json({
        ok: true
    });
});

// API: blast
app.post("/api/blast", function(req, res) {
    const topic = req.body && typeof req.body.topic === "string" ? req.body.topic : "chat";
    const data = req.body && typeof req.body.data !== "undefined" ? req.body.data : "";
    const m = mkBLAST(topic, data);
    seen.add(m.id);
    const it = conns.values();
    for (const c of it) c.send(m);
    res.json({
        ok: true,
        id: m.id
    });
});

// API: dm
app.post("/api/dm", async function(req, res) {
    const to = req.body && req.body.to ? req.body.to : "";
    const op = req.body && req.body.op ? req.body.op : "getStatus";
    const ttl = req.body && typeof req.body.ttl === "number" ? req.body.ttl : 8;
    const timeoutMs = req.body && typeof req.body.timeoutMs === "number" ? req.body.timeoutMs : 3000;
    const data = req.body && req.body.data ? req.body.data : {};

    if (!to) return res.status(400).json({
        error: "to required"
    });

    const m = mkDM(to, op, data, ttl);
    seen.add(m.id);

    const arr = Array.from(conns.entries()).map(function(e) {
        return {
            rid: e[0],
            c: e[1]
        };
    });
    if (arr.length === 0) return res.status(400).json({
        error: "no peers connected"
    });
    arr.sort(function(a, b) {
        const ar = (typeof a.c.rtt === "number") ? a.c.rtt : 1e9;
        const br = (typeof b.c.rtt === "number") ? b.c.rtt : 1e9;
        return ar - br;
    });
    const best = arr[0].c;
    const rid = arr[0].rid;

    const win = peerWin.get(rid) || 64;
    const cur = inflight.get(rid) || 0;
    if (cur >= win) return res.status(429).json({
        error: "peer window full (win=" + win + ")"
    });
    inflight.set(rid, cur + 1);

    const p = new Promise(function(resolve) {
        pending.set(m.id, {
            resolve: resolve
        });
        setTimeout(function() {
            if (pending.has(m.id)) {
                pending.delete(m.id);
                resolve({
                    timeout: true
                });
            }
            const cur2 = inflight.get(rid) || 0;
            inflight.set(rid, Math.max(0, cur2 - 1));
        }, timeoutMs);
    });

    best.send(m);
    const reply = await p;
    res.json({
        ok: true,
        id: m.id,
        reply: reply
    });
});

// API: chill
app.post("/api/chill", function(req, res) {
    const to = req.body && req.body.to ? req.body.to : "";
    const w = req.body && typeof req.body.win !== "undefined" ? req.body.win : 64;
    if (!to || !conns.get(to)) return res.status(400).json({
        error: "unknown peer id"
    });
    conns.get(to).send(mkCHILL(w));
    res.json({
        ok: true,
        to: to,
        win: clampWin(w)
    });
});

// API: drop
app.post("/api/drop", function(req, res) {
    const id = req.body && req.body.id ? req.body.id : "";
    const c = conns.get(id);
    if (!c) return res.status(404).json({
        error: "peer not found"
    });
    c.close("admin-drop");
    res.json({
        ok: true
    });
});

app.listen(HTTP_PORT, function() {
    console.log("[" + BOT_ID + "] Admin HTTP on :" + HTTP_PORT);
});

// on boot pass arguments