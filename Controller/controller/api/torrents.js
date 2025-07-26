const express = require("express");
const { registerTorrent } = require('../../app/torrent/torrent'); // Fixed path
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const router = express.Router();
const config = require('../../config'); // Import configuration if needed

// Configure multer for file uploads
const upload = multer({ dest: config.UPLOADS_DIR + '/temp/' });

// Get dependencies from parent context
let redis, mqttClient;

// Initialize function to set dependencies
function initTorrentRoutes(redisClient, mqttClientInstance) {
   redis = redisClient;
   mqttClient = mqttClientInstance;
}

const TORRENT_DIR = config.TORRENTS_DIR; // where the torrent metadata files are stored


router.post('/register', upload.single('torrentFile'), async (req, res) => {
   try {
      if (!redis || !mqttClient) {
         return res.status(500).json({ error: 'Server not properly initialized' });
      }

      const filePath = req.file.path;
      const originalName = req.file.originalname;

      // Move to a proper location
      const destPath = path.join(config.UPLOADS_DIR, originalName);

      // Ensure uploads directory exists
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.renameSync(filePath, destPath);

      // Register and get hash
      const hash = await registerTorrent(destPath);

      // Read the torrent file
      const torrentFilePath = path.join(TORRENT_DIR, `${hash}` + config.TORRENT_EXTENSION);
      const torrentData = JSON.parse(fs.readFileSync(torrentFilePath, 'utf8'));

      // Send MQTT task to all bots
      const taskTopic = `ghostswarm/download/${hash}`;
      mqttClient.publish(taskTopic, JSON.stringify(torrentData), { qos: 1 }, (err) => {
         if (err) {
            console.error(`❌ Failed to publish task for ${hash}:`, err);
         } else {
            console.log(`📤 Published task for ${hash} to ${taskTopic}`);
         }
      });

      // Save to Redis
      await redis.set(`torrent:${hash}`, JSON.stringify(torrentData));

      res.json({
         success: true,
         hash,
         name: torrentData.name,
         size: torrentData.size,
         pieces: torrentData.pieces.length
      });
   } catch (err) {
      console.error('❌ Error registering torrent:', err);
      res.status(500).json({ error: 'Failed to register torrent' });
   }
});

router.get('/', async (req, res) => {
   try {
      if (!redis) {
         return res.status(500).json({ error: 'Server not properly initialized' });
      }

      // Get torrents from Redis instead of file system
      const torrentKeys = await redis.keys('torrent:*');
      const torrents = await Promise.all(torrentKeys.map(async (key) => {
         const data = await redis.get(key);
         const infoHash = key.split(':')[1];
         const torrentInfo = JSON.parse(data);
         return {
            hash: infoHash,
            name: torrentInfo.name,
            size: torrentInfo.size,
            pieces: torrentInfo.pieces.length
         };
      }));

      res.json(torrents);
   } catch (err) {
      console.error('❌ Error fetching torrents:', err);
      res.status(500).json({ error: 'Failed to fetch torrents' });
   }
});

router.delete('/:infoHash', async (req, res) => {
   try {
      if (!redis) {
         return res.status(500).json({ error: 'Server not properly initialized' });
      }

      const infoHash = req.params.infoHash;
      const torrentFile = path.join(TORRENT_DIR, `${infoHash}` + config.TORRENT_EXTENSION);
      const uploadsDir = path.join(config.UPLOADS_DIR);

      // Get torrent data from Redis first
      const torrentData = await redis.get(`torrent:${infoHash}`);
      if (!torrentData) {
         return res.status(404).json({ error: 'Torrent not found' });
      }

      const metadata = JSON.parse(torrentData);

      // Delete the torrent file if it exists
      if (fs.existsSync(torrentFile)) {
         fs.unlinkSync(torrentFile);
         console.log(`🗑️ Deleted torrent: ${torrentFile}`);
      }

      // Try to delete the original uploaded file too
      const uploadedPath = path.join(uploadsDir, metadata.name);
      if (fs.existsSync(uploadedPath)) {
         fs.unlinkSync(uploadedPath);
         console.log(`🗑️ Deleted uploaded file: ${uploadedPath}`);
      }

      // Delete from Redis
      await redis.del(`torrent:${infoHash}`);
      console.log(`🗑️ Deleted torrent from Redis: ${infoHash}`);

      res.json({ success: true, message: 'Torrent deleted successfully' });
   } catch (err) {
      console.error('❌ Error deleting torrent:', err);
      res.status(500).json({ error: 'Failed to delete torrent' });
   }
});

module.exports = { router, initTorrentRoutes };
