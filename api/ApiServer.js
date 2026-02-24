/**
 * ApiServer - Express HTTP API
 * Handles admin operations and status queries
 */
const express = require("express");
const path = require("path");

// Import handlers
const StatusHandler = require("./handlers/statusHandler");
const ConnectHandler = require("./handlers/connectHandler");
const BlastHandler = require("./handlers/blastHandler");
const DmHandler = require("./handlers/dmHandler");
const ChillHandler = require("./handlers/chillHandler");
const DropHandler = require("./handlers/dropHandler");

class ApiServer {
    constructor(config, stateManager, gstp, meshManager, logger) {
        this.config = config;
        this.state = stateManager;
        this.gstp = gstp;
        this.mesh = meshManager;
        this.logger = logger;
        this.app = express();
        
        this.setupMiddleware();
        this.setupRoutes();
    }

    setupMiddleware() {
        this.app.use(express.json());

        // Simple token auth
        this.app.use((req, res, next) => {
            if (!this.config.ADMIN_TOKEN || this.config.ADMIN_TOKEN.length === 0) {
                return next();
            }
            if (req.header("x-admin-token") === this.config.ADMIN_TOKEN) {
                return next();
            }
            res.status(401).json({ error: "unauthorized" });
        });

        // Static files
        this.app.use(express.static(path.join(__dirname, "../public")));
    }

    setupRoutes() {
        // Status
        this.app.get("/api/status", (req, res) => {
            new StatusHandler(this.state, this.gstp).handle(req, res);
        });

        // Connect to peer
        this.app.post("/api/connect", (req, res) => {
            new ConnectHandler(this.config, this.state, this.mesh, this.logger).handle(req, res);
        });

        // Broadcast blast
        this.app.post("/api/blast", (req, res) => {
            new BlastHandler(this.state, this.gstp, this.mesh, this.logger).handle(req, res);
        });

        // Direct message (async)
        this.app.post("/api/dm", async (req, res) => {
            await new DmHandler(this.config, this.state, this.gstp, this.logger).handle(req, res);
        });

        // Flow control
        this.app.post("/api/chill", (req, res) => {
            new ChillHandler(this.state, this.gstp).handle(req, res);
        });

        // Drop connection
        this.app.post("/api/drop", (req, res) => {
            new DropHandler(this.state).handle(req, res);
        });
    }

    listen(port) {
        this.app.listen(port, () => {
            this.logger.log(`Admin HTTP on :${port}`);
        });
    }
}

module.exports = ApiServer;
