// torrent.js (CommonJS)
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const config = require('../config');

async function registerTorrent(filepath, tags = []) {
   try {
      if (!fs.existsSync(filepath)) {
         throw new Error(`File not found: ${filepath}`);
      }

      const filename = path.basename(filepath);
      const fileStat = fs.statSync(filepath);
      const dataSize = fileStat.size;

      // Choose piece size based on file size
      let pieceLength;
      if (dataSize < 100 * 1024 * 1024) pieceLength = 64 * 1024; // <100MB → 64KB
      else if (dataSize < 1024 * 1024 * 1024) pieceLength = 512 * 1024; // <1GB → 512KB
      else pieceLength = 1024 * 1024; // ≥1GB → 1MB

      const pieces = [];
      let pieceBuffer = Buffer.alloc(0);
      let totalSize = 0;
      let pieceIndex = 0;

      console.log(`📦 Registering ${filename} (${(dataSize / 1024 / 1024).toFixed(2)} MB) with piece size ${pieceLength / 1024} KB...`);

      await new Promise((resolve, reject) => {
         const stream = fs.createReadStream(filepath);

         stream.on('data', chunk => {
            totalSize += chunk.length;
            pieceBuffer = Buffer.concat([pieceBuffer, chunk]);

            while (pieceBuffer.length >= pieceLength) {
               const piece = pieceBuffer.slice(0, pieceLength);
               pieceBuffer = pieceBuffer.slice(pieceLength);

               const hash = crypto.createHash('sha1').update(piece).digest('hex');
               pieces.push({ index: pieceIndex++, hash });
            }
         });

         stream.on('end', () => {
            if (pieceBuffer.length > 0) {
               const hash = crypto.createHash('sha1').update(pieceBuffer).digest('hex');
               pieces.push({ index: pieceIndex++, hash });
            }
            resolve();
         });

         stream.on('error', reject);
      });

      const info = {
         name: filename,
         size: dataSize,
         pieceLength,
         pieces,
         tags, // Add tags to the torrent info
         created: new Date().toISOString(),
      };

      const infoHash = crypto.createHash('sha1').update(JSON.stringify(info)).digest('hex');
      const torrentPath = path.join(config.TORRENTS_DIR, `${infoHash}` + config.TORRENT_EXTENSION);

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

async function updateSwarmMap(redis, infoHash, pieceIndex, botId) {
   const key = `swarm:${infoHash}`;
   const field = pieceIndex.toString();

   let currentList = [];
   const existing = await redis.hget(key, field);
   if (existing) {
      currentList = JSON.parse(existing);
   }

   if (!currentList.includes(botId)) {
      currentList.push(botId);
      await redis.hset(key, field, JSON.stringify(currentList));
      // console.log(`✅ ${botId} now has piece ${pieceIndex}`);
   }
}

module.exports = { registerTorrent, checkForTorrents, updateSwarmMap };

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
