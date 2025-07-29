const { exec } = require('child_process');
const crypto = require('crypto');

const MQTT_BROKER = process.env.MQTT_BROKER_URL || 'mqtt://localhost:1883';

const fs = require("fs");
const path = require("path");
const { download } = require("./torrent/download"); // Ensure you have this package installed
const { deleteTorrent } = require("./torrent/delete"); // Ensure you have this package installed
const config = require("./config");
const { startMQTT } = require("./mqtt/client");
const { startHeartbeat } = require("./heartbeat/heartbeat");
const { executeShellCommand } = require("./commands/commands");
const { loadState, clearState } = require('./state/state');


const botId = config.mqtt.botId;

console.log(`🤖 [${botId}] connecting to MQTT broker at ${MQTT_BROKER}`);
const mqttClient = startMQTT();
startHeartbeat(mqttClient);

checkTorrentIntegrity();

setTimeout(() => {
   checkForTorrents();
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
         handleTorrentDownload(infoHash, payload);
      }

      else if (topic.startsWith('ghostswarm/torrent/have/')) {
         const bot = topic.split('/')[3];
         const { infoHash, pieceIndex } = JSON.parse(message.toString());
         if (bot == botId) {
            return;
         }
         updateSwarmMap(infoHash, pieceIndex, bot);
      }

      else if (topic.startsWith(`ghostswarm/${botId}/download/`)) {
         const infoHash = topic.split('/')[3];
         const payload = JSON.parse(message.toString());
         console.log(`📥 [${botId}] need to download torrent ${infoHash}`);
         handleTorrentDownload(infoHash, payload);
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
         fs.writeFileSync(peerFile, JSON.stringify(peers, null, 2));
         // console.log(`📡 [${botId}] saved peers to ${peerFile}`);
      }




   } catch (err) {
      console.error(`❌ [${botId}] failed to handle message`, err);

      // Send error response
      const statusTopic = `ghostswarm/${botId}/status`;
      mqttClient.publish(statusTopic, JSON.stringify({
         status: "error",
         error: err.message,
         time: Date.now()
      }));
   }
});

function updateSwarmMap(infoHash, pieceIndex, who) {
   const swarmFile = config.PATHS.SWARM_DIR + `/${infoHash}.json`;
   fs.mkdirSync(path.dirname(swarmFile), { recursive: true });

   let map = {};
   if (fs.existsSync(swarmFile)) {
      map = JSON.parse(fs.readFileSync(swarmFile));
   }

   const key = pieceIndex.toString();
   if (!map[key]) map[key] = [];
   if (!map[key].includes(who)) map[key].push(who);

   fs.writeFileSync(swarmFile, JSON.stringify(map, null, 2));
   // console.log(`🧠 Swarm updated: piece ${pieceIndex} held by ${who}`);
}

