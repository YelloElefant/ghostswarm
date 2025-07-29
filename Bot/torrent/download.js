const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const os = require('os');
const state = require("../state/state");

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
   if (activeDownloads[infoHash]) {
      console.warn(`⚠️ Torrent ${infoHash} already downloading, skipping...`);
      return;
   }

   console.log(`🚀 Starting torrent download: ${payload.name} (${payload.pieces.length} pieces)`);

   const torrentPath = path.join(PATHS.TORRENTS_DIR, `${infoHash}${PATHS.TORRENT_EXTENSION}`);
   const outDir = path.join(PATHS.PIECES_DIR, infoHash);

   // Create directories
   try {
      fs.mkdirSync(path.dirname(torrentPath), { recursive: true });
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(torrentPath, JSON.stringify(payload, null, 2));
   } catch (err) {
      console.error(`❌ Failed to setup directories for ${infoHash}:`, err.message);
      return;
   }

   const downloadProgress = {
      total: payload.pieces.length,
      completed: 0,
      pieces: new Set(),
      torrentName: payload.name,
      pendingPieces: new Set(), // Track pieces currently being downloaded
      failedPieces: new Set()   // Track pieces that failed too many times
   };

   // Validate existing pieces and load state
   validateExistingPieces(infoHash, payload, outDir, downloadProgress);

   activeDownloads[infoHash] = downloadProgress;

   console.log(`📦 Download status: ${downloadProgress.completed}/${downloadProgress.total} pieces already available`);

   // Check if already complete
   if (downloadProgress.completed >= downloadProgress.total) {
      console.log(`🎉 All pieces already downloaded for ${infoHash}, combining...`);
      return combineIntorrent(infoHash, payload);
   }

   // Start download process
   startDownloadProcess(infoHash, payload, outDir, downloadProgress);
}

function validateExistingPieces(infoHash, payload, outDir, downloadProgress) {
   // Try to load saved state first
   const saved = state.loadState(infoHash);
   if (saved && saved.pieces) {
      console.log(`🔁 Found saved state with ${saved.pieces.length} pieces`);
   }

   let validPieces = 0;
   const pieceMap = new Map();

   // Create piece lookup map
   payload.pieces.forEach(p => pieceMap.set(p.index, p.hash));

   // Validate each piece file
   for (let i = 0; i < payload.pieces.length; i++) {
      const filePath = path.join(outDir, `${i}.part`);
      const expectedHash = pieceMap.get(i);

      if (fs.existsSync(filePath)) {
         try {
            const data = fs.readFileSync(filePath);
            const actualHash = crypto.createHash('sha1').update(data).digest('hex');

            if (actualHash === expectedHash) {
               downloadProgress.pieces.add(i);
               validPieces++;
            } else {
               console.warn(`❌ Corrupt piece ${i}, removing...`);
               fs.unlinkSync(filePath);
            }
         } catch (err) {
            console.warn(`⚠️ Could not validate piece ${i}: ${err.message}`);
            try {
               fs.unlinkSync(filePath);
            } catch { }
         }
      }
   }

   downloadProgress.completed = validPieces;

   // Save updated state
   state.saveState(infoHash, {
      completed: downloadProgress.completed,
      pieces: [...downloadProgress.pieces]
   });
}

function startDownloadProcess(infoHash, payload, outDir, downloadProgress) {
   let swarmMap = {};

   // Initialize empty swarm map
   for (let i = 0; i < payload.pieces.length; i++) {
      swarmMap[i] = [];
   }

   // Try to fetch swarm map
   const trackerPort = DOWNLOAD_CONFIG.TRACKER_PORT || DOWNLOAD_CONFIG.CONTROLLER_PORT;
   const swarmUrl = `http://${DOWNLOAD_CONFIG.CONTROLLER_IP}:${trackerPort}/swarm/${infoHash}`;

   console.log(`🔍 Fetching swarm map from ${swarmUrl}`);

   const req = http.get(swarmUrl, res => {
      if (res.statusCode !== 200) {
         console.warn(`⚠️ Failed to fetch swarm map (${res.statusCode}), using controller only`);
         return startPieceDownloads(infoHash, payload, outDir, downloadProgress, swarmMap);
      }

      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
         try {
            const json = JSON.parse(data);

            // Remove self from swarm map
            for (const [pieceIndex, botList] of Object.entries(json)) {
               const filteredBots = botList.filter(id => id !== botId);
               swarmMap[pieceIndex] = filteredBots;
            }

            const totalPeers = Object.values(swarmMap).flat().length;
            console.log(`✅ Swarm map loaded (${totalPeers} peer entries)`);
         } catch (err) {
            console.error('❌ Failed to parse swarm map:', err.message);
         }

         startPieceDownloads(infoHash, payload, outDir, downloadProgress, swarmMap);
      });
   });

   req.on('error', err => {
      console.warn(`⚠️ Failed to fetch swarm map: ${err.message}`);
      startPieceDownloads(infoHash, payload, outDir, downloadProgress, swarmMap);
   });

   req.setTimeout(5000, () => {
      req.destroy();
      console.warn(`⚠️ Swarm map request timed out`);
      startPieceDownloads(infoHash, payload, outDir, downloadProgress, swarmMap);
   });
}

