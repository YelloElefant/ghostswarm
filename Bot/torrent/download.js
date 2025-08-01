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

// Helper function to clean IP addresses
function cleanIPAddress(ip) {
   if (!ip) return null;

   // Remove IPv6 prefix for IPv4-mapped addresses
   if (ip.startsWith('::ffff:')) {
      return ip.substring(7);
   }

   // Remove port if included
   if (ip.includes(':') && !ip.startsWith('[')) {
      const parts = ip.split(':');
      if (parts.length === 2 && !isNaN(parts[1])) {
         return parts[0];
      }
   }

   return ip;
}

class TorrentDownloader {
   constructor(infoHash, metadata) {
      this.infoHash = infoHash;
      this.metadata = metadata; // Store full metadata including tags
      this.outDir = path.join(PATHS.PIECES_DIR, infoHash);

      // BitTorrent-like peer management
      this.peers = new Map(); // peerId -> peer connection info
      this.activePeerConnections = new Set(); // Currently connected peers
      this.maxPeers = 5; // Maximum concurrent peer connections
      this.availablePeers = []; // Pool of potential peers
      this.requestQueue = []; // Queue of piece requests
      this.pendingRequests = new Map(); // requestId -> request info
      this.pendingChunks = new Map(); // requestId -> chunk data

      // Download state
      this.downloadProgress = {
         total: metadata.pieces.length,
         completed: 0,
         pieces: new Set(),
         torrentName: metadata.name,
         pendingPieces: new Set(),
         failedPieces: new Set()
      };

      // Progress tracking
      this.lastLogTime = 0;
      this.lastCompletedCount = 0;
      this.isComplete = false;
      this.seederConnected = false;
      this.reconnectAttempts = 0;
      this.maxReconnectAttempts = 5;

      this.setupDirectories();
      this.validateExistingPieces();
   }

