#!/usr/bin/env node
/**
 * Ghost Swarm - Distributed mesh network
 * Main entry point - thin orchestration layer
 */

const dotenv = require("dotenv");
dotenv.config();

const config = require("./config");
const STATE = require("./state");
const GSTP = require("./lib/GSTP");
const MESH = require("./mesh/mesh");
const SERVER = require("./web/server");

// Initialize
const gstp = new GSTP(config.BOT_ID, config.TCP_PORT);
const state = new STATE(config.BOT_ID);
const mesh = new MESH(config, state, gstp);
const server = new SERVER(config.HTTP_PORT, state, gstp);

// Setup initial known peers
state.addKnown(config.MY_HOST + ":" + config.TCP_PORT);

// Start listeners
mesh.listen(config.TCP_PORT);

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("SIGTERM - shutting down");
  process.exit(0);
});

process.on("SIGINT", () => {
  console.log("SIGINT - shutting down");
  process.exit(0);
});

// setInterval(() => {
//   if (state.peers.size > 0) {
//     console.log("peers: ", state.getAllPeers());
//   }
// }, 5000);
