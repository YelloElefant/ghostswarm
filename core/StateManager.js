/**
 * StateManager - Single source of truth for all mesh state
 * Manages connections, targets, known peers, messages, etc.
 */
class StateManager {
    constructor(botId) {
        this.botId = botId;
        this.conns = new Map(); // remoteId -> Connection
        this.targets = new Map(); // "host:port" -> {host, port, backoff}
        this.known = new Set(); // endpoints for FRIENDS sampling
        this.seen = new Set(); // message ids for dedup
        this.peerWin = new Map(); // remoteId -> window (peer's receive window)
        this.inflight = new Map(); // remoteId -> count (awaiting responses)
        this.pending = new Map(); // msg.id -> {resolve} (pending DM responses)
    }

    // Connection management
    addConnection(remoteId, conn) {
        if (remoteId) this.conns.set(remoteId, conn);
    }

    getConnection(remoteId) {
        return this.conns.get(remoteId);
    }

    removeConnection(remoteId) {
        if (remoteId) {
            this.conns.delete(remoteId);
            this.peerWin.delete(remoteId);
            this.inflight.delete(remoteId);
        }
    }

    countPeers() {
        return this.conns.size;
    }

    getAllConnections() {
        return Array.from(this.conns.entries());
    }

    // Target management
    addTarget(host, port) {
        const hp = host + ":" + port;
        if (!this.targets.has(hp)) {
            this.targets.set(hp, {
                host: host,
                port: port,
                backoff: 500
            });
        }
    }

    getTarget(hostPort) {
        return this.targets.get(hostPort);
    }

    getAllTargets() {
        return Array.from(this.targets.values());
    }

    // Known peers tracking
    addKnown(hostPort) {
        this.known.add(hostPort);
    }

    getAllKnown() {
        return Array.from(this.known);
    }

    // Dedup tracking
    markSeen(msgId) {
        this.seen.add(msgId);
    }

    hasSeen(msgId) {
        return this.seen.has(msgId);
    }

    pruneSeen(maxSize = 50000) {
        if (this.seen.size > maxSize) {
            this.seen.clear();
        }
    }

    // Peer window management
    setPeerWindow(remoteId, win) {
        if (remoteId) {
            const clamped = Math.max(1, Math.min(256, parseInt(win, 10) || 64));
            this.peerWin.set(remoteId, clamped);
        }
    }

    getPeerWindow(remoteId) {
        return this.peerWin.get(remoteId) || 64;
    }

    // Inflight tracking
    incrementInflight(remoteId, count = 1) {
        const cur = this.inflight.get(remoteId) || 0;
        this.inflight.set(remoteId, cur + count);
    }

    decrementInflight(remoteId, count = 1) {
        const cur = this.inflight.get(remoteId) || 0;
        this.inflight.set(remoteId, Math.max(0, cur - count));
    }

    getInflight(remoteId) {
        return this.inflight.get(remoteId) || 0;
    }

    // Pending DM responses
    addPending(msgId, resolve) {
        this.pending.set(msgId, { resolve });
    }

    getPending(msgId) {
        return this.pending.get(msgId);
    }

    removePending(msgId) {
        this.pending.delete(msgId);
    }

    getStatusSnapshot() {
        const peers = [];
        const now = Date.now();
        
        for (const [rid, conn] of this.conns) {
            peers.push({
                id: rid,
                rtt: conn.rtt ? Math.round(conn.rtt) : null,
                inflight: this.getInflight(rid),
                win: this.getPeerWindow(rid),
                lastSeenAgoMs: now - conn.lastSeen
            });
        }

        return {
            bot: this.botId,
            peerCount: this.conns.size,
            peers,
            targets: this.getAllTargets(),
            known: this.getAllKnown(),
            seenSize: this.seen.size
        };
    }
}

module.exports = StateManager;
