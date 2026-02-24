/**
 * MeshManager - TCP server, peer connections, and mesh topology
 * Manages listening, dialing, heartbeats, peer maintenance
 */
const net = require("net");
const conn = require("./conn");

class MESH {
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
            const connection = new conn(
                socket,
                false,
                null,
                this.state,
                this.gstp,
                this.logger
            );
            connection.send(this.gstp.mkYO());
        });

        this.server.listen(port, () => {
            console.log(`TCP listening on ${this.config.MY_HOST}:${port} (max peers ${this.config.MAX_PEERS})`);
        });

        this.server.on("error", (err) => {
            console.error(`TCP server error: ${err.message}`, err);
        });

        // this.startTimers();
        // seed 
        for (const hp of this.config.SEED_PEERS) {
            try {
                this.peer(hp);
            } catch (e) {
                console.error(`Invalid seed peer ${hp}`);
            }
        }
    }

    peer(addr) {
        const parts = addr.split(":");
        if (parts.length != 2) return null;
        const host = parts[0];
        const port = parseInt(parts[1], 10);
        if (isNaN(port)) throw new Error("Invalid port");

        if (this.state.peers.size >= this.config.MAX_PEERS) return;

        const socket = net.createConnection({
            host: host,
            port: port
        }, () => {
            const connection = new conn(
                socket,
                true,
                addr,
                this.state,
                this.gstp
            );
            connection.send(this.gstp.mkYO());
        });

        socket.on("error", (err) => {
            console.error(`Dial ${addr} failed: ${err.message}`);
        });

    }

    
}

module.exports = MESH;
