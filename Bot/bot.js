const { exec } = require('child_process');
const crypto = require('crypto');

const MQTT_BROKER = process.env.MQTT_BROKER_URL || 'mqtt://localhost:1883';

const fs = require("fs");
const path = require("path");
const { download, handleTorrentDownload, getDownloadStatus } = require("./torrent/download");
const { deleteTorrent } = require("./torrent/delete");
const config = require("./config");
const { startMQTT } = require("./mqtt/client");
const { startHeartbeat } = require("./heartbeat/heartbeat");
const { executeShellCommand } = require("./commands/commands");
const { loadState, clearState } = require('./state/state');


const botId = config.mqtt.botId;

console.log(`🤖 [${botId}] connecting to MQTT broker at ${MQTT_BROKER}`);
const mqttClient = startMQTT();
startHeartbeat(mqttClient);


setTimeout(() => {
   cleanupCorruptedFiles();
   checkForTorrents();
   checkTorrentIntegrity();
}, 5000); // Wait a bit before checking for torrents

mqttClient.on('message', (topic, message) => {
   // console.log("message received on topic:", topic);

   try {
      if (topic == `ghostswarm/${botId}/command`) {
         const payload = JSON.parse(message.toString());
         console.log(`📥 [${botId}] received:`, payload);
         executeShellCommand(payload, mqttClient);

      }

      else if (topic.startsWith('ghostswarm/download/')) {
         const infoHash = topic.split('/')[2];
         const payload = JSON.parse(message.toString());
         console.log(`📥 [${botId}] received torrent download request for ${infoHash}`, payload);
         handleTorrentDownloadRequest(infoHash, payload);
      }

      else if (topic.startsWith('ghostswarm/torrent/have/')) {
         const bot = topic.split('/')[3];

         // Better message parsing
         let messageData;
         try {
            messageData = JSON.parse(message.toString());
         } catch (parseErr) {
            console.error(`❌ [${botId}] invalid JSON in have message from ${bot}: ${parseErr.message}`);
            return;
         }

         const { infoHash, pieceIndex } = messageData;

         if (bot == botId) {
            return;
         }

         // Validate data before processing
         if (!infoHash || pieceIndex === undefined || pieceIndex === null) {
            console.error(`❌ [${botId}] invalid have message from ${bot}: missing infoHash or pieceIndex`);
            return;
         }

         updateSwarmMap(infoHash, pieceIndex, bot);
      }

      else if (topic.startsWith(`ghostswarm/${botId}/download/`)) {
         const infoHash = topic.split('/')[3];
         const payload = JSON.parse(message.toString());
         console.log(`📥 [${botId}] need to download torrent ${infoHash}`);
         handleTorrentDownloadRequest(infoHash, payload);
      }

      else if (topic.startsWith('ghostswarm/torrent/delete/')) {
         const infoHash = topic.split('/')[3];
         console.log(`📥 [${botId}] received torrent delete request for ${infoHash}`);
         deleteTorrent(infoHash, mqttClient);
      }

      else if (topic.startsWith('ghostswarm/peers')) {
         const peers = JSON.parse(message.toString());
         // save peers to file
         const peerFile = config.PATHS.PEER_FILE;
         fs.mkdirSync(path.dirname(peerFile), { recursive: true });

         // Safe file writing
         try {
            const tempFile = peerFile + '.tmp';
            fs.writeFileSync(tempFile, JSON.stringify(peers, null, 2));
            fs.renameSync(tempFile, peerFile);
            // console.log(`📡 [${botId}] saved peers to ${peerFile}`);
         } catch (err) {
            console.error(`❌ [${botId}] failed to save peers: ${err.message}`);
         }
      }

      else if (topic.startsWith(`ghostswarm/settag/${botId}`)) {
         const payload = JSON.parse(message.toString());
         console.log(`📥 [${botId}] received settag request:`, payload);
         setTags(payload);
      }
   } catch (err) {
      console.error(`❌ [${botId}] failed to handle message on topic ${topic}:`, err.message);
      console.error(`❌ [${botId}] message content:`, message.toString());

      // Send error response
      const statusTopic = `ghostswarm/${botId}/status`;
      mqttClient.publish(statusTopic, JSON.stringify({
         status: "error",
         error: err.message,
         time: Date.now()
      }));
   }
});

