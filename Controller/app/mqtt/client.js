const mqtt = require("mqtt");
const config = require("../config");

let client;

function startMQTT() {
   client = mqtt.connect(config.mqtt.brokerUrl);

   client.on('connect', () => {
      console.log('✅ Controller connected to MQTT broker');
      client.subscribe('ghostswarm/+/status', { qos: 0 }, (err) => {
         if (err) console.error('❌ MQTT status sub failed:', err);
         else console.log('📡 Subscribed to bot status messages');
      });
      client.subscribe('ghostswarm/status/+', { qos: 0 }, (err) => {
         if (err) console.error('❌ MQTT status sub failed:', err);
         else console.log('📡 Subscribed to bot status messages');
      });
      client.subscribe('ghostswarm/+/check/torrents', { qos: 1 }, (err) => {
         if (err) console.error('❌ MQTT download sub failed:', err);
         else console.log('📡 Subscribed to torrent check messages');
      });
      client.subscribe('ghostswarm/+/torrent/delete/#', { qos: 1 }, (err) => {
         if (err) console.error('❌ MQTT download sub failed:', err);
         else console.log('📡 Subscribed to download requests');
      });
      client.subscribe(`ghostswarm/torrent/have/+`);
   });

   return client;
}

module.exports = { startMQTT };
