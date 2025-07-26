// Bot/download.js
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');

const config = require("../config.js");
const PATHS = config.PATHS;
const DOWNLOAD_CONFIG = config.DOWNLOAD_CONFIG;

let botId;
try {
   botId = fs.readFileSync(PATHS.HOST_HOSTNAME, "utf8").trim();
} catch {
   botId = require("os").hostname(); // fallback
}

let mqtt;

function handleTorrentDownload(infoHash, payload) {
   const torrentPath = path.join(PATHS.TORRENTS_DIR, `${infoHash}${PATHS.TORRENT_EXTENSION}`);
   fs.mkdirSync(path.dirname(torrentPath), { recursive: true });
   fs.writeFileSync(torrentPath, JSON.stringify(payload, null, 2));

   const outDir = path.join(PATHS.PIECES_DIR, infoHash);
   fs.mkdirSync(outDir, { recursive: true });

   console.log(JSON.stringify(payload, null, 2));

   // Track download progress
   const downloadProgress = {
      total: payload.pieces.length,
      completed: 0,
      pieces: new Set()
   };

   // download each piece
   payload.pieces.forEach(piece => {
      const pieceIndex = piece.index;
      const pieceHash = piece.hash;

      requestPiece(DOWNLOAD_CONFIG.CONTROLLER_IP, DOWNLOAD_CONFIG.CONTROLLER_PORT, infoHash, pieceIndex, (err, buffer) => {
         if (err) {
            console.error(`❌ Failed to download piece ${pieceIndex} of ${infoHash}:`, err);
            return;
         }

         const pieceFile = path.join(outDir, `${pieceIndex}.part`);
         fs.writeFileSync(pieceFile, buffer);

         // Verify hash
         const hash = crypto.createHash('sha1').update(buffer).digest('hex');
         if (hash !== pieceHash) {
            console.log(`❌ Hash mismatch for piece ${pieceIndex} of ${infoHash}: expected ${pieceHash}, got ${hash}`);
            return;
         }

         console.log(`✅ Successfully downloaded and verified piece ${pieceIndex} of ${infoHash}`);
         announceHave(infoHash, pieceIndex);

         // Track progress
         downloadProgress.pieces.add(pieceIndex);
         downloadProgress.completed++;

         // Check if all pieces are downloaded
         if (downloadProgress.completed === downloadProgress.total) {
            console.log(`🎉 All pieces downloaded for ${infoHash}, combining...`);
            combineIntorrent(infoHash, payload);
         }
      });
   });
}

function combineIntorrent(infoHash, payload) {
   // Combine pieces into final file
   const piecePath = path.join(PATHS.PIECES_DIR, infoHash);
   const finalFile = path.join(PATHS.UPLOADS_DIR, payload.name);

   fs.mkdirSync(PATHS.UPLOADS_DIR, { recursive: true });

   console.log(`🔄 Starting to combine ${payload.pieces.length} pieces into ${finalFile}`);

   const writeStream = fs.createWriteStream(finalFile);
   let errorOccurred = false;

   writeStream.on('error', err => {
      console.error(`❌ Failed to write final file ${finalFile}:`, err);
      errorOccurred = true;
   });

   writeStream.on('finish', () => {
      if (!errorOccurred) {
         console.log(`📦 Successfully combined pieces into ${finalFile}`);

         // Verify final file size
         const stats = fs.statSync(finalFile);
         console.log(`📊 Final file size: ${stats.size} bytes (expected: ${payload.size} bytes)`);

         if (stats.size === payload.size) {
            console.log(`✅ File size matches expected size!`);
         } else {
            console.warn(`⚠️ File size mismatch! Expected ${payload.size}, got ${stats.size}`);
         }
      }
   });

   // Write pieces in order
   (async () => {
      try {
         let totalWritten = 0;

         for (let i = 0; i < payload.pieces.length; i++) {
            const partPath = path.join(piecePath, `${i}.part`);

            if (!fs.existsSync(partPath)) {
               console.error(`❌ Missing piece ${i}, aborting combine`);
               writeStream.destroy();
               fs.existsSync(finalFile) && fs.unlinkSync(finalFile);
               throw new Error(`Piece ${i} missing`);
            }

            const buffer = fs.readFileSync(partPath);
            writeStream.write(buffer);
            totalWritten += buffer.length;
            console.log(`🧩 Appended piece ${i} (${buffer.length} bytes, total: ${totalWritten})`);
         }

         writeStream.end();
         console.log(`✅ All pieces written, total: ${totalWritten} bytes`);
      } catch (err) {
         console.error(`❌ Failed during combination:`, err.message);
      }
   })();
}

function requestPiece(ip, port, infoHash, pieceIndex, cb) {
   const options = {
      hostname: ip,
      port: port,
      path: `/piece/${infoHash}/${pieceIndex}`,
      method: 'GET'
   };

   const req = http.request(options, res => {
      if (res.statusCode !== 200) return cb(res.statusMessage);

      const data = [];
      res.on('data', chunk => data.push(chunk));
      res.on('end', () => {
         const buffer = Buffer.concat(data);
         cb(null, buffer);
      });
   });

   req.on('error', cb);
   req.end();
}

function announceHave(infoHash, index) {
   const topic = `ghostswarm/torrent/have/${botId}`;
   const msg = { infoHash, pieceIndex: index };
   mqtt.publish(topic, JSON.stringify(msg), { qos: 1 });
   console.log(`📢 HAVE announced: ${infoHash} - piece ${index}`);
}



async function download(torrent, hash, client) {
   const infoHash = hash;

   mqtt = client;
   handleTorrentDownload(infoHash, torrent);
}

module.exports = {
   handleTorrentDownload,
   announceHave,
   download,
   requestPiece
};
