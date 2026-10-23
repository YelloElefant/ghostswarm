class STATE {

    constructor(botId) {
        this.botId = botId;

        this.peers = new Map(); // id -> peer info
        this.connections = new Map(); // id -> connection
        this.known = new Map();
        this.queue = [];
        this.pending = new Map(); // msg.id -> {resolve}
        this.seen = new Set(); // msg.id for dedup
        this.peerStatus = new Map(); // peer id -> { status, ts } from the status heartbeat
        this.messages = []; // recent DMs and broadcasts, sent and received
        this.messageSeq = 0;
        this.cpuSample = { usage: process.cpuUsage(), time: Date.now(), percent: 0 };
    } 

    markSeen(id) {
        this.seen.add(id);
    }

    hasSeen(id) {
        return this.seen.has(id);
    }
    
    getAllPeers() {
        return Array.from(this.peers.values());
    }

    getPeer(id) {
        return this.peers.get(id);
    }

    addPeer(id, conn) {
        this.peers.set(id, {
            id,
            conn,
            lastSeen: Date.now(),
            rtt: null
        });
    }

    addPending(id, resolve) {
        this.pending.set(id, { resolve });
    }

    getPending(id) {
        return this.pending.get(id);
    }

    removePending(id) {
        this.pending.delete(id);
    }

    addConnection(id, conn) {
        this.connections.set(id, conn);
        if (this.onConnect) this.onConnect(id, conn);
    }
    
    addKnown(addr) {
        if (!this.known.has(addr)) {
            this.known.set(addr, {
                addr: addr,
                lastSeen: Date.now()
            });
        }
    }

    removeConnection(id) {
        this.connections.delete(id);
        this.peerStatus.delete(id);
    }

    setPeerStatus(id, status) {
        this.peerStatus.set(id, { status, ts: Date.now() });
    }

    // Keeps the last 100 messages; the dashboard polls by sequence number
    addMessage(msg) {
        const entry = Object.assign({ seq: ++this.messageSeq, ts: Date.now() }, msg);
        this.messages.push(entry);
        if (this.messages.length > 100) this.messages.shift();
        return entry;
    }

    getMessagesSince(seq) {
        return this.messages.filter((m) => m.seq > seq);
    }

    getConnection(id) {
        return this.connections.get(id);
    }

    // CPU use since the last sample, as a percent of one core
    cpuPercent() {
        const now = Date.now();
        const elapsed = now - this.cpuSample.time;
        if (elapsed >= 1000) {
            const usage = process.cpuUsage();
            const used = (usage.user - this.cpuSample.usage.user) + (usage.system - this.cpuSample.usage.system);
            this.cpuSample = { usage, time: now, percent: Math.min(100 * used / (elapsed * 1000), 999) };
        }
        return this.cpuSample.percent;
    }

    // Status plus who we are connected to and what torrents we hold; this is what peers receive
    async getFullStatus() {
        const status = this.getStatus();
        status.links = [...this.connections.keys()];
        status.torrents = this.swarm ? await this.swarm.summary() : { total: 0, complete: 0, downloading: 0 };
        return status;
    }

    getStatus() {
        const cpu = process.cpuUsage();
        const mem = process.memoryUsage();
        return {
            cpu: {
                user: cpu.user,
                system: cpu.system,
                percent: this.cpuPercent()
            },
            memory: {
                rss: mem.rss,
                heapTotal: mem.heapTotal,
                heapUsed: mem.heapUsed,
                external: mem.external
            },
            uptime: process.uptime()
        };
    }


}


module.exports = STATE;