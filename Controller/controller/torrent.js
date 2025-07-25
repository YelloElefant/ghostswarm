// torrent.js (CommonJS)
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

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
      const torrentPath = path.join(__dirname, 'torrents', `${infoHash}.json`);

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

module.exports = { registerTorrent };

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