// Bot/bot.js - Fix the updateSwarmMap function with better error handling
function updateSwarmMap(infoHash, pieceIndex, who) {
   const swarmFile = config.PATHS.SWARM_DIR + `/${infoHash}.json`;
   fs.mkdirSync(path.dirname(swarmFile), { recursive: true });

   let map = {};

   // Better JSON parsing with error handling
   if (fs.existsSync(swarmFile)) {
      try {
         const fileContent = fs.readFileSync(swarmFile, 'utf8').trim();

         // Check if file is empty or only whitespace
         if (fileContent.length === 0) {
            console.warn(`⚠️ [${botId}] empty swarm file ${swarmFile}, initializing new map`);
            map = {};
         } else {
            map = JSON.parse(fileContent);
         }
      } catch (err) {
         console.error(`❌ [${botId}] corrupted swarm file ${swarmFile}: ${err.message}`);
         console.log(`🔄 [${botId}] initializing new swarm map for ${infoHash}`);

         // Backup corrupted file
         const backupFile = swarmFile + '.corrupted.' + Date.now();
         try {
            fs.renameSync(swarmFile, backupFile);
            console.log(`📁 [${botId}] backed up corrupted file to ${backupFile}`);
         } catch (backupErr) {
            console.warn(`⚠️ [${botId}] could not backup corrupted file: ${backupErr.message}`);
         }

         map = {};
      }
   }

   const key = pieceIndex.toString();
   if (!map[key]) map[key] = [];
   if (!map[key].includes(who)) map[key].push(who);

   // Safe JSON writing with atomic operation
   try {
      const tempFile = swarmFile + '.tmp';
      fs.writeFileSync(tempFile, JSON.stringify(map, null, 2));
      fs.renameSync(tempFile, swarmFile);
      // console.log(`🧠 Swarm updated: piece ${pieceIndex} held by ${who}`);
   } catch (err) {
      console.error(`❌ [${botId}] failed to update swarm map: ${err.message}`);
   }
}

// Also add error handling to announceCompleteTorrent
function announceCompleteTorrent(infoHash, payload) {
   try {
      // Announce that we have all pieces to the swarm
      for (let i = 0; i < payload.pieces.length; i++) {
         updateSwarmMap(infoHash, i, botId);

         // Also announce via MQTT
         const topic = `ghostswarm/torrent/have/${botId}`;
         mqttClient.publish(topic, JSON.stringify({
            infoHash: infoHash,
            pieceIndex: i
         }), { qos: 1 });
      }

      console.log(`📢 [${botId}] announced complete torrent ${infoHash} to swarm`);
   } catch (err) {
      console.error(`❌ [${botId}] failed to announce complete torrent ${infoHash}: ${err.message}`);
   }
}

function handleTorrentDownloadRequest(infoHash, payload) {
   const torrentPath = config.PATHS.TORRENTS_DIR + `/${infoHash}${config.PATHS.TORRENT_EXTENSION}`;
   const uploadsFile = config.PATHS.UPLOADS_DIR + `/${payload.name}`;

   // Check if we already have the complete file
   if (fs.existsSync(uploadsFile)) {
      console.log(`✅ [${botId}] torrent ${infoHash} already downloaded: ${payload.name}`);

      // Announce that we have all pieces
      announceCompleteTorrent(infoHash, payload);
      return;
   }

   // Check if torrent is already being downloaded
   const downloadStatus = getDownloadStatus();
   if (downloadStatus[infoHash]) {
      console.log(`📥 [${botId}] torrent ${infoHash} already downloading (${downloadStatus[infoHash].percent}% complete)`);
      return;
   }

   // Save torrent file if it doesn't exist
   if (!fs.existsSync(torrentPath)) {
      try {
         fs.mkdirSync(path.dirname(torrentPath), { recursive: true });
         fs.writeFileSync(torrentPath, JSON.stringify(payload, null, 2));
         console.log(`📂 [${botId}] saved torrent to ${torrentPath}`);
      } catch (err) {
         console.error(`❌ [${botId}] failed to save torrent ${infoHash}:`, err.message);
         return;
      }
   }

   // Start the download using the new TorrentDownloader class
   console.log(`🚀 [${botId}] starting download for torrent ${infoHash}: ${payload.name}`);

   try {
      handleTorrentDownload(infoHash, payload);

      // Send status update
      const statusTopic = `ghostswarm/${botId}/status`;
      mqttClient.publish(statusTopic, JSON.stringify({
         status: "downloading",
         infoHash: infoHash,
         torrentName: payload.name,
         time: Date.now()
      }));

      console.log(`📥 [${botId}] started downloading torrent ${infoHash}`);

   } catch (err) {
      console.error(`❌ [${botId}] failed to start download for torrent ${infoHash}:`, err.message);

      // Send error response
      const statusTopic = `ghostswarm/${botId}/status`;
      mqttClient.publish(statusTopic, JSON.stringify({
         status: "error",
         error: err.message,
         infoHash: infoHash,
         time: Date.now()
      }));
   }
}

