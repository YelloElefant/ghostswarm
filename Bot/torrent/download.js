const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const os = require('os');

const config = require("../config.js");
const PATHS = config.PATHS;
const DOWNLOAD_CONFIG = config.DOWNLOAD_CONFIG;
const activeDownloads = {};


let botId;
try {
   botId = fs.readFileSync(PATHS.HOST_HOSTNAME, "utf8").trim();
} catch {
   botId = os.hostname();
}

let mqtt;

function handleTorrentDownload(infoHash, payload) {

   const torrentPath = path.join(PATHS.TORRENTS_DIR, `${infoHash}${PATHS.TORRENT_EXTENSION}`);
   const outDir = path.join(PATHS.PIECES_DIR, infoHash);
   fs.mkdirSync(path.dirname(torrentPath), { recursive: true });
   fs.writeFileSync(torrentPath, JSON.stringify(payload, null, 2));
   fs.mkdirSync(outDir, { recursive: true });

   const downloadProgress = {
      total: payload.pieces.length,
      completed: 0,
      pieces: new Set()
   };

   // Resume: scan existing pieces
   payload.pieces.forEach(p => {
      const filePath = path.join(outDir, `${p.index}.part`);
      if (fs.existsSync(filePath)) {
         try {
            const data = fs.readFileSync(filePath);
            const hash = crypto.createHash('sha1').update(data).digest('hex');
            if (hash === p.hash) {
               downloadProgress.pieces.add(p.index);
               downloadProgress.completed++;
            } else {
               console.warn(`❌ Found corrupt piece ${p.index}, will re-download`);
               fs.unlinkSync(filePath); // Remove bad file
            }
         } catch (err) {
            console.warn(`⚠️ Could not check existing piece ${p.index}: ${err.message}`);
         }
      }
   });

   let swarmMap = {};
   for (let i = 0; i < downloadProgress.total; i++) {
      swarmMap[i] = [];
   }

   const swarmUrl = `http://${DOWNLOAD_CONFIG.CONTROLLER_IP}:${DOWNLOAD_CONFIG.TRACKER_PORT}/swarm/${infoHash}`;
   http.get(swarmUrl, res => {
      let peers = getPeers();
      downloadProgress.torrentName = payload.name;
      activeDownloads[infoHash] = downloadProgress;

      if (res.statusCode !== 200) {
         console.error(`❌ Failed to fetch swarm map for ${infoHash}: ${res.statusCode}`);
         return downloadPieces(payload, swarmMap, peers, infoHash, outDir, downloadProgress);
      }

      let data = '';
      const dest = path.join(PATHS.SWARM_DIR, `${infoHash}.json`);
      fs.mkdirSync(PATHS.SWARM_DIR, { recursive: true });

      res.on('data', chunk => data += chunk);
      res.on('end', () => {
         try {
            const json = JSON.parse(data);
            if (removeBotFromSwarmMap(json, botId)) {
               console.log(`🧠 Removed self from swarm map`);
            }
            for (const [p, botList] of Object.entries(json)) {
               swarmMap[p] = botList;
            }
            fs.writeFileSync(dest, JSON.stringify(swarmMap, null, 2));
            console.log(`✅ Swarm map saved to ${dest}`);
         } catch (err) {
            console.error('❌ Failed to parse/save swarm map:', err.message);
         }
         downloadPieces(payload, swarmMap, peers, infoHash, outDir, downloadProgress);
      });
   });
}

