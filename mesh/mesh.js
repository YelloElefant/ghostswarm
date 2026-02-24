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

    
}

module.exports = MeshManager;