function announceCompleteTorrent(infoHash, payload) {
   // Announce that we have all pieces to the swarm
   for (let i = 0; i < payload.pieces.length; i++) {
      updateSwarmMap(infoHash, i, botId);

      // Also announce via MQTT
      const topic = `ghostswarm/torrent/have/${botId}`;
      mqttClient.publish(topic, JSON.stringify({
         infoHash: infoHash,
         pieceIndex: i
      }), { qos: 1 });
   }

   console.log(`📢 [${botId}] announced complete torrent ${infoHash} to swarm`);
}

function checkForTorrents() {
   mqttClient.publish(`ghostswarm/${botId}/check/torrents`, JSON.stringify({
      requestId: `req-${Date.now()}`,
      type: "checkTorrents"
   }));
   console.log(`📥 [${botId}] sent torrent check request`);
}



function hashBuffer(buf) {
   return crypto.createHash('sha1').update(buf).digest('hex');
}

function checkTorrentIntegrity() {
   const torrentDir = config.PATHS.TORRENTS_DIR;
   const uploadDir = config.PATHS.UPLOADS_DIR;
   const stateDir = config.PATHS.STATE_DIR;

   if (!fs.existsSync(torrentDir)) {
      console.log(`📂 [${botId}] no torrent directory found, skipping integrity check`);
      return;
   }

   const torrentFiles = fs.readdirSync(torrentDir)
      .filter(file => file.endsWith(config.PATHS.TORRENT_EXTENSION));

   if (torrentFiles.length === 0) {
      console.log(`📂 [${botId}] no torrents found for integrity check`);
      return;
   }

   console.log(`🔍 [${botId}] checking integrity of ${torrentFiles.length} torrents`);

   torrentFiles.forEach(file => {
      const filePath = path.join(torrentDir, file);

      try {
         const torrentData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
         const infoHash = file.replace(config.PATHS.TORRENT_EXTENSION, '');
         const dataFilePath = path.join(uploadDir, torrentData.name);

         // Case 1: If final file exists, do integrity check
         if (fs.existsSync(dataFilePath)) {
            console.log(`✅ [${botId}] found complete file: ${torrentData.name}`);
            verifyCompleteFile(infoHash, torrentData, dataFilePath);
         } else {
            // Case 2: Final file missing, check for partial download
            const statePath = path.join(stateDir, `${infoHash}.state.json`);
            const piecePath = path.join(config.PATHS.PIECES_DIR, infoHash);

            if (fs.existsSync(statePath) || fs.existsSync(piecePath)) {
               console.warn(`⚠️ [${botId}] incomplete download found for ${torrentData.name}, resuming...`);
               resumeDownload(infoHash, torrentData);
            } else {
               console.warn(`❌ [${botId}] missing data file for torrent: ${torrentData.name}, restarting download`);
               restartDownload(infoHash, torrentData);
            }
         }
      } catch (err) {
         console.error(`❌ [${botId}] error checking torrent ${file}:`, err.message);
      }
   });
}

function verifyCompleteFile(infoHash, torrentData, dataFilePath) {
   const pieceLength = torrentData.pieceLength;
   const pieces = torrentData.pieces;
   const corrupted = [];

   let pieceBuffer = Buffer.alloc(0);
   let pieceIndex = 0;
   let bytesProcessed = 0;

   const stream = fs.createReadStream(dataFilePath, { highWaterMark: pieceLength });

   stream.on('data', chunk => {
      pieceBuffer = Buffer.concat([pieceBuffer, chunk]);
      bytesProcessed += chunk.length;

      while (pieceBuffer.length >= pieceLength && pieceIndex < pieces.length) {
         const piece = pieceBuffer.slice(0, pieceLength);
         pieceBuffer = pieceBuffer.slice(pieceLength);

         const expected = pieces[pieceIndex].hash;
         const actual = hashBuffer(piece);

         if (expected !== actual) {
            corrupted.push(pieceIndex);
         }

         pieceIndex++;
      }
   });

   stream.on('end', () => {
      // Handle last piece (may be smaller)
      if (pieceBuffer.length > 0 && pieceIndex < pieces.length) {
         const expected = pieces[pieceIndex].hash;
         const actual = hashBuffer(pieceBuffer);
         if (expected !== actual) {
            corrupted.push(pieceIndex);
         }
      }

      if (corrupted.length > 0) {
         console.warn(`🛑 [${botId}] CORRUPTED pieces in ${torrentData.name}: ${corrupted.join(', ')}`);
         invalidateTorrent(infoHash, torrentData);
      } else {
         console.log(`✅ [${botId}] all ${pieces.length} pieces verified in ${torrentData.name}`);
         clearState(infoHash);
         announceCompleteTorrent(infoHash, torrentData);
      }
   });

   stream.on('error', err => {
      console.error(`❌ [${botId}] error reading file ${torrentData.name}:`, err.message);
      invalidateTorrent(infoHash, torrentData);
   });
}