function downloadPieces(payload, swarmMap, peers, infoHash, outDir, downloadProgress) {
   const failedPieces = new Set();
   const maxRetries = 3;
   const limit = 10;
   let active = 0;
   let index = 0;

   let lastLogTime = 0;

   function maybeLogProgress() {
      const now = Date.now();
      if (now - lastLogTime > 1000) {
         lastLogTime = now;
         const percent = ((downloadProgress.completed / downloadProgress.total) * 100).toFixed(2);
         console.log(`📦 Download progress: ${downloadProgress.completed}/${downloadProgress.total} pieces (${percent}%)`);
      }
   }

   function next() {
      if (index >= payload.pieces.length) return;
      if (active >= limit) return;

      const piece = payload.pieces[index++];
      const pieceIndex = piece.index;
      const pieceHash = piece.hash;
      const piecePath = path.join(outDir, `${pieceIndex}.part`);

      // ✅ Check if already downloaded and valid
      // console.log(`🔍 Checking piece ${piecePath}...`);
      // console.log(fs.existsSync(piecePath) ? `File exists` : `File does not exist`);


      if (fs.existsSync(piecePath)) {
         try {
            const data = fs.readFileSync(piecePath);
            const hash = crypto.createHash('sha1').update(data).digest('hex');
            if (hash === pieceHash) {
               downloadProgress.pieces.add(pieceIndex);
               downloadProgress.completed++;
               announceHave(infoHash, pieceIndex);

               if (downloadProgress.completed === downloadProgress.total) {
                  const allExist = payload.pieces.every(p =>
                     fs.existsSync(path.join(outDir, `${p.index}.part`))
                  );
                  if (allExist) {
                     console.log(`🎉 All pieces downloaded for ${infoHash}`);
                     combineIntorrent(infoHash, payload);
                  }
               }

               return next(); // 🚀 Go to next piece immediately
            } else {
               console.warn(`❌ Corrupt piece ${pieceIndex}, re - downloading`);
               fs.unlinkSync(piecePath);
            }
         } catch (err) {
            console.warn(`⚠️ Failed to check existing piece ${pieceIndex}: `, err.message);
         }
      }

      // 🧠 Pick a peer for download
      const botsWithPiece = swarmMap[pieceIndex] || [];
      let pickedPeer = { ip: DOWNLOAD_CONFIG.CONTROLLER_IP, port: DOWNLOAD_CONFIG.CONTROLLER_PORT };
      if (botsWithPiece.length > 0) {
         const peerid = botsWithPiece[Math.floor(Math.random() * botsWithPiece.length)];
         const match = peers.find(p => p.id === peerid);
         if (match) pickedPeer = { ip: match.ip, port: 5000 };
      }

      active++;
      requestPiece(pickedPeer.ip, pickedPeer.port, infoHash, pieceIndex, (err, buffer) => {
         active--;

         if (err) {
            const retries = failedPieces.get(pieceIndex) || 0;

            if (retries < maxRetries) {
               console.warn(`🔁 Piece ${pieceIndex} failed (attempt ${retries + 1}/${maxRetries}), will retry`);
               failedPieces.set(pieceIndex, retries + 1);
               setTimeout(() => {
                  index--; // move pointer back to retry this piece
                  next();
               }, 500); // slight delay
            } else {
               console.error(`❌ Piece ${pieceIndex} permanently failed after ${maxRetries} attempts`);
            }

            return next();
         }

         fs.writeFileSync(piecePath, buffer);
         const hash = crypto.createHash('sha1').update(buffer).digest('hex');

         if (hash !== pieceHash) {
            console.warn(`❌ Hash mismatch for piece ${pieceIndex}`);
            fs.unlinkSync(piecePath);
            return next();
         }

         downloadProgress.pieces.add(pieceIndex);
         downloadProgress.completed++;
         announceHave(infoHash, pieceIndex);
         maybeLogProgress();

         const attemptedTotal = downloadProgress.completed + [...failedPieces.values()].filter(r => r >= maxRetries).length;

         if (downloadProgress.completed === downloadProgress.total) {
            const allExist = payload.pieces.every(p =>
               fs.existsSync(path.join(outDir, `${p.index}.part`))
            );
            if (allExist) {
               console.log(`🎉 All pieces downloaded for ${infoHash}`);
               combineIntorrent(infoHash, payload);
            }
         } else if (attemptedTotal === downloadProgress.total) {
            // All attempted, but some still failed
            const unrecoverable = [...failedPieces.entries()].filter(([_, count]) => count >= maxRetries).map(([i]) => i);
            console.error(`🛑 Torrent ${infoHash} failed: unrecoverable pieces: ${unrecoverable.join(', ')}`);
         }

         next();
      });

      // Prefetch more pieces if slots are open
      for (let i = 0; i < limit - active; i++) next();
   }

   next(); // start downloading
}

