const express = require('express');
const path = require('path');
const bodyParser = require('body-parser');
const Redis = require('ioredis');
const mqtt = require('mqtt');
const http = require('http');
const { Server } = require('ws');
const { exec } = require('child_process');
const fs = require('fs');
const multer = require('multer');

// Configure multer for file uploads
const upload = multer({ dest: '/uploads/temp/' });

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

const swarmMap = new Map(); // Store bot info by ID

// Ensure upload directories exist
fs.mkdirSync('/uploads', { recursive: true });
fs.mkdirSync('/uploads/temp', { recursive: true });



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
   mqttClient.subscribe('ghostswarm/status/+', { qos: 0 }, (err) => {
      if (err) console.error('❌ MQTT status sub failed:', err);
      else console.log('📡 Subscribed to bot status messages');
   });
   mqttClient.subscribe('ghostswarm/+/check/torrents', { qos: 1 }, (err) => {
      if (err) console.error('❌ MQTT download sub failed:', err);
      else console.log('📡 Subscribed to torrent check messages');
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
   } else if (topic.startsWith('ghostswarm/status/')) {
      // Handle general status messages
      const payload = message.toString();
      const data = JSON.parse(payload);
      const botId = topic.split('/')[2];

      // console.log(`📥 Status update from ${botId}`);
      swarmMap.set(botId, {
         status: data.status,
         lastSeen: data.time,
      });

      // save status to Redis
      await redis.set(`status:${botId}`, JSON.stringify({
         status: data.status,
         lastSeen: data.time,
      }));



   } else if (topic.startsWith('ghostswarm/') && topic.endsWith('/check/torrents')) {
      // get all torrents from Redis
      const botId = topic.split('/')[1];
      const torrents = await redis.keys('torrent:*');
      const torrentData = await Promise.all(torrents.map(async (key) => {
         const data = await redis.get(key);
         // return JSON.parse(data);
         // return json which is infohash: data
         const torrentInfo = JSON.parse(data);
         return {
            infoHash: key.split(':')[1], // Extract infoHash from key
            data: torrentInfo
         }
      }
      ));
      console.log(`📥 Torrent check request from ${botId}, found ${torrents.length} torrents`);
      // get infoHash of each torrent
      const torrentInfoHashes = torrentData.map(t => t.infoHash);
      console.log("Sending: ", torrentInfoHashes);

      // Send back torrent data
      const responseTopic = `ghostswarm/${botId}/download`;
      torrentData.forEach(torrent => {
         mqttClient.publish(responseTopic + `/${torrent.infoHash}`, JSON.stringify(torrent.data), { qos: 1 }, (err) => {
            if (err) {
               console.error(`❌ Failed to send torrent data to ${botId}:`, err);
            } else {
               console.log(`📤 Sent torrent data to ${botId}:`, torrent.infoHash);
            }
         });
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

function getBots() {
   return new Promise((resolve) => {
      exec('tailscale status --json', (err, stdout) => {
         if (err) {
            console.error('❌ Tailscale status error:', err);
            return resolve([]);
         }

         try {
            const data = JSON.parse(stdout);
            const peers = data.Peer || {};
            const online = Object.entries(peers)
               .filter(([_, p]) => p.Online)
               .map(([_, p]) => {
                  const botId = p.HostName;
                  const status = swarmMap.get(botId) || { status: 'unknown', lastSeen: Date.now() };

                  return {
                     id: botId,
                     ip: p.TailscaleIPs[0],
                     alive: status.status === "alive",
                     lastSeen: status.lastSeen ? new Date(status.lastSeen).toLocaleString() : 'unknown',
                  };
               });

            resolve(online);
         } catch (e) {
            console.error('❌ Parse error:', e);
            resolve([]);
         }
      });
   });
}

// Get Tailscale clients
app.get('/bots', async (req, res) => {
   const bots = await getBots();
   res.json(bots);
});


app.get('/bot/:botId', async (req, res) => {
   const botId = req.params.botId;

   if (!botId) {
      return res.status(400).json({ error: 'botId is required' });
   }



});

function checkIfDead() {
   const now = Date.now();
   swarmMap.forEach((status, botId) => {
      if (status.lastSeen && now - status.lastSeen > 60000) { // 1 minute timeout
         console.log(`🕒 Bot ${botId} is dead`);
         status.status = 'dead';
         status.lastSeen = now;
         swarmMap.set(botId, status);
         // Also update Redis
         redis.set(`status:${botId}`, JSON.stringify({
            status: 'dead',
            lastSeen: now,
         }));
      }
   });
}

// Heartbeat check every 10 seconds
setInterval(() => {
   checkIfDead();
}, 15500);


app.get('/upload.html', (req, res) => {
   res.sendFile(path.join(__dirname, 'views/upload.html'));
}
);






const { registerTorrent } = require('./torrent'); // Export from previous
app.post('/api/register-torrent', upload.single('torrentFile'), async (req, res) => {
   try {
      const filePath = req.file.path;
      const originalName = req.file.originalname;

      // Move to a proper location
      const destPath = path.join('/uploads', originalName);
      fs.renameSync(filePath, destPath);

      // Register and get hash
      const hash = await registerTorrent(destPath);

      // Load bots (could be from Tailscale or MQTT keep-alives)
      let bots = await getBots();

      // read the torrent file
      const torrentData = JSON.parse(fs.readFileSync("torrents/" + hash + ".json", 'utf8'));


      // Send MQTT task to ghostswarm/download/hash
      const taskTopic = `ghostswarm/download/${hash}`;

      mqttClient.publish(taskTopic, JSON.stringify(torrentData), { qos: 1 }, (err) => {
         if (err) {
            console.error(`❌ Failed to publish task for ${hash}:`, err);
            return res.status(500).json({ error: 'Failed to publish task' });
         }
         console.log(`📤 Published task for ${hash} to ${taskTopic}`)
      }
      );

      // also save to Redis
      await redis.set(`torrent:${hash}`, JSON.stringify(torrentData));

      res.json({ success: true, hash });
   } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to register torrent' });
   }
});

// Start server
server.listen(PORT, () => {
   console.log(`🌐 Controller UI running at http://localhost:${PORT}`);
});


