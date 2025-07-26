// torrent.js (CommonJS)
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const config = require('../config');

async function registerTorrent(filepath) {
   try {
      if (!fs.existsSync(filepath)) {
         throw new Error(`File not found: ${filepath}`);
      }

      const filename = path.basename(filepath);
      const data = fs.readFileSync(filepath);
      const pieceLength = 16384;

      const pieces = [];
      for (let i = 0; i < data.length; i += pieceLength) {
         const piece = data.slice(i, i + pieceLength);
         const hash = crypto.createHash('sha1').update(piece).digest('hex');
         pieces.push({ index: pieces.length, hash });
      }

      const info = {
         name: filename,
         size: data.length,
         pieceLength,
         pieces,
      };

      const infoHash = crypto.createHash('sha1').update(JSON.stringify(info)).digest('hex');
      const torrentPath = path.join(config.TORRENTS_DIR, `${infoHash}` + config.TORRENT_EXTENSION);

      // Ensure torrents directory exists
      fs.mkdirSync(path.dirname(torrentPath), { recursive: true });
      fs.writeFileSync(torrentPath, JSON.stringify(info, null, 2));

      console.log(`✅ Registered torrent: ${filename}`);
      console.log(`🧩 Pieces: ${pieces.length}`);
      console.log(`🧠 Info hash: ${infoHash}`);

      return infoHash;
   } catch (error) {
      console.error(`❌ Error registering torrent:`, error.message);
      throw error;
   }
}

async function checkForTorrents(mqtt, redis, botId) {
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
      mqtt.publish(responseTopic + `/${torrent.infoHash}`, JSON.stringify(torrent.data), { qos: 1 }, (err) => {
         if (err) {
            console.error(`❌ Failed to send torrent data to ${botId}:`, err);
         } else {
            console.log(`📤 Sent torrent data to ${botId}:`, torrent.infoHash);
         }
      });
   });
}

module.exports = { registerTorrent, checkForTorrents };

// For direct CLI usage (optional)
if (require.main === module) {
   const file = process.argv[2];
   if (!file) {
      console.log('Usage: node torrent.js <file>');
      process.exit(1);
   } else {
      registerTorrent(file)
         .then(hash => {
            console.log(`📋 Torrent hash: ${hash}`);
            process.exit(0);
         })
         .catch(error => {
            console.error('💥 Failed to register torrent:', error.message);
            process.exit(1);
         });
   }
}