function startPieceDownloads(infoHash, payload, outDir, downloadProgress, swarmMap) {
   const MAX_CONCURRENT = 3;  // Reduced for stability
   const MAX_RETRIES = 3;
   const retryCount = new Map();
   let isComplete = false;

   const peers = getPeers();
   console.log(`👥 Found ${peers.length} peers for potential downloads`);

   function getNextPieceToDownload() {
      for (let i = 0; i < payload.pieces.length; i++) {
         if (!downloadProgress.pieces.has(i) &&
            !downloadProgress.pendingPieces.has(i) &&
            !downloadProgress.failedPieces.has(i) &&
            (retryCount.get(i) || 0) < MAX_RETRIES) {
            return i;
         }
      }
      return null;
   }

   function selectPeerForPiece(pieceIndex) {
      // Try peers from swarm first
      const botsWithPiece = swarmMap[pieceIndex] || [];

      if (botsWithPiece.length > 0 && peers.length > 0) {
         const randomBotId = botsWithPiece[Math.floor(Math.random() * botsWithPiece.length)];
         const peer = peers.find(p => p.id === randomBotId);
         if (peer) {
            return { ip: peer.ip, port: 5000, source: 'peer' };
         }
      }

      // Fallback to controller
      return {
         ip: DOWNLOAD_CONFIG.CONTROLLER_IP,
         port: DOWNLOAD_CONFIG.CONTROLLER_PORT,
         source: 'controller'
      };
   }

   function downloadPiece(pieceIndex) {
      if (isComplete) return;

      const piece = payload.pieces[pieceIndex];
      if (!piece) return;

      downloadProgress.pendingPieces.add(pieceIndex);
      const peer = selectPeerForPiece(pieceIndex);

      console.log(`📥 Downloading piece ${pieceIndex} from ${peer.source} (${peer.ip}:${peer.port})`);

      requestPiece(peer.ip, peer.port, infoHash, pieceIndex, (err, buffer) => {
         downloadProgress.pendingPieces.delete(pieceIndex);

         if (err) {
            const attempts = retryCount.get(pieceIndex) || 0;
            retryCount.set(pieceIndex, attempts + 1);

            console.error(`❌ Piece ${pieceIndex} failed (attempt ${attempts + 1}/${MAX_RETRIES}): ${err.message}`);

            if (attempts + 1 >= MAX_RETRIES) {
               downloadProgress.failedPieces.add(pieceIndex);
               console.error(`🛑 Piece ${pieceIndex} failed permanently`);
            }

            // Try next piece
            setTimeout(startNextDownload, 1000);
            return;
         }

         // Verify hash
         const actualHash = crypto.createHash('sha1').update(buffer).digest('hex');
         if (actualHash !== piece.hash) {
            const attempts = retryCount.get(pieceIndex) || 0;
            retryCount.set(pieceIndex, attempts + 1);

            console.warn(`❌ Hash mismatch for piece ${pieceIndex} (attempt ${attempts + 1})`);
            setTimeout(startNextDownload, 1000);
            return;
         }

         // Save piece
         const piecePath = path.join(outDir, `${pieceIndex}.part`);
         try {
            fs.writeFileSync(piecePath, buffer);
            downloadProgress.pieces.add(pieceIndex);
            downloadProgress.completed++;

            // Save progress
            state.saveState(infoHash, {
               completed: downloadProgress.completed,
               pieces: [...downloadProgress.pieces]
            });

            // Announce to swarm
            announceHave(infoHash, pieceIndex);

            const percent = ((downloadProgress.completed / downloadProgress.total) * 100).toFixed(1);
            console.log(`✅ Piece ${pieceIndex} complete (${downloadProgress.completed}/${downloadProgress.total} - ${percent}%)`);

            // Check completion
            if (downloadProgress.completed >= downloadProgress.total) {
               isComplete = true;
               console.log(`🎉 All pieces downloaded for ${infoHash}!`);
               return combineIntorrent(infoHash, payload);
            }

         } catch (saveErr) {
            console.error(`❌ Failed to save piece ${pieceIndex}: ${saveErr.message}`);
         }

         // Continue downloading
         startNextDownload();
      });
   }

   function startNextDownload() {
      if (isComplete) return;

      const pendingCount = downloadProgress.pendingPieces.size;
      if (pendingCount >= MAX_CONCURRENT) return;

      const nextPiece = getNextPieceToDownload();
      if (nextPiece === null) {
         // No more pieces to download
         if (pendingCount === 0) {
            // Nothing pending, check if we failed
            const remainingPieces = downloadProgress.total - downloadProgress.completed;
            if (remainingPieces > 0) {
               console.error(`🛑 Download incomplete: ${remainingPieces} pieces failed`);
               isComplete = true;
            }
         }
         return;
      }

      downloadPiece(nextPiece);

      // Start more downloads if we have capacity
      if (pendingCount + 1 < MAX_CONCURRENT) {
         setTimeout(startNextDownload, 100);
      }
   }

   // Start initial downloads
   for (let i = 0; i < Math.min(MAX_CONCURRENT, 2); i++) {
      setTimeout(() => startNextDownload(), i * 100);
   }
}