function removeBotFromSwarmMap(swarmMap, botId) {
   let modified = false;
   for (const [pieceIndex, botList] of Object.entries(swarmMap)) {
      const updatedList = botList.filter(id => id !== botId);
      if (updatedList.length !== botList.length) {
         swarmMap[pieceIndex] = updatedList;
         modified = true;
      }
      if (updatedList.length === 0) {
         delete swarmMap[pieceIndex];
      }
   }
   return modified;
}

function combineIntorrent(infoHash, payload) {
   const piecePath = path.join(PATHS.PIECES_DIR, infoHash);
   const finalFile = path.join(PATHS.UPLOADS_DIR, payload.name);
   fs.mkdirSync(PATHS.UPLOADS_DIR, { recursive: true });

   console.log(`🔄 Combining pieces into ${finalFile} `);
   const writeStream = fs.createWriteStream(finalFile);
   let totalWritten = 0;

   (async () => {
      try {
         for (let i = 0; i < payload.pieces.length; i++) {
            const partPath = path.join(piecePath, `${i}.part`);
            if (!fs.existsSync(partPath)) {
               throw new Error(`❌ Missing piece ${i} `);
            }

            await new Promise((resolve, reject) => {
               const readStream = fs.createReadStream(partPath);
               readStream.on('error', reject);
               readStream.on('end', () => {
                  fs.unlinkSync(partPath); // optional cleanup
                  resolve();
               });
               readStream.pipe(writeStream, { end: false });
            });
         }

         writeStream.end();
         writeStream.on('finish', () => {
            delete activeDownloads[infoHash];
            const stats = fs.statSync(finalFile);
            console.log(`📦 Final size: ${stats.size} bytes`);

            if (stats.size === payload.size) {
               console.log(`✅ File assembled correctly`);
            } else {
               console.warn(`⚠️ File size mismatch! Expected ${payload.size}, got ${stats.size} `);
            }

            if (fs.existsSync(piecePath)) {
               fs.rmSync(piecePath, { recursive: true });
               console.log(`🧹 Cleaned up ${piecePath} `);
            }
         });
      } catch (err) {
         console.error(`❌ Error combining: `, err.message);
         writeStream.destroy();
         fs.existsSync(finalFile) && fs.unlinkSync(finalFile);
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
      if (res.statusCode !== 200) return cb(new Error(res.statusMessage));
      const data = [];
      res.on('data', chunk => data.push(chunk));
      res.on('end', () => cb(null, Buffer.concat(data)));
   });

   req.on('error', cb);
   req.end();
}

function announceHave(infoHash, index) {
   const topic = `ghostswarm/torrent/have/${botId}`;
   const msg = { infoHash, pieceIndex: index };
   mqtt.publish(topic, JSON.stringify(msg), { qos: 1 });
}

function getPeers() {
   try {
      const data = fs.readFileSync(PATHS.PEER_FILE, 'utf8');
      return JSON.parse(data);
   } catch (err) {
      console.error(`❌ Failed to read peers:`, err);
      return [];
   }
}

async function download(torrent, hash, client) {
   mqtt = client;
   handleTorrentDownload(hash, torrent);
}


function getDownloadStatus() {
   const status = {};
   for (const [infoHash, prog] of Object.entries(activeDownloads)) {
      status[infoHash] = {
         name: prog.torrentName,
         completed: prog.completed,
         total: prog.total,
         percent: ((prog.completed / prog.total) * 100).toFixed(1)
      };
   }
   return status;
}

module.exports = {
   handleTorrentDownload,
   announceHave,
   download,
   requestPiece,
   getDownloadStatus,
};
