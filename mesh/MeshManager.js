/**
 * MeshManager - TCP server, peer connections, and mesh topology
 * Manages listening, dialing, heartbeats, peer maintenance
 */
const net = require("net");
const Connection = require("./Connection");

class MeshManager {
    constructor(config, stateManager, gstp, logger) {
        this.config = config;
        this.state = stateManager;
        this.gstp = gstp;
        this.logger = logger;
        this.server = null;
        this.timers = [];
    }

    listen(port) {
        this.server = net.createServer((socket) => {
            const conn = new Connection(
                socket,
                false,
                null,
                this.state,
                this.gstp,
                this.logger
            );
            conn.send(this.gstp.mkYO());
        });

        this.server.listen(port, () => {
            this.logger.log(`TCP listening on ${this.config.MY_HOST}:${port} (max peers ${this.config.MAX_PEERS})`);
        });

        this.server.on("error", (err) => {
            this.logger.error(`TCP server error: ${err.message}`, err);
        });

        this.startTimers();
    }

    dial(host, port) {
        if (this.state.countPeers() >= this.config.MAX_PEERS) return;

        const key = host + ":" + port;
        const socket = net.createConnection({
            host: host,
            port: port
        }, () => {
            const conn = new Connection(
                socket,
                true,
                key,
                this.state,
                this.gstp,
                this.logger
            );
            conn.send(this.gstp.mkYO());
        });

        socket.on("error", (err) => {
            this.logger.debug(`Dial ${key} failed: ${err.message}`);
        });
    }

    startTimers() {
        // Heartbeat every 5s
        const hbTimer = setInterval(() => {
            const entries = this.state.getAllConnections();
            for (const [rid, conn] of entries) {
                conn.send(this.gstp.mkUUP());
            }
        }, 5000);
        this.timers.push(hbTimer);

        // Maintain peers up to cap - every 1.5s
        const maintainTimer = setInterval(() => {
            if (this.state.countPeers() >= this.config.MAX_PEERS) return;
            
            const targets = this.state.getAllTargets();
            for (const t of targets) {
                if (this.state.countPeers() >= this.config.MAX_PEERS) break;
                const hp = t.host + ":" + t.port;
                if (hp === this.config.MY_HOST + ":" + this.config.TCP_PORT) continue;
                
                // Only dial if not already connected
                if (!this.state.getConnection(t.host)) {
                    this.dial(t.host, t.port);
                }
            }
        }, 1500);
        this.timers.push(maintainTimer);

        // FRIENDS gossip - every 8s
        const friendsTimer = setInterval(() => {
            const list = this.sampleKnown(16);
            const entries = this.state.getAllConnections();
            for (const [rid, conn] of entries) {
                conn.send(this.gstp.mkFRIENDS(list));
            }
        }, 8000);
        this.timers.push(friendsTimer);

        // Seen dedup pruning - every 60s
        const pruneTimer = setInterval(() => {
            this.state.pruneSeen(50000);
        }, 60000);
        this.timers.push(pruneTimer);
    }

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

    addTarget(host, port) {
        this.state.addTarget(host, port);
    }

    forwardGossipExcept(exceptRemoteId, msg) {
        const entries = this.state.getAllConnections();
        for (const [rid, conn] of entries) {
            if (rid === exceptRemoteId) continue;
            conn.send(msg);
        }
    }

    stop() {
        // Clear all timers
        for (const timer of this.timers) {
            clearInterval(timer);
        }
        this.timers = [];

        // Close server
        if (this.server) {
            this.server.close();
        }

        // Close all connections
        const entries = this.state.getAllConnections();
        for (const [rid, conn] of entries) {
            conn.close("shutdown");
        }
    }
}

module.exports = MeshManager;
