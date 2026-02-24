class STATE {

    constructor(botId) {
        this.botId = botId;

        this.peers = new Map(); // id -> peer info
        this.connections = new Map(); // id -> connection
        this.known = new Map();
        this.queue = [];
        this.pending = new Map(); // msg.id -> {resolve}
        this.seen = new Set(); // msg.id for dedup
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
    }

    getConnection(id) {
        return this.connections.get(id);
    }

    getStatus() {
        const cpu = process.cpuUsage();
        const mem = process.memoryUsage();
        return {
            cpu: {
                user: cpu.user,
                system: cpu.system
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