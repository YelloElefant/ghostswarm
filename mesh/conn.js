const tor = require("../tor/tor");
class conn {
    constructor(socket, initiatedByMe, remoteAddrKey, state, gstp) {
        this.socket = socket;
        this.initiatedByMe = !!initiatedByMe;
        this.remoteAddrKey = remoteAddrKey || null; // "host:port"
        this.remoteId = null;
        this.state = state;
        this.gstp = gstp;
        
        this.lastSeen = gstp.now();
        this.rtt = null;
        this.queue = [];

        // Attach event handlers
        socket.on("data", this.makeDecoder(this.onMsg.bind(this)));
        socket.on("drain", () => this.flush());
        socket.on("error", (err) => this.onError(err));
        socket.on("close", () => this.onClose());
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

    enc(obj) {
        const b = Buffer.from(JSON.stringify(obj));
        const h = Buffer.alloc(4);
        h.writeUInt32BE(b.length);
        return Buffer.concat([h, b]);
    }


    send(obj) {
        if (!this.socket || this.socket.destroyed) return;
        const ok = this.socket.write(this.enc(obj));
        if (!ok) this.queue.push(obj);
    }

    flush() {
        if (!this.socket || this.socket.destroyed) return;
        while (this.queue.length > 0) {
            const ok = this.socket.write(this.enc(this.queue[0]));
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
        console.error(`Connection error (${this.remoteId}): ${err.message}`);
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


            this.send(this.gstp.mkOY(msg.id));


            return;
        }

        // OY - Response to YO 
        if (msg && msg.t === T.OY) {
            console.log("Got OY peer conected");
            
            this.state.addPeer(this.remoteId, {
                id: this.remoteId,
                addr: this.remoteAddrKey,
                host: this.remoteAddrKey ? this.remoteAddrKey.split(":")[0] : null,
                port: this.remoteAddrKey ? parseInt(this.remoteAddrKey.split(":")[1], 10) : null,
                lastSeen: this.gstp.now(),
                window: body.win || 64,
                backoff: 0
            });

            this.state.addConnection(this.remoteId, this);

            return;
        }

        // DM - Direct message
        if (msg && msg.t === T.DM) {
            if (msg.src && msg.body?.to === this.state.botId) {
                const data = msg.body.data;
                this.state.addMessage({
                    kind: "dm",
                    from: msg.src,
                    to: this.state.botId,
                    text: data && typeof data === "object" ? String(data.text ?? "") : String(data ?? "")
                });
                this.send(this.gstp.mkMD(msg.id, { text: "Received your DM loud and clear!" }));
            }
            return;
        }

        // BROADCAST - Flooded to everyone once, shown locally
        if (msg && msg.t === T.BROADCAST) {
            if (this.state.hasSeen(msg.id)) return;
            this.state.markSeen(msg.id);
            const data = body.data;
            this.state.addMessage({
                kind: "broadcast",
                from: msg.src,
                to: null,
                topic: body.topic,
                text: data && typeof data === "object" ? String(data.text ?? "") : String(data ?? "")
            });
            if (msg.ttl > 1) {
                const fwd = Object.assign({}, msg, { ttl: msg.ttl - 1 });
                for (const [rid, c] of this.state.connections) {
                    if (rid !== this.remoteId) c.send(fwd);
                }
            }
            return;
        }

        // STATUS - Peer asks for our status (also sent on a timer as a heartbeat)
        if (msg && msg.t === T.STATUS) {
            this.state.getFullStatus()
                .catch(() => this.state.getStatus())
                .then((status) => this.send(this.gstp.mkSUTATS(msg.id, status)));
            return;
        }

        // SUTATS - Status reply, resolves the pending STATUS request
        if (msg && msg.t === T.SUTATS) {
            if (this.remoteId && body.status) this.state.setPeerStatus(this.remoteId, body.status);
            const waiter = this.state.getPending(msg.rid);
            if (waiter) {
                clearTimeout(waiter.timeoutHandle || (waiter.resolve && waiter.resolve.timeoutHandle));
                const resolveFn = typeof waiter.resolve === 'function' ? waiter.resolve : waiter.resolve?.resolve;
                if (resolveFn) resolveFn(msg);
                this.state.removePending(msg.rid);
            }
            return;
        }

        // Torrent sharing packets (TORRENT, SWARM, HAVE, GET, TEG) are handled by the swarm
        if (msg && this.state.swarm && this.state.swarm.handle(msg, this)) return;

        // LIST - Peer asks which torrents we hold
        if (msg && msg.t === T.LIST) {
            tor.listTorrents()
                .then((list) => list.map(({ hash, name, size, chunks, infoHash }) => ({ hash, name, size, chunks, infoHash })))
                .catch(() => [])
                .then((torrents) => this.send(this.gstp.mkTSIL(msg.id, torrents)));
            return;
        }

        // TSIL - Torrent list reply, resolves the pending LIST request
        if (msg && msg.t === T.TSIL) {
            const waiter = this.state.getPending(msg.rid);
            if (waiter) {
                clearTimeout(waiter.timeoutHandle || (waiter.resolve && waiter.resolve.timeoutHandle));
                const resolveFn = typeof waiter.resolve === 'function' ? waiter.resolve : waiter.resolve?.resolve;
                if (resolveFn) resolveFn(msg);
                this.state.removePending(msg.rid);
            }
            return;
        }

        if (msg && msg.t === T.MD) {
            console.log(`[MD] Received response for msg id=${msg.rid}`);
            const waiter = this.state.getPending(msg.rid);
            console.log(`[MD] Waiter lookup result:`, waiter ? "found" : "not found");
            if (waiter) {
                console.log(`[MD] Resolving promise for ${msg.rid}`);
                // The timeout handle might be on waiter.timeoutHandle or waiter.resolve.timeoutHandle depending on state structure
                const timeoutHandle = waiter.timeoutHandle || (waiter.resolve && waiter.resolve.timeoutHandle);
                if (timeoutHandle) {
                    console.log(`[MD] Clearing timeout for ${msg.rid}`);
                    clearTimeout(timeoutHandle);
                } else {
                    console.log(`[MD] WARNING: No timeout handle found`);
                }
                const resolveFn = typeof waiter.resolve === 'function' ? waiter.resolve : waiter.resolve?.resolve;
                if (resolveFn) {
                    resolveFn(msg);
                }
                this.state.removePending(msg.rid);
            } else {
                console.log(`[MD] No waiter found for ${msg.rid}, pending keys:`, Array.from(this.state.pending?.keys?.() || []));
            }
            return;
        }


        
    }

    onClose() {
        if (this.remoteId) {
            this.state.removeConnection(this.remoteId);
        }

        // Retry connection if we initiated it
        if (this.initiatedByMe && this.remoteAddrKey) {
            const peer = this.remoteId && this.state.getPeer(this.remoteId);
            const t = peer && peer.conn;
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

module.exports = conn;