function resumeDownload(infoHash, torrentData) {
   try {
      handleTorrentDownload(infoHash, torrentData);
      console.log(`📥 [${botId}] resumed download for torrent ${infoHash}`);
   } catch (err) {
      console.error(`❌ [${botId}] failed to resume torrent ${infoHash}:`, err.message);
      restartDownload(infoHash, torrentData);
   }
}

function restartDownload(infoHash, torrentData) {
   try {
      // Clear any existing state
      clearState(infoHash);

      // Start fresh download
      handleTorrentDownload(infoHash, torrentData);
      console.log(`📥 [${botId}] restarted download for torrent ${infoHash}`);
   } catch (err) {
      console.error(`❌ [${botId}] failed to restart torrent ${infoHash}:`, err.message);
   }
}

function invalidateTorrent(infoHash, torrentData) {
   const outFile = path.join(config.PATHS.UPLOADS_DIR, torrentData.name);
   const piecesDir = path.join(config.PATHS.PIECES_DIR, infoHash);

   // Delete the corrupted final output file
   if (fs.existsSync(outFile)) {
      try {
         fs.rmSync(outFile, { recursive: true, force: true });
         console.log(`🗑️ [${botId}] deleted corrupted file ${outFile}`);
      } catch (err) {
         console.error(`❌ [${botId}] failed to delete corrupted file:`, err.message);
      }
   }

   // Clear state but keep pieces (they'll be revalidated)
   clearState(infoHash);

   // Restart download
   restartDownload(infoHash, torrentData);
   console.log(`📥 [${botId}] invalidated and restarting torrent ${infoHash}`);
}

// Bot/bot.js - Add cleanup function
function cleanupCorruptedFiles() {
   const swarmDir = config.PATHS.SWARM_DIR;

   if (!fs.existsSync(swarmDir)) {
      return;
   }

   console.log(`🧹 [${botId}] cleaning up corrupted swarm files...`);

   const files = fs.readdirSync(swarmDir);
   let cleaned = 0;

   files.forEach(file => {
      if (file.endsWith('.json')) {
         const filePath = path.join(swarmDir, file);

         try {
            const content = fs.readFileSync(filePath, 'utf8').trim();

            if (content.length === 0) {
               console.log(`🗑️ [${botId}] removing empty swarm file: ${file}`);
               fs.unlinkSync(filePath);
               cleaned++;
            } else {
               // Try to parse JSON
               JSON.parse(content);
            }
         } catch (err) {
            console.log(`🗑️ [${botId}] removing corrupted swarm file: ${file}`);

            // Backup before deleting
            const backupFile = filePath + '.corrupted.' + Date.now();
            try {
               fs.renameSync(filePath, backupFile);
               cleaned++;
            } catch (renameErr) {
               console.warn(`⚠️ [${botId}] could not backup corrupted file ${file}`);
               fs.unlinkSync(filePath);
               cleaned++;
            }
         }
      }
   });

   if (cleaned > 0) {
      console.log(`🧹 [${botId}] cleaned up ${cleaned} corrupted swarm files`);
   }
}

function setTags(payload) {
   const tagsFile = config.PATHS.TAGS_FILE;
   fs.mkdirSync(path.dirname(tagsFile), { recursive: true });
   try {
      // Read existing tags
      let existingTags = {};
      if (fs.existsSync(tagsFile)) {
         const data = fs.readFileSync(tagsFile, 'utf8');
         existingTags = JSON.parse(data);
      }
      // Update tags
      existingTags[payload.infoHash] = payload.tags;
      // Write
      fs.writeFileSync(tagsFile, JSON.stringify(existingTags, null, 2));
      console.log(`📂 [${botId}] updated tags for ${payload.infoHash}`);
   } catch (err) {
      console.error(`❌ [${botId}] failed to set tags for ${payload.infoHash}:`, err.message);
   }
}

// Add periodic status reporting
setInterval(() => {
   const downloadStatus = getDownloadStatus();
   const activeDownloads = Object.keys(downloadStatus).length;

   if (activeDownloads > 0) {
      console.log(`📊 [${botId}] active downloads: ${activeDownloads}`);

      for (const [infoHash, status] of Object.entries(downloadStatus)) {
         console.log(`  📦 ${status.name}: ${status.percent}% (${status.completed}/${status.total}) | Peers: ${status.peers} | Queue: ${status.queue}`);
      }
   }
}, 30000); // Log status every 30 seconds


