const express = require('express');
const path = require('path');
const bodyParser = require('body-parser');
const Redis = require('ioredis');
const mqtt = require('mqtt');
const http = require('http');
const { Server } = require('ws');
const { exec } = require('child_process');

const app = express();
const server = http.createServer(app);
const wss = new Server({ server });

const PORT = process.env.WEB_PORT || 3000;
const MQTT_BROKER_URL = process.env.MQTT_BROKER_URL || 'mqtt://localhost:1883';
const REDIS_HOST = process.env.REDIS_HOST || 'localhost';
const REDIS_PORT = process.env.REDIS_PORT || 6379;

// Redis and MQTT setup
const redis = new Redis({ host: REDIS_HOST, port: REDIS_PORT });
const mqttClient = mqtt.connect(MQTT_BROKER_URL);

// Static & view setup
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => {
   res.sendFile(path.join(__dirname, 'views/index.html'));
});

// WebSocket: broadcast status messages
wss.on('connection', (ws) => {
   console.log('🌐 WebSocket client connected');
});

mqttClient.on('connect', () => {
   console.log('✅ Controller connected to MQTT broker');
   mqttClient.subscribe('ghostswarm/+/status', { qos: 0 }, (err) => {
      if (err) console.error('❌ MQTT status sub failed:', err);
      else console.log('📡 Subscribed to bot status messages');
   });
});

mqttClient.on('message', async (topic, message) => {
   if (topic.startsWith('ghostswarm/') && topic.endsWith('/status')) {
      const payload = message.toString();
      const statusMsg = JSON.parse(payload);

      // If response includes requestId, store it
      if (statusMsg.requestId && statusMsg.output !== undefined) {
         const botId = topic.split('/')[1];
         const key = `resp:${botId}:${statusMsg.requestId}`;
         await redis.setex(key, 60, JSON.stringify(statusMsg.output));
      }

      // Also broadcast to frontend
      wss.clients.forEach((client) => {
         if (client.readyState === 1) {
            client.send(JSON.stringify({ topic, payload, timestamp: Date.now() }));
         }
      });
   }
});

// Send command to bot
app.post('/send', async (req, res) => {
   const { topic, command, payload, botId } = req.body;

   if (!botId || !command) {
      return res.status(400).json({ error: 'botId and command required' });
   }

   const msg = { type: command, requestId: `req-${Date.now()}`, ...payload };
   const responseKey = `resp:${botId}:${msg.requestId}`;

   console.log(`📤 Sending command to ${botId}:`, msg);

   mqttClient.publish(topic, JSON.stringify(msg), { qos: 1 }, async (err) => {
      if (err) return res.status(500).json({ error: 'Failed to send command' });

      // Wait for response (poll Redis)
      const maxWaitMs = 5000;
      const start = Date.now();
      let response = null;

      while (!response && Date.now() - start < maxWaitMs) {
         response = await redis.get(responseKey);
         if (!response) await new Promise(r => setTimeout(r, 200));
      }

      if (response) {
         await redis.del(responseKey); // cleanup
         res.json({ botId, command, output: JSON.parse(response) });
      } else {
         res.status(504).json({ error: 'Bot did not respond in time' });
      }
   });
});



// Get Tailscale clients
app.get('/tailscale/clients', (req, res) => {
   exec('tailscale status --json', (err, stdout) => {
      if (err) {
         console.error('❌ Tailscale status error:', err);
         return res.status(500).json({ error: 'Could not get Tailscale status' });
      }

      try {
         const data = JSON.parse(stdout);
         const peers = data.Peer || {};
         const online = Object.entries(peers)
            .filter(([_, p]) => p.Online)
            .map(([_, p]) => ({
               hostname: p.HostName,
               ip: p.TailscaleIPs[0],
               os: p.OS,
            }));

         res.json(online);
      } catch (e) {
         console.error('❌ Parse error:', e);
         res.status(500).json({ error: 'Malformed Tailscale JSON' });
      }
   });
});


app.get('/bot/:botId', async (req, res) => {
   const botId = req.params.botId;

   if (!botId) {
      return res.status(400).json({ error: 'botId is required' });
   }



});



// Start server
server.listen(PORT, () => {
   console.log(`🌐 Controller UI running at http://localhost:${PORT}`);
});