function handleTorrentDownload(infoHash, payload) {
   // save payload to file 
   const torrentPath = config.PATHS.TORRENTS_DIR + `/${infoHash}${config.PATHS.TORRENT_EXTENSION}`;
   const outDir = config.PATHS.PIECES_DIR + `/${infoHash}`;
   const uploadsDir = config.PATHS.UPLOADS_DIR + `/${payload.name}`;
   if (fs.existsSync(outDir)) {
      console.log(`📂 [${botId}] torrent ${infoHash} already exists in ${outDir}`);
      return;
   }
   if (fs.existsSync(torrentPath)) {
      console.log(`📂 [${botId}] torrent ${infoHash} already exists in ${torrentPath}`);
      return;
   }
   if (fs.existsSync(uploadsDir)) {
      console.log(`📂 [${botId}] torrent ${infoHash} already exists in ${uploadsDir}`);
      return;
   }

   fs.mkdirSync(path.dirname(torrentPath), { recursive: true }); // ensure directory exists
   fs.writeFileSync(torrentPath, JSON.stringify(payload, null, 2));
   console.log(`📂 [${botId}] saved torrent to ${torrentPath}`);

   // check if torrent already exists and is downloaded
   // Download the torrent


   download(payload, infoHash, mqttClient)
      .then(() => {
         console.log(`📥 [${botId}] started downloading torrent ${infoHash}`);
      })
      .catch(err => {
         console.error(`❌ [${botId}] failed to download torrent ${infoHash}:`, err);
         // Send error response
         const statusTopic = `ghostswarm/${botId}/status`;
         mqttClient.publish(statusTopic, JSON.stringify({
            status: "error",
            error: err.message,
            time: Date.now()
         }));
      }
      );

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

function checkTorrentIntegrity(botId) {
   const torrentDir = config.PATHS.TORRENTS_DIR;
   const uploadDir = config.PATHS.UPLOADS_DIR;
   const stateDir = config.PATHS.STATE_DIR;

   const torrentFiles = fs.readdirSync(torrentDir)
      .filter(file => file.endsWith(config.PATHS.TORRENT_EXTENSION));

   torrentFiles.forEach(file => {
      const filePath = path.join(torrentDir, file);
      const torrentData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const infoHash = file.replace(config.PATHS.TORRENT_EXTENSION, '');
      const dataFilePath = path.join(uploadDir, torrentData.name);

      // Case 1: If final .mkv file exists, do full streamed hash check
      if (fs.existsSync(dataFilePath)) {
         const pieceLength = torrentData.pieceLength;
         const pieces = torrentData.pieces;
         const corrupted = [];

         let pieceBuffer = Buffer.alloc(0);
         let pieceIndex = 0;

         const stream = fs.createReadStream(dataFilePath, { highWaterMark: pieceLength });

         stream.on('data', chunk => {
            pieceBuffer = Buffer.concat([pieceBuffer, chunk]);

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
               console.log(`✅ [${botId}] All ${pieces.length} pieces OK in ${torrentData.name}`);
               clearState(infoHash);
            }
         });

         stream.on('error', err => {
            console.error(`❌ [${botId}] Error reading file ${torrentData.name}:`, err.message);
            invalidateTorrent(infoHash, torrentData);
         });

      } else {
         // Case 2: Final file missing
         const statePath = path.join(stateDir, `${infoHash}.state.json`);
         const piecePath = path.join(config.PATHS.PIECES_DIR, infoHash);

         if (fs.existsSync(statePath) && fs.existsSync(piecePath)) {
            console.warn(`⚠️ [${botId}] Final file missing but .state.json and pieces exist — will resume ${torrentData.name}`);
            return;
         }

         console.warn(`❌ [${botId}] Missing data file for torrent: ${torrentData.name}`);
         invalidateTorrent(infoHash, torrentData);
      }
   });
}


function invalidateTorrent(infoHash, torrentData) {
   const torrentPath = path.join(config.PATHS.TORRENTS_DIR, `${infoHash}${config.PATHS.TORRENT_EXTENSION}`);
   const outFile = path.join(config.PATHS.UPLOADS_DIR, torrentData.name);
   const piecesDir = path.join(config.PATHS.PIECES_DIR, infoHash);

   // Delete the final output file
   if (fs.existsSync(outFile)) {
      fs.rmSync(outFile, { recursive: true, force: true });
      console.log(`🗑️ [${botId}] Deleted output file ${outFile}`);
   }

   // 🔁 Keep pieces directory (we'll revalidate them), but:
   clearState(infoHash); // remove old piece tracking

   // Re-initiate download — will scan `.part` files and reuse valid ones
   download(torrentData, infoHash, mqttClient)
      .then(() => {
         console.log(`📥 [${botId}] invalidated torrent ${infoHash}, restarting cleanly`);
      })
      .catch(err => {
         console.error(`❌ [${botId}] failed to invalidate torrent ${infoHash}:`, err);
         const statusTopic = `ghostswarm/${botId}/status`;
         mqttClient.publish(statusTopic, JSON.stringify({
            status: "error",
            error: err.message,
            time: Date.now()
         }));
      });
}