   setupDirectories() {
      const torrentPath = path.join(PATHS.TORRENTS_DIR, `${this.infoHash}${PATHS.TORRENT_EXTENSION}`);

      try {
         fs.mkdirSync(path.dirname(torrentPath), { recursive: true });
         fs.mkdirSync(this.outDir, { recursive: true });
         fs.writeFileSync(torrentPath, JSON.stringify(this.metadata, null, 2));
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
      this.metadata.pieces.forEach(p => pieceMap.set(p.index, p.hash));

      for (let i = 0; i < this.metadata.pieces.length; i++) {
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
      console.log(`🚀 Starting torrent download: ${this.metadata.name} (${this.metadata.pieces.length} pieces)`);
      console.log(`📦 Download status: ${this.downloadProgress.completed}/${this.downloadProgress.total} pieces already available`);

      if (this.downloadProgress.completed >= this.downloadProgress.total) {
         console.log(`🎉 All pieces already downloaded, combining...`);
         return this.combineFile();
      }

      // Try to connect to both seeder (port 5000) and tracker (port 5001)
      await Promise.allSettled([
         this.connectToSeeder(),
         this.connectToTracker()
      ]);

      // Start the download process regardless of connections
      this.startDownload();
   }

   async connectToSeeder() {
      return new Promise((resolve, reject) => {
         if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            console.warn(`⚠️ Max reconnection attempts reached for seeder, skipping...`);
            return reject(new Error('Max reconnection attempts reached'));
         }

         const seederUrl = `ws://${DOWNLOAD_CONFIG.CONTROLLER_IP}:5000`;
         console.log(`🔗 Connecting to seeder at ${seederUrl} (attempt ${this.reconnectAttempts + 1})`);

         const seederWs = new WebSocket(seederUrl);
         let connectionTimeout = setTimeout(() => {
            seederWs.terminate();
            reject(new Error('Seeder connection timeout'));
         }, 5000);

         seederWs.on('open', () => {
            clearTimeout(connectionTimeout);
            console.log(`✅ Connected to seeder`);
            this.seederConnected = true;
            this.reconnectAttempts = 0;

            // Announce this torrent to get peers
            seederWs.send(JSON.stringify({
               type: 'announce',
               infoHash: this.infoHash,
               pieces: Array.from(this.downloadProgress.pieces),
               torrentName: this.metadata.name
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
            clearTimeout(connectionTimeout);
            console.error(`❌ Seeder connection error:`, err.message);
            this.seederConnected = false;
            this.reconnectAttempts++;
            reject(err);
         });

         seederWs.on('close', () => {
            clearTimeout(connectionTimeout);
            console.warn(`⚠️ Seeder connection closed`);
            this.seederConnected = false;
         });

         this.seederWs = seederWs;
      });
   }

   async connectToTracker() {
      return new Promise((resolve, reject) => {
         // Use port 5002 for WebSocket if using Option 1, or 5001 if using Option 2
         const trackerUrl = `ws://${DOWNLOAD_CONFIG.CONTROLLER_IP}:5002`; // or 5001 for Option 2
         console.log(`🔗 Connecting to tracker at ${trackerUrl}`);

         const trackerWs = new WebSocket(trackerUrl);
         let connectionTimeout = setTimeout(() => {
            trackerWs.terminate();
            reject(new Error('Tracker connection timeout'));
         }, 5000);

         trackerWs.on('open', () => {
            clearTimeout(connectionTimeout);
            console.log(`✅ Connected to tracker`);
            this.trackerConnected = true;

            // Request swarm info from tracker
            trackerWs.send(JSON.stringify({
               type: 'get_swarm',
               infoHash: this.infoHash
            }));
         });

         trackerWs.on('message', (data) => {
            try {
               const message = JSON.parse(data.toString());
               this.handleTrackerMessage(message);
               if (message.type === 'swarm_response') {
                  resolve();
               }
            } catch (err) {
               console.error(`❌ Failed to parse tracker message:`, err.message);
            }
         });

         trackerWs.on('error', (err) => {
            clearTimeout(connectionTimeout);
            console.error(`❌ Tracker connection error:`, err.message);
            this.trackerConnected = false;
            reject(err);
         });

         trackerWs.on('close', () => {
            clearTimeout(connectionTimeout);
            console.warn(`⚠️ Tracker connection closed`);
            this.trackerConnected = false;
         });

         this.trackerWs = trackerWs;
      });
   }

   handleTrackerMessage(message) {
      switch (message.type) {
         case 'swarm_response':
            console.log(`📊 Tracker swarm info: ${message.peers?.length || 0} peers with pieces`);

            if (message.peers && message.peers.length > 0) {
               message.peers.forEach(peer => {
                  // Check if peer already exists
                  const existingPeer = this.availablePeers.find(p => p.peerId === peer.botId);
                  if (!existingPeer && peer.botId !== botId) {
                     this.availablePeers.push({
                        peerId: peer.botId,
                        ip: peer.ip || DOWNLOAD_CONFIG.CONTROLLER_IP, // Fallback to controller IP
                        port: 5000,
                        type: 'websocket',
                        pieces: peer.pieces || []
                     });
                     console.log(`👤 Added peer from tracker: ${peer.botId} (${peer.pieces?.length || 0} pieces)`);
                  }
               });
            }

            console.log(`👥 Total available peers: ${this.availablePeers.length}`);
            break;

         case 'peer_update':
            // Real-time peer updates from tracker
            if (message.botId !== botId) {
               console.log(`📦 Peer ${message.botId} updated: piece ${message.pieceIndex}`);
               // Could update our peer knowledge here
            }
            break;
      }
   }

   handleSeederMessage(message, ws) {
      switch (message.type) {
         case 'welcome':
            console.log(`👋 Seeder welcome: ${message.message}`);
            break;

         case 'announce_response':
            console.log(`📢 Got swarm info: ${message.swarmSize} peers`);

            // Always add controller as a WebSocket peer (not HTTP)
            const controllerPeer = {
               peerId: 'controller',
               ip: DOWNLOAD_CONFIG.CONTROLLER_IP,
               port: DOWNLOAD_CONFIG.CONTROLLER_PORT,
               type: 'websocket' // Controller is also a WebSocket peer
            };

            if (!this.availablePeers.find(p => p.peerId === controllerPeer.peerId)) {
               this.availablePeers.push(controllerPeer);
               console.log(`👤 Added controller peer: ${controllerPeer.ip}:${controllerPeer.port}`);
            }

            // Add other WebSocket peers with cleaned IP addresses
            if (message.peers && message.peers.length > 0) {
               message.peers.forEach(peer => {
                  const cleanIP = cleanIPAddress(peer.ip);
                  if (cleanIP && cleanIP !== 'localhost' && cleanIP !== '127.0.0.1') {
                     // Check if peer already exists
                     const existingPeer = this.availablePeers.find(p => p.peerId === peer.peerId);
                     if (!existingPeer) {
                        this.availablePeers.push({
                           peerId: peer.peerId,
                           ip: cleanIP,
                           port: 5000, // Standard peer port
                           type: 'websocket'
                        });
                        console.log(`👤 Added peer: ${peer.peerId} at ${cleanIP}:5000`);
                     }
                  } else {
                     console.warn(`⚠️ Skipping peer ${peer.peerId} with invalid IP: ${peer.ip}`);
                  }
               });
            }

            console.log(`👥 Available peers: ${this.availablePeers.length}`);
            break;

         case 'peer_have':
            // Another peer announced they have a piece
            console.log(`📦 Peer ${message.fromPeer} has piece ${message.pieceIndex} of ${message.infoHash}`);
            break;
      }
   }

   startDownload() {
      // If no seeder connection and no peers, add controller as fallback
      if (!this.seederConnected && this.availablePeers.length === 0) {
         this.addControllerAsPeer();
      }

      // Fill the request queue with pieces we need (in order)
      this.fillRequestQueue();

      // Connect to initial peers
      this.maintainPeerConnections();

      // Start requesting pieces
      this.processRequestQueue();

      // Start progress logging
      this.logProgress(true);

      // Periodic maintenance
      this.downloadInterval = setInterval(() => {
         this.maintainPeerConnections();
         this.processRequestQueue();
         this.logProgress();

         // Try to reconnect to seeder if disconnected and not at max attempts
         if (!this.seederConnected && this.reconnectAttempts < this.maxReconnectAttempts) {
            this.connectToSeeder().catch(() => {
               // Ignore errors, we'll try again later
            });
         }
      }, 1000);
   }

   fillRequestQueue() {
      // Add pieces we need to the queue (in order)
      for (let i = 0; i < this.metadata.pieces.length; i++) {
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
            console.log(`🔌 Removed disconnected peer: ${peerId}`);
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

      // All peers are now WebSocket peers (including controller)
      const cleanIP = cleanIPAddress(peerInfo.ip);
      if (!cleanIP) {
         console.error(`❌ Invalid IP for peer ${peerInfo.peerId}: ${peerInfo.ip}`);
         this.activePeerConnections.delete(peerInfo.peerId);
         return;
      }

      const wsUrl = `ws://${cleanIP}:${peerInfo.port}`;
      console.log(`🔗 Connecting to peer: ${peerInfo.peerId} at ${wsUrl}`);

      try {
         const ws = new WebSocket(wsUrl);

         // Set connection timeout
         const connectionTimeout = setTimeout(() => {
            ws.terminate();
            console.warn(`⏰ Connection timeout for peer ${peerInfo.peerId}`);
            this.activePeerConnections.delete(peerInfo.peerId);
         }, 5000);

         ws.on('open', () => {
            clearTimeout(connectionTimeout);
            this.peers.set(peerInfo.peerId, {
               ...peerInfo,
               ip: cleanIP,
               ws: ws,
               connected: true,
               requestsInFlight: 0
            });
            console.log(`✅ Connected to peer: ${peerInfo.peerId} (${cleanIP}:${peerInfo.port})`);
         });

         ws.on('message', (data) => {
            try {
               this.handlePeerMessage(peerInfo.peerId, JSON.parse(data.toString()));
            } catch (err) {
               console.error(`❌ Invalid message from peer ${peerInfo.peerId}:`, err.message);
            }
         });

         ws.on('close', () => {
            clearTimeout(connectionTimeout);
            this.peers.delete(peerInfo.peerId);
            this.activePeerConnections.delete(peerInfo.peerId);
            console.log(`🔌 Peer ${peerInfo.peerId} disconnected`);
         });

         ws.on('error', (err) => {
            clearTimeout(connectionTimeout);
            console.error(`❌ Peer ${peerInfo.peerId} error:`, err.message);
            this.peers.delete(peerInfo.peerId);
            this.activePeerConnections.delete(peerInfo.peerId);
         });
      } catch (err) {
         console.error(`❌ Failed to create WebSocket for peer ${peerInfo.peerId}:`, err.message);
         this.activePeerConnections.delete(peerInfo.peerId);
      }
   }

   processRequestQueue() {
      if (this.isComplete || this.requestQueue.length === 0) return;

      // Find available peers (not at request limit)
      const availablePeers = Array.from(this.peers.values()).filter(peer =>
         peer.connected && peer.requestsInFlight < 2 // Max 2 requests per peer
      );

      if (availablePeers.length === 0) {
         // If no peers available, log a warning periodically
         const now = Date.now();
         if (!this.lastNoPeersWarning || (now - this.lastNoPeersWarning) > 10000) {
            console.warn(`⚠️ No available peers for ${this.downloadProgress.torrentName}. Available: ${this.availablePeers.length}, Connected: ${this.peers.size}`);
            this.lastNoPeersWarning = now;
         }
         return;
      }

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

      // All peers now use WebSocket (including controller)
      try {
         peer.ws.send(JSON.stringify({
            type: 'request_piece',
            infoHash: this.infoHash,
            pieceIndex: request.pieceIndex,
            requestId: requestId
         }));

         console.log(`📥 Requesting piece ${request.pieceIndex} from ${peer.peerId} (websocket)`);
      } catch (err) {
         console.error(`❌ Failed to send request to peer ${peer.peerId}:`, err.message);
         this.handlePieceFailure(requestId, `Send failed: ${err.message}`);
         return;
      }
   }

   handlePeerMessage(peerId, message) {
      switch (message.type) {
         case 'piece_response':
            if (message.status === 'start') {
               // Piece transfer starting
               if (!this.pendingChunks) {
                  this.pendingChunks = new Map();
               }
               this.pendingChunks.set(message.requestId, {
                  chunks: new Array(message.totalChunks),
                  totalSize: message.totalSize,
                  receivedChunks: 0,
                  totalChunks: message.totalChunks
               });
            } else if (message.status === 'complete') {
               // Piece transfer complete
               const chunkData = this.pendingChunks?.get(message.requestId);
               if (chunkData && chunkData.receivedChunks === chunkData.totalChunks) {
                  const buffer = Buffer.concat(chunkData.chunks);
                  this.handlePieceSuccess(message.requestId, buffer);
                  this.pendingChunks.delete(message.requestId);
               } else {
                  this.handlePieceFailure(message.requestId, 'Incomplete chunk data');
               }
            }
            break;

         case 'piece_chunk':
            const chunkData = this.pendingChunks?.get(message.requestId);
            if (chunkData && message.chunkIndex < chunkData.totalChunks) {
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
      const piece = this.metadata.pieces[pieceIndex];

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
            console.log(`🎉 All pieces downloaded for ${this.metadata.name}!`);
            if (this.downloadInterval) {
               clearInterval(this.downloadInterval);
            }
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

      // Announce to seeder if connected
      if (this.seederWs && this.seederWs.readyState === WebSocket.OPEN) {
         try {
            this.seederWs.send(JSON.stringify({
               type: 'have',
               infoHash: this.infoHash,
               pieceIndex: pieceIndex
            }));
         } catch (err) {
            console.warn(`⚠️ Failed to announce to seeder: ${err.message}`);
         }
      }

      this.announceToTracker(pieceIndex);
   }

   announceToTracker(pieceIndex) {
      // Announce to tracker if connected
      if (this.trackerWs && this.trackerWs.readyState === WebSocket.OPEN) {
         try {
            this.trackerWs.send(JSON.stringify({
               type: 'announce_piece',
               infoHash: this.infoHash,
               pieceIndex: pieceIndex,
               botId: botId
            }));
         } catch (err) {
            console.warn(`⚠️ Failed to announce to tracker: ${err.message}`);
         }
      }
   }

   saveState() {
      state.saveState(this.infoHash, {
         completed: this.downloadProgress.completed,
         pieces: [...this.downloadProgress.pieces]
      });
   }

   combineFile() {
      const finalFile = path.join(PATHS.UPLOADS_DIR, this.metadata.name);

      try {
         fs.mkdirSync(PATHS.UPLOADS_DIR, { recursive: true });
      } catch (err) {
         console.error(`❌ Failed to create uploads directory: ${err.message}`);
         return;
      }

      console.log(`🔄 Combining ${this.metadata.pieces.length} pieces into ${this.metadata.name}`);

      try {
         const writeStream = fs.createWriteStream(finalFile);
         let piecesProcessed = 0;
         let lastLogTime = 0;

         const processPiece = (index) => {
            if (index >= this.metadata.pieces.length) {
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
               piecesProcessed === this.metadata.pieces.length ||
               (now - lastLogTime) > 2000) {
               const percent = ((piecesProcessed / this.metadata.pieces.length) * 100).toFixed(1);
               console.log(`📝 Combining: ${piecesProcessed}/${this.metadata.pieces.length} pieces (${percent}%)`);
               lastLogTime = now;
            }

            setImmediate(() => processPiece(index + 1));
         };

         writeStream.on('finish', () => {
            const stats = fs.statSync(finalFile);
            console.log(`📦 ✅ ${this.metadata.name} assembled successfully! (${stats.size} bytes)`);

            // Cleanup
            setTimeout(() => {
               try {
                  if (fs.existsSync(this.outDir)) {
                     fs.rmSync(this.outDir, { recursive: true });
                     console.log(`🧹 Cleaned up pieces for ${this.metadata.name}`);
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

      // Better status determination
      let downloadStatus;
      if (remainingPieces === 0) {
         downloadStatus = 'completed';
      } else if (prog.failedPieces.size > 0 && prog.pendingPieces.size === 0 && downloader.requestQueue.length === 0) {
         downloadStatus = 'failed';
      } else if (prog.pendingPieces.size > 0 || downloader.requestQueue.length > 0) {
         downloadStatus = 'downloading';
      } else if (downloader.activePeerConnections.size === 0) {
         downloadStatus = 'no_peers';
      } else {
         downloadStatus = 'stalled';
      }

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
         status: downloadStatus,
         tags: downloader.metadata?.tags || [], // Include tags from metadata
         size: downloader.metadata?.size || 0,
         createdAt: downloader.metadata?.createdAt || null
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
