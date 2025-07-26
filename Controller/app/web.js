const express = require('express');
const path = require('path');
const bodyParser = require('body-parser');
const http = require('http');
const { Server } = require('ws');
const { exec } = require('child_process');
const fs = require('fs');

const PORT = process.env.WEB_PORT || 3000;


const { redis } = require('./redis/redis'); // Import Redis client
const swarmMap = new Map(); // Store bot info by ID


// MQTT client setup
const { startMQTT } = require('./mqtt/client'); // Import your MQTT client setup
const mqttClient = startMQTT();

const { startDeadCheck } = require('./utils/deadCheck'); // Import WebSocket server setup
startDeadCheck(swarmMap);

// Import API routes
const { router: apiRoutes, initApiRoutes } = require('./api');

// Static & view setup
const app = express();
const server = http.createServer(app);
const wss = new Server({ server });
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// Initialize API routes with dependencies
initApiRoutes(redis, mqttClient);
app.use('/api', apiRoutes);

app.get('/', (req, res) => {
   res.sendFile(path.join(__dirname, 'views/index.html'));
});

app.get('/upload.html', (req, res) => {
   res.sendFile(path.join(__dirname, 'views/upload.html'));
});

app.get('/torrents.html', (req, res) => {
   res.sendFile(path.join(__dirname, 'views/torrents.html'));
});

// WebSocket: broadcast status messages
wss.on('connection', (ws) => {
   console.log('🌐 WebSocket client connected');
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

   else if (topic.startsWith('ghostswarm/status/')) {
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



   }

   else if (topic.startsWith('ghostswarm/') && topic.endsWith('/check/torrents')) {
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

   else if (topic.startsWith('ghostswarm/') && topic.endsWith('/torrent/delete')) {
      const infoHash = topic.split('/')[3];
      console.log(`📥 Received torrent delete request for ${infoHash}`);
      deleteTorrent(infoHash, mqttClient)
         .then(() => {
            console.log(`📂 Deleted torrent ${infoHash}`);
         })
         .catch(err => {
            console.error(`❌ Failed to delete torrent ${infoHash}:`, err);
            // Send error response
            const statusTopic = `ghostswarm/${botId}/status`;
            mqttClient.publish(statusTopic, JSON.stringify({
               status: "error",
               error: err.message,
               time: Date.now()
            }));
         });
   }


});














app.get('/torrents.html', (req, res) => {
   res.sendFile(path.join(__dirname, 'views/torrents.html'));
}
);





// Start server
server.listen(PORT, () => {
   console.log(`🌐 Controller UI running at http://localhost:${PORT}`);
});


