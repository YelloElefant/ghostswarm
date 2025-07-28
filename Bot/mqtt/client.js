const mqtt = require("mqtt");
const config = require("../config.js");
const botId = config.mqtt.botId;

let client;

function startMQTT() {
   client = mqtt.connect(config.mqtt.brokerUrl);

   client.on('connect', () => {
      console.log(`🤖 [${botId}] connected to MQTT`);
      const topic = `ghostswarm/${botId}/command`;
      client.subscribe(topic, { qos: 1 }, (err) => {
         if (err) {
            console.error(`❌ [${botId}] failed to subscribe:`, err);
         } else {
            console.log(`📡 [${botId}] subscribed to ${topic}`);
         }
      });
      client.subscribe(`ghostswarm/download/#`);
      client.subscribe(`ghostswarm/torrent/have/#`);
      client.subscribe(`ghostswarm/${botId}/download/#`);
      client.subscribe(`ghostswarm/torrent/delete/#`);
      client.subscribe(`ghostswarm/peers`);


   });

   return client;
}

module.exports = { startMQTT };