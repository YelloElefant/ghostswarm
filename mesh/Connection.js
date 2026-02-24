/**
 * Connection - Handles individual peer connection lifecycle
 * Manages message encoding, decoding, and protocol state for one connection
 */

class Connection {
    constructor(socket, initiatedByMe, remoteAddrKey, stateManager, gstp, logger) {
        this.socket = socket;
        this.initiatedByMe = !!initiatedByMe;
        this.remoteAddrKey = remoteAddrKey || null; // "host:port"
        this.remoteId = null;
        this.state = stateManager;
        this.gstp = gstp;
        this.logger = logger;
        
        this.lastSeen = gstp.now();
        this.rtt = null;
        this.queue = [];
        this.decoder = gstp.makeDecoder(this.onMsg.bind(this));

        // Attach event handlers
        socket.on("data", this.decoder);
        socket.on("drain", () => this.flush());
        socket.on("error", (err) => this.onError(err));
        socket.on("close", () => this.onClose());
    }

    send(obj) {
        if (!this.socket || this.socket.destroyed) return;
        const ok = this.socket.write(this.gstp.enc(obj));
        if (!ok) this.queue.push(obj);
    }

    flush() {
        if (!this.socket || this.socket.destroyed) return;
        while (this.queue.length > 0) {
            const ok = this.socket.write(this.gstp.enc(this.queue[0]));
            if (!ok) return;
            this.queue.shift();
        }
    }

    close(reason = "normal") {
        try {
            this.socket.destroy();
        } catch (e) {
            // Ignore
        }
    }

    onError(err) {
        this.logger.debug(`Connection error: ${err.message}`);
    }

