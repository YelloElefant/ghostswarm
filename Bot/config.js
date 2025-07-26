const os = require("os");
const fs = require("fs");


let botId;
try {
   botId = fs.readFileSync("/host_hostname", "utf8").trim();
} catch {
   botId = os.hostname(); // fallback
}

module.exports = {
   mqtt: {
      brokerUrl: process.env.MQTT_BROKER_URL,
      botId: botId,
      topicPrefix: "ghostswarm",
      topics: {
         command: `ghostswarm/${botId}/command`, // Topic for bot commands
         status: `ghostswarm/${botId}/status`,   // Topic for bot status updates
         download: `ghostswarm/download/#`,      // Topic for download requests
         torrentHave: `ghostswarm/torrent/have/#`, // Topic for torrent have notifications
         downloadRequest: `ghostswarm/${botId}/download/#` // Topic for specific download requests
      }
   },
   heartbeatIntervalMs: 10000,

   // Added PATHS and DOWNLOAD_CONFIG
   PATHS: {
      HOST_HOSTNAME: "/host_hostname",           // File containing bot hostname
      TORRENTS_DIR: "/data/torrents",             // Directory to store .ghostswarm files
      PIECES_DIR: "/data/pieces",                 // Directory to store downloaded pieces
      UPLOADS_DIR: "/data/uploads",               // Directory for final combined files
      SWARM_DIR: "/data/swarm",                   // Directory for swarm metadata
      TORRENT_EXTENSION: ".ghostswarm"           // Extension for torrent metadata files
   },

   DOWNLOAD_CONFIG: {
      CONTROLLER_IP: "100.76.233.82",           // IP of the controller/seeder
      CONTROLLER_PORT: 5000                     // Port of the controller/seeder
   }
};