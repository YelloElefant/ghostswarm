const config = require("../config.js");
const BOTID = config.mqtt.botId;
const { getDownloadStatus } = require("../torrent/download");
const os = require('os');

function getTailscaleIP() {
   try {
      const interfaces = os.networkInterfaces();

      // Look for Tailscale interface (100.x.x.x range)
      for (const name of Object.keys(interfaces)) {
         const interfaceList = interfaces[name];
         for (const iface of interfaceList) {
            if (iface.family === 'IPv4' &&
               !iface.internal &&
               iface.address.startsWith('100.')) { // Tailscale uses 100.x.x.x
               console.log(`🔗 Found Tailscale IP via interface ${name}: ${iface.address}`);
               return iface.address;
            }
         }
      }
   } catch (err) {
      console.warn(`⚠️ Could not detect Tailscale interface: ${err.message}`);
   }

   return null;
}

function getHostIP() {
   // Try to get the host IP from environment variable first
   if (process.env.HOST_IP) {
      console.log(`🔗 Using HOST_IP from environment: ${process.env.HOST_IP}`);
      return process.env.HOST_IP;
   }

   // Try to get Tailscale IP first (preferred for ghostswarm)
   const tailscaleIP = getTailscaleIP();
   if (tailscaleIP) {
      return tailscaleIP;
   }

   console.warn('⚠️ Could not find Tailscale IP, falling back to container networking');
   return null;
}

function startHeartbeat(mqtt) {
   console.log("💓 Heartbeat started");

   setInterval(() => {
      const hostIP = getHostIP();

      const status = {
         status: "alive",
         time: Date.now(),
         ip: hostIP,
         downloads: getDownloadStatus(),
         botId: BOTID
      };

      console.log(`💓 Heartbeat: IP=${hostIP}, Downloads=${Object.keys(status.downloads).length}`);
      mqtt.publish(`${config.mqtt.topicPrefix}/status/${BOTID}`, JSON.stringify(status));
   }, config.heartbeatIntervalMs);
}

module.exports = { startHeartbeat };
