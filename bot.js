#!/usr/bin/env node
/**
 * Ghost Swarm - Distributed mesh network
 * Main entry point - thin orchestration layer
 */

const dotenv = require("dotenv");
dotenv.config();

const config = require("./config");
const StateManager = require("./core/StateManager");
const GSTP = require("./utils/GSTP");
const Logger = require("./core/Logger");
const MeshManager = require("./mesh/MeshManager");
const ApiServer = require("./api/ApiServer");

// Initialize
const logger = new Logger(config.BOT_ID);
const gstp = new GSTP(config.BOT_ID, config.TCP_PORT);
const state = new StateManager(config.BOT_ID);

// Setup initial known peers
state.addKnown(config.MY_HOST + ":" + config.TCP_PORT);
for (const hp of config.SEED_PEERS) {
    const parts = hp.split(":");
    if (parts.length === 2) {
        const host = parts[0];
        const port = parseInt(parts[1], 10);
        if (!isNaN(port)) {
            state.addTarget(host, port);
        }
    }
}

// Create mesh and API
const mesh = new MeshManager(config, state, gstp, logger);
const api = new ApiServer(config, state, gstp, mesh, logger);

// Start listeners
mesh.listen(config.TCP_PORT);
api.listen(config.HTTP_PORT);

logger.log(`Ready`);

// Graceful shutdown
process.on("SIGTERM", () => {
    logger.log("SIGTERM - shutting down");
    mesh.stop();
    process.exit(0);
});

process.on("SIGINT", () => {
    logger.log("SIGINT - shutting down");
    mesh.stop();
    process.exit(0);
});