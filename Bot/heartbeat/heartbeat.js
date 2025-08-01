const config = require("../config.js");
const BOTID = config.mqtt.botId;
const { getDownloadStatus } = require("../torrent/download");
const os = require('os');
const fs = require('fs');
const path = require('path');

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

function getTotalCompletedTorrents() {
   try {
      // Count .torrent files in the torrents directory
      const torrentsDir = config.PATHS?.TORRENTS_DIR || './data/torrents';

      if (!fs.existsSync(torrentsDir)) {
         console.warn(`⚠️ Torrents directory not found: ${torrentsDir}`);
         return 0;
      }

      const files = fs.readdirSync(torrentsDir);
      const torrentFiles = files.filter(file => file.endsWith(config.PATHS?.TORRENT_EXTENSION || '.ghostswarm') && !file.startsWith('.'));

      return torrentFiles.length;
   } catch (err) {
      console.warn(`⚠️ Could not count torrents: ${err.message}`);
      return 0;
   }
}

function getCompletedFiles() {
   try {
      // Count actual files in the uploads/completed directory
      const uploadsDir = config.PATHS?.UPLOADS_DIR || './data/uploads';

      if (!fs.existsSync(uploadsDir)) {
         console.warn(`⚠️ Uploads directory not found: ${uploadsDir}`);
         return 0;
      }

      const files = fs.readdirSync(uploadsDir);
      // Filter out hidden files and directories
      const actualFiles = files.filter(file => {
         const filePath = path.join(uploadsDir, file);
         try {
            return fs.statSync(filePath).isFile() && !file.startsWith('.');
         } catch (err) {
            return false;
         }
      });

      return actualFiles.length;
   } catch (err) {
      console.warn(`⚠️ Could not count completed files: ${err.message}`);
      return 0;
   }
}

function startHeartbeat(mqtt) {
   console.log("💓 Heartbeat started");

   setInterval(() => {
      const hostIP = getHostIP();
      const downloads = getDownloadStatus();
      const totalTorrents = getTotalCompletedTorrents();
      const totalFiles = getCompletedFiles();
      const tags = getTags();

      // Calculate download statistics
      const downloadValues = Object.values(downloads);
      const activeDownloads = downloadValues.filter(d => d.status === 'downloading' || d.status === 'stalled').length;
      const completedDownloads = downloadValues.filter(d => d.status === 'completed').length;

      const status = {
         status: "alive",
         time: Date.now(),
         ip: hostIP,
         downloads: downloads,
         botId: BOTID,
         // Enhanced statistics
         stats: {
            totalTorrents: totalTorrents,
            totalFiles: totalFiles,
            activeDownloads: activeDownloads,
            completedDownloads: completedDownloads,
            uptime: process.uptime()
         },
         // System info
         system: {
            platform: os.platform(),
            arch: os.arch(),
            memory: {
               used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
               total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024)
            }
         },
         metadata: {
            tags: tags || [],
            name: config.metadata?.name || "GhostSwarm Bot",
         }
      };

      console.log(`💓 Heartbeat: IP=${hostIP}, Downloads=${Object.keys(downloads).length}, Torrents=${totalTorrents}, Files=${totalFiles}`);
      mqtt.publish(`${config.mqtt.topicPrefix}/status/${BOTID}`, JSON.stringify(status));
   }, config.heartbeatIntervalMs);
}

function getTags() {
   const tagsFile = config.PATHS?.TAGS_FILE || './data/tags.json';
   if (fs.existsSync(tagsFile)) {
      try {
         const tagsData = fs.readFileSync(tagsFile, 'utf8');
         return JSON.parse(tagsData);
      }
      catch (err) {
         console.warn(`⚠️ Could not read tags file: ${err.message}`);
         return [];
      }
   } else {
      console.warn(`⚠️ Tags file not found: ${tagsFile}`);
      return [];
   }
}


module.exports = { startHeartbeat, getTags };
