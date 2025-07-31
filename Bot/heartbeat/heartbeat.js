const config = require("../config.js");
const BOTID = config.mqtt.botId;
const { getDownloadStatus } = require("../torrent/download");
const os = require('os');

function getHostIP() {
   // Try to get the host IP from environment variable first
   if (process.env.HOST_IP) {
      return process.env.HOST_IP;
   }

   // Try to get external IP from network interfaces
   const interfaces = os.networkInterfaces();

   // Look for Tailscale interface first (if using Tailscale)
   for (const name of Object.keys(interfaces)) {
      if (name.includes('tailscale') || name.includes('ts')) {
         const iface = interfaces[name].find(i => i.family === 'IPv4' && !i.internal);
         if (iface) return iface.address;
      }
   }

   // Look for main network interface
   for (const name of Object.keys(interfaces)) {
      if (name === 'eth0' || name === 'en0' || name === 'wlan0') {
         const iface = interfaces[name].find(i => i.family === 'IPv4' && !i.internal);
         if (iface) return iface.address;
      }
   }

   // Fallback to first non-internal interface
   for (const interfaces_array of Object.values(interfaces)) {
      for (const iface of interfaces_array) {
         if (iface.family === 'IPv4' && !iface.internal && !iface.address.startsWith('172.')) {
            return iface.address;
         }
      }
   }

   // Last resort - try to get from hostname resolution
   try {
      const hostname = os.hostname();
      return require('dns').lookup(hostname, (err, address) => {
         if (!err) return address;
      });
   } catch (err) {
      console.warn('⚠️ Could not resolve hostname');
   }

   return null;
}

function startHeartbeat(mqtt) {
   console.log("💓 Heartbeat started");

   setInterval(() => {
      const hostIP = getHostIP();

      const status = {
         status: "alive",
         time: Date.now(),
         ip: hostIP, // Report host IP instead of container IP
         downloads: getDownloadStatus()
      };

      console.log(`💓 Heartbeat: IP=${hostIP}, Downloads=${Object.keys(status.downloads).length}`);
      mqtt.publish(`${config.mqtt.topicPrefix}/status/${BOTID}`, JSON.stringify(status));
   }, config.heartbeatIntervalMs);
}

module.exports = { startHeartbeat };
