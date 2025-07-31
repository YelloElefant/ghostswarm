const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');
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

class TorrentDownloader {
   constructor(infoHash, payload) {
      this.infoHash = infoHash;
      this.payload = payload;
      this.outDir = path.join(PATHS.PIECES_DIR, infoHash);

      // BitTorrent-like peer management
      this.peers = new Map(); // peerId -> peer connection info
      this.activePeerConnections = new Set(); // Currently connected peers
      this.maxPeers = 5; // Maximum concurrent peer connections
      this.availablePeers = []; // Pool of potential peers
      this.requestQueue = []; // Queue of piece requests
      this.pendingRequests = new Map(); // requestId -> request info

      // Download state
      this.downloadProgress = {
         total: payload.pieces.length,
         completed: 0,
         pieces: new Set(),
         torrentName: payload.name,
         pendingPieces: new Set(),
         failedPieces: new Set()
      };

      // Progress tracking
      this.lastLogTime = 0;
      this.lastCompletedCount = 0;
      this.isComplete = false;

      this.setupDirectories();
      this.validateExistingPieces();
   }

   setupDirectories() {
      const torrentPath = path.join(PATHS.TORRENTS_DIR, `${this.infoHash}${PATHS.TORRENT_EXTENSION}`);

      try {
         fs.mkdirSync(path.dirname(torrentPath), { recursive: true });
         fs.mkdirSync(this.outDir, { recursive: true });
         fs.writeFileSync(torrentPath, JSON.stringify(this.payload, null, 2));
      } catch (err) {
         console.error(`❌ Failed to setup directories for ${this.infoHash}:`, err.message);
         throw err;
      }
   }

