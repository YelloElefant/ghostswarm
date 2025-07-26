const express = require("express");
const { router: torrentRoutes, initTorrentRoutes } = require("./torrents");
const { router: botRoutes, initBotRoutes } = require("./bots");

const router = express.Router();

// Initialize function to set dependencies for all sub-routers
function initApiRoutes(redisClient, mqttClient) {
   initTorrentRoutes(redisClient, mqttClient);
   initBotRoutes(redisClient, mqttClient);
}

router.use("/torrents", torrentRoutes);
router.use("/bots", botRoutes);

module.exports = { router, initApiRoutes };