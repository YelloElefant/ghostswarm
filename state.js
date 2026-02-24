class STATE {

    constructor(botId) {
        this.botId = botId;

        this.peers = new Map(); // id -> peer info
        this.known = new Map();
        this.queue = [];
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