   validateExistingPieces() {
      const saved = state.loadState(this.infoHash);
      if (saved && saved.pieces) {
         console.log(`🔁 Found saved state with ${saved.pieces.length} pieces`);
      }

      let validPieces = 0;
      const pieceMap = new Map();
      this.payload.pieces.forEach(p => pieceMap.set(p.index, p.hash));

      for (let i = 0; i < this.payload.pieces.length; i++) {
         const filePath = path.join(this.outDir, `${i}.part`);
         const expectedHash = pieceMap.get(i);

         if (fs.existsSync(filePath)) {
            try {
               const data = fs.readFileSync(filePath);
               const actualHash = crypto.createHash('sha1').update(data).digest('hex');

               if (actualHash === expectedHash) {
                  this.downloadProgress.pieces.add(i);
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

      this.downloadProgress.completed = validPieces;
      this.saveState();
   }

   async start() {
      console.log(`🚀 Starting torrent download: ${this.payload.name} (${this.payload.pieces.length} pieces)`);
      console.log(`📦 Download status: ${this.downloadProgress.completed}/${this.downloadProgress.total} pieces already available`);

      if (this.downloadProgress.completed >= this.downloadProgress.total) {
         console.log(`🎉 All pieces already downloaded, combining...`);
         return this.combineFile();
      }

      // Connect to seeder WebSocket to get peers
      await this.connectToSeeder();

      // Start the download process
      this.startDownload();
   }

   async connectToSeeder() {
      return new Promise((resolve, reject) => {
         const seederUrl = `ws://${DOWNLOAD_CONFIG.CONTROLLER_IP}:${DOWNLOAD_CONFIG.CONTROLLER_PORT}`;
         console.log(`🔗 Connecting to seeder at ${seederUrl}`);

         const seederWs = new WebSocket(seederUrl);

         seederWs.on('open', () => {
            console.log(`✅ Connected to seeder`);

            // Announce this torrent to get peers
            seederWs.send(JSON.stringify({
               type: 'announce',
               infoHash: this.infoHash,
               pieces: [], // We're downloading, not seeding yet
               torrentName: this.payload.name
            }));
         });

         seederWs.on('message', (data) => {
            try {
               const message = JSON.parse(data.toString());
               this.handleSeederMessage(message, seederWs);
               if (message.type === 'announce_response') {
                  resolve();
               }
            } catch (err) {
               console.error(`❌ Failed to parse seeder message:`, err.message);
            }
         });

         seederWs.on('error', (err) => {
            console.error(`❌ Seeder connection error:`, err.message);
            reject(err);
         });

         seederWs.on('close', () => {
            console.warn(`⚠️ Seeder connection closed`);
            setTimeout(() => this.connectToSeeder(), 5000); // Reconnect after 5 seconds
         });

         this.seederWs = seederWs;
      });
   }

   handleSeederMessage(message, ws) {
      switch (message.type) {
         case 'welcome':
            console.log(`👋 Seeder welcome: ${message.message}`);
            break;

         case 'announce_response':
            console.log(`📢 Got swarm info: ${message.swarmSize} peers`);
            this.availablePeers = [
               // Always include controller as a peer
               {
                  peerId: 'controller',
                  ip: DOWNLOAD_CONFIG.CONTROLLER_IP,
                  port: DOWNLOAD_CONFIG.CONTROLLER_PORT,
                  type: 'http' // Use HTTP for controller
               },
               // Add WebSocket peers
               ...message.peers.map(peer => ({
                  peerId: peer.peerId,
                  ip: peer.ip,
                  port: 5000,
                  type: 'websocket'
               }))
            ];
            console.log(`👥 Available peers: ${this.availablePeers.length}`);
            break;

         case 'peer_have':
            // Another peer announced they have a piece
            console.log(`📦 Peer ${message.fromPeer} has piece ${message.pieceIndex} of ${message.infoHash}`);
            break;
      }
   }

   startDownload() {
      // Fill the request queue with pieces we need (in order)
      this.fillRequestQueue();

      // Connect to initial peers
      this.maintainPeerConnections();

      // Start requesting pieces
      this.processRequestQueue();

      // Start progress logging
      this.logProgress(true);

      // Periodic maintenance
      setInterval(() => {
         this.maintainPeerConnections();
         this.processRequestQueue();
         this.logProgress();
      }, 1000);
   }

   fillRequestQueue() {
      // Add pieces we need to the queue (in order)
      for (let i = 0; i < this.payload.pieces.length; i++) {
         if (!this.downloadProgress.pieces.has(i) &&
            !this.downloadProgress.pendingPieces.has(i) &&
            !this.downloadProgress.failedPieces.has(i)) {
            this.requestQueue.push({
               pieceIndex: i,
               priority: 1, // Could implement different priorities later
               retries: 0
            });
         }
      }
   }

   maintainPeerConnections() {
      // Remove disconnected peers
      for (const [peerId, peer] of this.peers.entries()) {
         if (peer.ws && peer.ws.readyState !== WebSocket.OPEN && peer.type === 'websocket') {
            this.peers.delete(peerId);
            this.activePeerConnections.delete(peerId);
         }
      }

      // Connect to new peers if we have room
      while (this.activePeerConnections.size < this.maxPeers && this.availablePeers.length > 0) {
         const availablePeer = this.availablePeers.find(p => !this.activePeerConnections.has(p.peerId));
         if (availablePeer) {
            this.connectToPeer(availablePeer);
         } else {
            break;
         }
      }
   }

   connectToPeer(peerInfo) {
      if (this.activePeerConnections.has(peerInfo.peerId)) return;

      this.activePeerConnections.add(peerInfo.peerId);

      if (peerInfo.type === 'http') {
         // HTTP peer (controller) - no persistent connection needed
         this.peers.set(peerInfo.peerId, {
            ...peerInfo,
            connected: true,
            requestsInFlight: 0
         });
         console.log(`🔗 Added HTTP peer: ${peerInfo.peerId}`);
      } else {
         // WebSocket peer
         const ws = new WebSocket(`ws://${peerInfo.ip}:${peerInfo.port}`);

         ws.on('open', () => {
            this.peers.set(peerInfo.peerId, {
               ...peerInfo,
               ws: ws,
               connected: true,
               requestsInFlight: 0
            });
            console.log(`🔗 Connected to peer: ${peerInfo.peerId} (${peerInfo.ip})`);
         });

         ws.on('message', (data) => {
            this.handlePeerMessage(peerInfo.peerId, JSON.parse(data.toString()));
         });

         ws.on('close', () => {
            this.peers.delete(peerInfo.peerId);
            this.activePeerConnections.delete(peerInfo.peerId);
            console.log(`🔌 Peer ${peerInfo.peerId} disconnected`);
         });

         ws.on('error', (err) => {
            console.error(`❌ Peer ${peerInfo.peerId} error:`, err.message);
            this.peers.delete(peerInfo.peerId);
            this.activePeerConnections.delete(peerInfo.peerId);
         });
      }
   }

   processRequestQueue() {
      if (this.isComplete || this.requestQueue.length === 0) return;

      // Find available peers (not at request limit)
      const availablePeers = Array.from(this.peers.values()).filter(peer =>
         peer.connected && peer.requestsInFlight < 2 // Max 2 requests per peer
      );

      if (availablePeers.length === 0) return;

      // Send requests to available peers
      while (this.requestQueue.length > 0 && availablePeers.length > 0) {
         const request = this.requestQueue.shift();
         const peer = availablePeers[Math.floor(Math.random() * availablePeers.length)];

         this.requestPieceFromPeer(peer, request);

         // Remove peer from available list if it's now at capacity
         peer.requestsInFlight++;
         if (peer.requestsInFlight >= 2) {
            const index = availablePeers.indexOf(peer);
            availablePeers.splice(index, 1);
         }
      }
   }

   requestPieceFromPeer(peer, request) {
      const requestId = `${this.infoHash}_${request.pieceIndex}_${Date.now()}`;

      this.pendingRequests.set(requestId, {
         ...request,
         peer: peer,
         startTime: Date.now()
      });

      this.downloadProgress.pendingPieces.add(request.pieceIndex);

      if (peer.type === 'http') {
         // HTTP request to controller
         this.requestPieceHTTP(peer, request, requestId);
      } else {
         // WebSocket request to peer
         peer.ws.send(JSON.stringify({
            type: 'request_piece',
            infoHash: this.infoHash,
            pieceIndex: request.pieceIndex,
            requestId: requestId
         }));
      }

      console.log(`📥 Requesting piece ${request.pieceIndex} from ${peer.peerId} (${peer.type})`);
   }

   requestPieceHTTP(peer, request, requestId) {
      const http = require('http');
      const options = {
         hostname: peer.ip,
         port: peer.port,
         path: `/piece/${this.infoHash}/${request.pieceIndex}`,
         method: 'GET',
         timeout: 15000
      };

      const req = http.request(options, res => {
         if (res.statusCode !== 200) {
            return this.handlePieceFailure(requestId, `HTTP ${res.statusCode}: ${res.statusMessage}`);
         }

         const chunks = [];
         res.on('data', chunk => chunks.push(chunk));
         res.on('end', () => {
            try {
               const buffer = Buffer.concat(chunks);
               this.handlePieceSuccess(requestId, buffer);
            } catch (err) {
               this.handlePieceFailure(requestId, `Failed to concatenate chunks: ${err.message}`);
            }
         });
      });

      req.on('error', err => {
         this.handlePieceFailure(requestId, err.message);
      });

      req.on('timeout', () => {
         req.destroy();
         this.handlePieceFailure(requestId, 'Request timeout');
      });

      req.end();
   }

   handlePeerMessage(peerId, message) {
      switch (message.type) {
         case 'piece_response':
            if (message.status === 'start') {
               // Piece transfer starting
               this.pendingChunks = new Map();
               this.pendingChunks.set(message.requestId, {
                  chunks: new Array(message.totalChunks),
                  totalSize: message.totalSize,
                  receivedChunks: 0,
                  totalChunks: message.totalChunks
               });
            } else if (message.status === 'complete') {
               // Piece transfer complete
               const chunkData = this.pendingChunks.get(message.requestId);
               if (chunkData) {
                  const buffer = Buffer.concat(chunkData.chunks);
                  this.handlePieceSuccess(message.requestId, buffer);
                  this.pendingChunks.delete(message.requestId);
               }
            }
            break;

         case 'piece_chunk':
            const chunkData = this.pendingChunks.get(message.requestId);
            if (chunkData) {
               chunkData.chunks[message.chunkIndex] = Buffer.from(message.data, 'base64');
               chunkData.receivedChunks++;
            }
            break;

         case 'error':
            this.handlePieceFailure(message.requestId, message.message);
            break;
      }
   }

   handlePieceSuccess(requestId, buffer) {
      const request = this.pendingRequests.get(requestId);
      if (!request) return;

      const pieceIndex = request.pieceIndex;
      const piece = this.payload.pieces[pieceIndex];

      // Verify hash
      const actualHash = crypto.createHash('sha1').update(buffer).digest('hex');
      if (actualHash !== piece.hash) {
         return this.handlePieceFailure(requestId, 'Hash mismatch');
      }

      // Save piece
      const piecePath = path.join(this.outDir, `${pieceIndex}.part`);
      try {
         fs.writeFileSync(piecePath, buffer);
         this.downloadProgress.pieces.add(pieceIndex);
         this.downloadProgress.completed++;
         this.downloadProgress.pendingPieces.delete(pieceIndex);

         // Announce to swarm
         this.announceHave(pieceIndex);

         console.log(`✅ Piece ${pieceIndex} complete (${this.downloadProgress.completed}/${this.downloadProgress.total})`);

         // Check completion
         if (this.downloadProgress.completed >= this.downloadProgress.total) {
            this.isComplete = true;
            console.log(`🎉 All pieces downloaded for ${this.payload.name}!`);
            this.combineFile();
         } else {
            // Save progress periodically
            if (this.downloadProgress.completed % 5 === 0) {
               this.saveState();
            }
         }

      } catch (err) {
         return this.handlePieceFailure(requestId, `Failed to save piece: ${err.message}`);
      }

      // Cleanup
      this.pendingRequests.delete(requestId);
      if (request.peer) {
         request.peer.requestsInFlight--;
      }
   }

   handlePieceFailure(requestId, errorMessage) {
      const request = this.pendingRequests.get(requestId);
      if (!request) return;

      console.error(`❌ Piece ${request.pieceIndex} failed: ${errorMessage}`);

      this.downloadProgress.pendingPieces.delete(request.pieceIndex);

      // Retry logic
      request.retries++;
      if (request.retries < 3) {
         // Add back to queue for retry
         this.requestQueue.unshift(request);
      } else {
         // Mark as failed
         this.downloadProgress.failedPieces.add(request.pieceIndex);
         console.error(`🛑 Piece ${request.pieceIndex} failed permanently`);
      }

      // Cleanup
      this.pendingRequests.delete(requestId);
      if (request.peer) {
         request.peer.requestsInFlight--;
      }
   }

   logProgress(force = false) {
      const now = Date.now();
      if (!force && (now - this.lastLogTime) < 3000) return;

      const percent = ((this.downloadProgress.completed / this.downloadProgress.total) * 100).toFixed(1);
      const speed = this.downloadProgress.completed - this.lastCompletedCount;
      const eta = speed > 0 ? Math.ceil((this.downloadProgress.total - this.downloadProgress.completed) / speed * 3) : '∞';

      console.log(`📦 [${this.downloadProgress.torrentName}] ${this.downloadProgress.completed}/${this.downloadProgress.total} pieces (${percent}%) | Peers: ${this.activePeerConnections.size} | Queue: ${this.requestQueue.length} | Speed: ${speed}/3s | ETA: ${eta}s`);

      this.lastLogTime = now;
      this.lastCompletedCount = this.downloadProgress.completed;
   }

   announceHave(pieceIndex) {
      if (mqtt) {
         try {
            const topic = `ghostswarm/torrent/have/${botId}`;
            const msg = { infoHash: this.infoHash, pieceIndex: pieceIndex };
            mqtt.publish(topic, JSON.stringify(msg), { qos: 1 });
         } catch (err) {
            console.warn(`⚠️ Failed to announce piece ${pieceIndex}: ${err.message}`);
         }
      }

      // Also announce to seeder
      if (this.seederWs && this.seederWs.readyState === WebSocket.OPEN) {
         this.seederWs.send(JSON.stringify({
            type: 'have',
            infoHash: this.infoHash,
            pieceIndex: pieceIndex
         }));
      }
   }

   saveState() {
      state.saveState(this.infoHash, {
         completed: this.downloadProgress.completed,
         pieces: [...this.downloadProgress.pieces]
      });
   }

   combineFile() {
      const finalFile = path.join(PATHS.UPLOADS_DIR, this.payload.name);

      try {
         fs.mkdirSync(PATHS.UPLOADS_DIR, { recursive: true });
      } catch (err) {
         console.error(`❌ Failed to create uploads directory: ${err.message}`);
         return;
      }

      console.log(`🔄 Combining ${this.payload.pieces.length} pieces into ${this.payload.name}`);

      try {
         const writeStream = fs.createWriteStream(finalFile);
         let piecesProcessed = 0;
         let lastLogTime = 0;

         const processPiece = (index) => {
            if (index >= this.payload.pieces.length) {
               writeStream.end();
               return;
            }

            const partPath = path.join(this.outDir, `${index}.part`);
            if (!fs.existsSync(partPath)) {
               writeStream.destroy();
               throw new Error(`Missing piece ${index}`);
            }

            const data = fs.readFileSync(partPath);
            writeStream.write(data);
            piecesProcessed++;

            // Log progress
            const now = Date.now();
            if (piecesProcessed % 25 === 0 ||
               piecesProcessed === this.payload.pieces.length ||
               (now - lastLogTime) > 2000) {
               const percent = ((piecesProcessed / this.payload.pieces.length) * 100).toFixed(1);
               console.log(`📝 Combining: ${piecesProcessed}/${this.payload.pieces.length} pieces (${percent}%)`);
               lastLogTime = now;
            }

            setImmediate(() => processPiece(index + 1));
         };

         writeStream.on('finish', () => {
            const stats = fs.statSync(finalFile);
            console.log(`📦 ✅ ${this.payload.name} assembled successfully! (${stats.size} bytes)`);

            // Cleanup
            setTimeout(() => {
               try {
                  if (fs.existsSync(this.outDir)) {
                     fs.rmSync(this.outDir, { recursive: true });
                     console.log(`🧹 Cleaned up pieces for ${this.payload.name}`);
                  }
                  delete activeDownloads[this.infoHash];
                  state.clearState(this.infoHash);
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

         processPiece(0);

      } catch (err) {
         console.error(`❌ Error combining pieces: ${err.message}`);
      }
   }
}

// Main functions
function handleTorrentDownload(infoHash, payload) {
   if (activeDownloads[infoHash]) {
      console.warn(`⚠️ Torrent ${infoHash} already downloading, skipping...`);
      return;
   }

   const downloader = new TorrentDownloader(infoHash, payload);
   activeDownloads[infoHash] = downloader;

   downloader.start().catch(err => {
      console.error(`❌ Failed to start torrent ${infoHash}:`, err.message);
      delete activeDownloads[infoHash];
   });
}

function getDownloadStatus() {
   const status = {};
   for (const [infoHash, downloader] of Object.entries(activeDownloads)) {
      const prog = downloader.downloadProgress;
      const remainingPieces = prog.total - prog.completed;

      status[infoHash] = {
         name: prog.torrentName,
         completed: prog.completed,
         total: prog.total,
         percent: ((prog.completed / prog.total) * 100).toFixed(1),
         pending: prog.pendingPieces.size,
         failed: prog.failedPieces.size,
         remaining: remainingPieces,
         peers: downloader.activePeerConnections.size,
         queue: downloader.requestQueue.length,
         status: remainingPieces === 0 ? 'complete' :
            prog.failedPieces.size > 0 ? 'failed' :
               prog.pendingPieces.size > 0 ? 'downloading' : 'stalled'
      };
   }
   return status;
}

async function download(torrent, hash, client) {
   mqtt = client;
   handleTorrentDownload(hash, torrent);
}

module.exports = {
   handleTorrentDownload,
   download,
   getDownloadStatus
};
