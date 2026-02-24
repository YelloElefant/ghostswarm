class STATE {

    constructor(botId) {
        this.botId = botId;

        this.peers = new Map(); // id -> peer info
        this.known = new Map();
        this.queue = [];
        this.pending = new Map(); // msg.id -> {resolve}
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
        this.peers.set(id, {
            id,
            conn,
            lastSeen: Date.now(),
            rtt: null
        });
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
        this.peers.delete(id);
    }

    getConnection(id) {
        return this.peers.get(id);
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