const mqtt = require('mqtt');
const Redis = require('ioredis');

const redis = new Redis({
   host: process.env.REDIS_HOST || 'localhost',
   port: process.env.REDIS_PORT || 6379,
});

const mqttClient = mqtt.connect(process.env.MQTT_BROKER_URL || 'mqtt://localhost:1883');

mqttClient.on('connect', () => {
   console.log('✅ MQTT connected');
});

redis.on('connect', () => {
   console.log('✅ Redis connected');
});



setTimeout(() => {
   const topic = 'ghostswarm/bot123/command';
   const message = JSON.stringify({ type: 'echo', message: 'hi from controller' });

   mqttClient.publish(topic, message);
   console.log('📤 Sent:', message);
}, 10000);