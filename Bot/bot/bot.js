const mqtt = require('mqtt');

const BOT_ID = process.env.BOT_ID || 'bot123';
const MQTT_BROKER = process.env.MQTT_BROKER_URL || 'mqtt://localhost:1883';

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

      // Echo response to status channel
      const statusTopic = `ghostswarm/${BOT_ID}/status`;
      mqttClient.publish(statusTopic, JSON.stringify({
         received: payload,
         status: "ok",
         time: Date.now()
      }));

      console.log(`📤 [${BOT_ID}] responded to status`);
   } catch (err) {
      console.error(`❌ [${BOT_ID}] failed to handle message`, err);
   }
});
