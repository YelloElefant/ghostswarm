const config = require("../config.js");
const BOTID = config.mqtt.botId;
const { getDownloadStatus } = require("../torrent/download"); // ✅ Import the helper

function startHeartbeat(mqtt) {
   console.log("💓 Heartbeat started");

   setInterval(() => {
      const status = {
         status: "alive",
         time: Date.now(),
         downloads: getDownloadStatus() // ✅ Add current torrent progress
      };
      mqtt.publish(`${config.mqtt.topicPrefix}/status/${BOTID}`, JSON.stringify(status));
   }, config.heartbeatIntervalMs);
}

module.exports = { startHeartbeat };
