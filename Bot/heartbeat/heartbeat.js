const config = require("../config.js");
const BOTID = config.mqtt.botId;
const { getDownloadStatus } = require("../torrent/download");
const os = require('os');
const { execSync } = require('child_process');

function getTailscaleIP() {
   try {
      // Try to get Tailscale IP using tailscale CLI
      const result = execSync('tailscale ip --4', {
         encoding: 'utf8',
         timeout: 5000,
         stdio: ['ignore', 'pipe', 'ignore'] // Suppress stderr
      });

      const tailscaleIP = result.trim();
      if (tailscaleIP && tailscaleIP.match(/^\d+\.\d+\.\d+\.\d+$/)) {
         console.log(`🔗 Found Tailscale IP: ${tailscaleIP}`);
         return tailscaleIP;
      }
   } catch (err) {
      console.warn(`⚠️ Could not get Tailscale IP via CLI: ${err.message}`);
   }

   // Fallback: Try to detect Tailscale interface from network interfaces
   try {
      const interfaces = os.networkInterfaces();

      // Look for Tailscale interface
      for (const name of Object.keys(interfaces)) {
         if (name.includes('tailscale') || name.includes('ts') || name.startsWith('utun')) {
            const iface = interfaces[name].find(i =>
               i.family === 'IPv4' &&
               !i.internal &&
               i.address.startsWith('100.') // Tailscale uses 100.x.x.x range
            );
            if (iface) {
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

   // Fallback to regular network interfaces
   const interfaces = os.networkInterfaces();

   // Look for main network interface (avoid Docker internal IPs)
   for (const name of Object.keys(interfaces)) {
      if (name === 'eth0' || name === 'en0' || name === 'wlan0') {
         const iface = interfaces[name].find(i =>
            i.family === 'IPv4' &&
            !i.internal &&
            !i.address.startsWith('172.') && // Skip Docker internal
            !i.address.startsWith('10.') &&  // Skip common internal
            !i.address.startsWith('192.168.') // Skip local LAN (optional)
         );
         if (iface) {
            console.log(`🔗 Using network interface ${name}: ${iface.address}`);
            return iface.address;
         }
      }
   }

   // Last resort - any non-internal interface
   for (const interfaces_array of Object.values(interfaces)) {
      for (const iface of interfaces_array) {
         if (iface.family === 'IPv4' &&
            !iface.internal &&
            !iface.address.startsWith('127.') &&
            !iface.address.startsWith('172.')) {
            console.log(`🔗 Using fallback interface: ${iface.address}`);
            return iface.address;
         }
      }
   }

   console.warn('⚠️ Could not determine host IP');
   return null;
}

function startHeartbeat(mqtt) {
   console.log("💓 Heartbeat started");

   setInterval(() => {
      const hostIP = getHostIP();

      const status = {
         status: "alive",
         time: Date.now(),
         ip: hostIP, // Should be Tailscale IP if available
         downloads: getDownloadStatus(),
         botId: BOTID
      };

      console.log(`💓 Heartbeat: IP=${hostIP}, Downloads=${Object.keys(status.downloads).length}`);
      mqtt.publish(`${config.mqtt.topicPrefix}/status/${BOTID}`, JSON.stringify(status));
   }, config.heartbeatIntervalMs);
}

module.exports = { startHeartbeat };
