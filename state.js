function getStatus() {
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

const state = {
    getStatus,
    peers: new Map(),
    known: new Set(),
    
}


module.exports = state;