    onMsg(msg) {
        this.lastSeen = this.gstp.now();
        const body = msg && msg.body ? msg.body : {};
        const T = this.gstp.T;
        

        // YO - Initial greeting
        if (msg && msg.t === T.YO) {
            if (!this.remoteId && typeof body.me === "string") {
                this.remoteId = body.me;
            }

            // Single-socket rule: close duplicate connections
            const existing = this.remoteId && this.state.getConnection(this.remoteId);
            if (existing && existing !== this) {
                const keepThis = (this.state.botId < this.remoteId && this.initiatedByMe) ||
                    (this.state.botId > this.remoteId && !this.initiatedByMe);
                if (keepThis) {
                    existing.close("dup-replaced");
                } else {
                    this.close("dup");
                    return;
                }
            }

            if (this.remoteId) {
                this.state.addConnection(this.remoteId, this);
                this.state.setPeerWindow(this.remoteId, body.win || 64);
            }

            this.send(this.gstp.mkSUP(msg.id));
            this.send(this.gstp.mkFRIENDS(this.sampleKnown(16)));
            return;
        }

        // SUP - Ack to YO
        if (msg && msg.t === T.SUP) {
            if (!this.remoteId && typeof body.me === "string") {
                this.remoteId = body.me;
            }
            if (this.remoteId && !this.state.getConnection(this.remoteId)) {
                this.state.addConnection(this.remoteId, this);
            }
            if (this.remoteId) {
                this.state.setPeerWindow(this.remoteId, body.win || 64);
            }
            return;
        }

        // UUP - Heartbeat request
        if (msg && msg.t === T.UUP) {
            const t = (typeof body.t === "number") ? body.t : this.gstp.now();
            this.send(this.gstp.mkYUP(t));
            return;
        }

        // YUP - Heartbeat response
        if (msg && msg.t === T.YUP) {
            const t = (typeof body.t === "number") ? body.t : this.gstp.now();
            this.rtt = this.gstp.ewma(this.rtt, this.gstp.now() - t, 0.3);
            return;
        }

        // FRIENDS - Peer discovery
        if (msg && msg.t === T.FRIENDS) {
            const list = body.list && Array.isArray(body.list) ? body.list : [];
            for (let i = 0; i < list.length; i++) {
                const hp = list[i];
                if (hp === this.state.botId + ":" + this.gstp.tcpPort) continue;
                
                this.state.addKnown(hp);
                
                const parts = hp.split(":");
                if (parts.length === 2) {
                    const h = parts[0];
                    const p = parseInt(parts[1], 10);
                    if (!isNaN(p)) {
                        this.state.addTarget(h, p);
                    }
                }
            }
            return;
        }

        // BLAST - Broadcast
        if (msg && msg.t === T.BLAST) {
            if (this.state.hasSeen(msg.id)) return;
            this.state.markSeen(msg.id);
            
            const topic = typeof body.topic === "string" ? body.topic : "chat";
            const data = (typeof body.data !== "undefined") ? body.data : "";
            this.logger.log(`BLAST ${msg.src} → ${topic}:`, data);
            
            const ttl = (typeof msg.ttl === "number" ? msg.ttl : 1) - 1;
            if (ttl >= 0) {
                this.forwardGossipExcept(this.remoteId, msg, ttl);
            }
            return;
        }

        // DM - Direct message
        if (msg && msg.t === T.DM) {
            const to = body.to;
            const op = body.op;
            const data = body.data;
            console.log(msg);
            
            if (to === this.state.botId) {
                if (op === "getStatus") {
                    const snap = this.state.getStatusSnapshot();
                    const ack = this.gstp.mkBET(msg.id, "");
                    ack.body.status = snap;
                    this.send(this.attachSrc(ack, this.state.botId));
                } else {
                    this.send(this.attachSrc(
                        this.gstp.mkNOPE(msg.id, "unknown op"),
                        this.state.botId
                    ));
                }
                return;
            }

            return;
        }

        // BET - Success response
        if (msg && msg.t === T.BET) {
            console.log(msg);
            
            const waiter = this.state.getPending(msg.rid);
            if (waiter) {
                waiter.resolve(msg);
                this.state.removePending(msg.rid);
            }
            if (this.remoteId) {
                this.state.decrementInflight(this.remoteId, 1);
            }
            return;
        }

        // NOPE - Error response
        if (msg && msg.t === T.NOPE) {
            const waiter = this.state.getPending(msg.rid);
            if (waiter) {
                waiter.resolve(msg);
                this.state.removePending(msg.rid);
            }
            if (this.remoteId) {
                this.state.decrementInflight(this.remoteId, 1);
            }
            return;
        }

        // CHILL - Flow control
        if (msg && msg.t === T.CHILL) {
            if (this.remoteId) {
                const w = (body && typeof body.win !== "undefined") ? body.win : 64;
                this.state.setPeerWindow(this.remoteId, w);
            }
            return;
        }

        // OOPS - Error notification
        if (msg && msg.t === T.OOPS) {
            this.logger.warn(`OOPS from ${this.remoteId}:`, body);
            return;
        }

        // GTG - Goodbye
        if (msg && msg.t === T.GTG) {
            this.close("remote-gtg");
            return;
        }
    }

    onClose() {
        if (this.remoteId) {
            this.state.removeConnection(this.remoteId);
        }

        // Retry connection if we initiated it
        if (this.initiatedByMe && this.remoteAddrKey) {
            const t = this.state.getTarget(this.remoteAddrKey);
            if (t) {
                t.backoff = Math.min((t.backoff || 500) * 1.7, 20000);
                const delay = t.backoff + Math.floor(Math.random() * 500);
                setTimeout(() => {
                    // Retry dial - this will be called by MeshManager
                }, delay);
            }
        }
    }

    // Helper: sample known peers
    sampleKnown(k = 16) {
        const known = this.state.getAllKnown();
        const arr = [...known];
        
        // Fisher-Yates shuffle
        for (let i = arr.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [arr[i], arr[j]] = [arr[j], arr[i]];
        }
        
        return arr.slice(0, k);
    }

    // Helper: clone with TTL
    cloneWithTTL(msg, ttl) {
        const m = Object.assign({}, msg);
        m.ttl = ttl;
        return m;
    }

    // Helper: attach source
    attachSrc(msg, src) {
        const m = Object.assign({}, msg);
        m.src = src;
        return m;
    }

    // Helper: forward to all except one
    forwardGossipExcept(exceptRemoteId, msg, ttl) {
        const entries = this.state.getAllConnections();
        const toSend = this.cloneWithTTL(msg, ttl);
        
        for (const [rid, conn] of entries) {
            if (rid === exceptRemoteId) continue;
            conn.send(toSend);
        }
    }
}

module.exports = Connection;