function combineIntorrent(infoHash, payload) {
   const piecePath = path.join(PATHS.PIECES_DIR, infoHash);
   const finalFile = path.join(PATHS.UPLOADS_DIR, payload.name);

   try {
      fs.mkdirSync(PATHS.UPLOADS_DIR, { recursive: true });
   } catch (err) {
      console.error(`❌ Failed to create uploads directory: ${err.message}`);
      return;
   }

   console.log(`🔄 Combining ${payload.pieces.length} pieces into ${finalFile}`);

   try {
      const writeStream = fs.createWriteStream(finalFile);
      let totalWritten = 0;
      let piecesProcessed = 0;

      const processPiece = (index) => {
         if (index >= payload.pieces.length) {
            writeStream.end();
            return;
         }

         const partPath = path.join(piecePath, `${index}.part`);
         if (!fs.existsSync(partPath)) {
            writeStream.destroy();
            throw new Error(`Missing piece ${index}`);
         }

         const data = fs.readFileSync(partPath);
         writeStream.write(data);
         totalWritten += data.length;
         piecesProcessed++;

         if (piecesProcessed % 10 === 0 || piecesProcessed === payload.pieces.length) {
            console.log(`📝 Combined ${piecesProcessed}/${payload.pieces.length} pieces`);
         }

         // Process next piece
         setImmediate(() => processPiece(index + 1));
      };

      writeStream.on('finish', () => {
         const stats = fs.statSync(finalFile);
         console.log(`📦 Final file: ${finalFile} (${stats.size} bytes)`);

         if (stats.size === payload.size) {
            console.log(`✅ File assembled correctly!`);
         } else {
            console.warn(`⚠️ Size mismatch! Expected ${payload.size}, got ${stats.size}`);
         }

         // Cleanup
         setTimeout(() => {
            try {
               if (fs.existsSync(piecePath)) {
                  fs.rmSync(piecePath, { recursive: true });
                  console.log(`🧹 Cleaned up pieces directory`);
               }
               delete activeDownloads[infoHash];
               state.clearState(infoHash);
            } catch (cleanupErr) {
               console.warn(`⚠️ Cleanup failed: ${cleanupErr.message}`);
            }
         }, 1000);
      });

      writeStream.on('error', (err) => {
         console.error(`❌ Write stream error: ${err.message}`);
         if (fs.existsSync(finalFile)) {
            fs.unlinkSync(finalFile);
         }
      });

      // Start processing pieces
      processPiece(0);

   } catch (err) {
      console.error(`❌ Error combining pieces: ${err.message}`);
      if (fs.existsSync(finalFile)) {
         try {
            fs.unlinkSync(finalFile);
         } catch { }
      }
   }
}

function requestPiece(ip, port, infoHash, pieceIndex, cb) {
   const options = {
      hostname: ip,
      port: port,
      path: `/piece/${infoHash}/${pieceIndex}`,
      method: 'GET',
      timeout: 15000
   };

   const req = http.request(options, res => {
      if (res.statusCode !== 200) {
         return cb(new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`));
      }

      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
         try {
            const buffer = Buffer.concat(chunks);
            cb(null, buffer);
         } catch (err) {
            cb(new Error(`Failed to concatenate chunks: ${err.message}`));
         }
      });
   });

   req.on('error', cb);
   req.on('timeout', () => {
      req.destroy();
      cb(new Error('Request timeout'));
   });

   req.end();
}

function announceHave(infoHash, index) {
   if (!mqtt) return;

   try {
      const topic = `ghostswarm/torrent/have/${botId}`;
      const msg = { infoHash, pieceIndex: index };
      mqtt.publish(topic, JSON.stringify(msg), { qos: 1 });
   } catch (err) {
      console.warn(`⚠️ Failed to announce piece ${index}: ${err.message}`);
   }
}

function getPeers() {
   try {
      const peerFile = PATHS.PEER_FILE || path.join(process.cwd(), 'peers.json');
      if (fs.existsSync(peerFile)) {
         const data = fs.readFileSync(peerFile, 'utf8');
         return JSON.parse(data);
      }
   } catch (err) {
      console.warn(`⚠️ Could not read peers file: ${err.message}`);
   }
   return [];
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
         percent: ((prog.completed / prog.total) * 100).toFixed(1),
         pending: prog.pendingPieces.size,
         failed: prog.failedPieces.size
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
