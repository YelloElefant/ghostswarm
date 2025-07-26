const config = require("../config.js");
const BOTID = config.mqtt.botId;




function startHeartbeat(mqtt) {
   console.log("💓 Heartbeat started");
   setInterval(() => {
      const status = {
         status: "alive",
         time: Date.now(),
      };
      mqtt.publish(`${config.mqtt.topicPrefix}/status/${BOTID}`, JSON.stringify(status));
   }, config.heartbeatIntervalMs);
}

module.exports = { startHeartbeat };