// Controller/seed.js
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const config = require('./config');

const UPLOADS_DIR = config.PATHS.UPLOADS_DIR;
const TORRENT_DIR = config.PATHS.TORRENTS_DIR;
const PORT = process.env.SEED_PORT || 5000;

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Track active connections and their capabilities
const connectedPeers = new Map();
const activeTorrents = new Map(); // infoHash -> Set of peer IDs that have it

// WebSocket connection handler
wss.on('connection', (ws, req) => {
   const peerId = generatePeerId();
   const peerInfo = {
      id: peerId,
      ws: ws,
      ip: req.socket.remoteAddress,
      torrents: new Set(), // Torrents this peer has
      lastPing: Date.now(),
      isAlive: true
   };

   connectedPeers.set(peerId, peerInfo);
   console.log(`🔗 Peer ${peerId} connected from ${peerInfo.ip} (${connectedPeers.size} total peers)`);

   // Send welcome message
   ws.send(JSON.stringify({
      type: 'welcome',
      peerId: peerId,
      message: 'Connected to ghostswarm seed network'
   }));

   ws.on('message', async (data) => {
      try {
         const message = JSON.parse(data.toString());
         await handlePeerMessage(peerId, message);
      } catch (err) {
         console.error(`❌ Invalid message from peer ${peerId}:`, err.message);
         ws.send(JSON.stringify({
            type: 'error',
            message: 'Invalid message format'
         }));
      }
   });

   ws.on('pong', () => {
      peerInfo.isAlive = true;
      peerInfo.lastPing = Date.now();
   });

   ws.on('close', () => {
      handlePeerDisconnect(peerId);
   });

   ws.on('error', (err) => {
      console.error(`❌ WebSocket error for peer ${peerId}:`, err.message);
      handlePeerDisconnect(peerId);
   });
});

async function handlePeerMessage(peerId, message) {
   const peer = connectedPeers.get(peerId);
   if (!peer) return;

   switch (message.type) {
      case 'announce':
         await handleAnnounce(peerId, message);
         break;

      case 'request_piece':
         await handlePieceRequest(peerId, message);
         break;

      case 'have':
         await handleHave(peerId, message);
         break;

      case 'get_peers':
         await handleGetPeers(peerId, message);
         break;

      case 'ping':
         peer.ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
         break;

      default:
         console.warn(`⚠️ Unknown message type from peer ${peerId}: ${message.type}`);
   }
}

async function handleAnnounce(peerId, message) {
   const { infoHash, pieces, torrentName } = message;
   const peer = connectedPeers.get(peerId);

   if (!peer) return;

   // Add this torrent to peer's list
   peer.torrents.add(infoHash);

   // Track which peers have this torrent
   if (!activeTorrents.has(infoHash)) {
      activeTorrents.set(infoHash, new Set());
   }
   activeTorrents.get(infoHash).add(peerId);

   console.log(`📢 Peer ${peerId} announced ${torrentName} with ${pieces?.length || 'all'} pieces`);

   // Respond with current swarm info
   const swarmPeers = Array.from(activeTorrents.get(infoHash) || [])
      .filter(id => id !== peerId && connectedPeers.has(id))
      .map(id => ({
         peerId: id,
         ip: connectedPeers.get(id).ip
      }));

   peer.ws.send(JSON.stringify({
      type: 'announce_response',
      infoHash: infoHash,
      swarmSize: swarmPeers.length + 1,
      peers: swarmPeers
   }));
}

async function handlePieceRequest(peerId, message) {
   const { infoHash, pieceIndex, requestId } = message;

   try {
      const torrentPath = path.join(TORRENT_DIR, `${infoHash}${config.PATHS.TORRENT_EXTENSION}`);

      if (!fs.existsSync(torrentPath)) {
         return sendError(peerId, requestId, 'Torrent not found');
      }

      const torrent = JSON.parse(fs.readFileSync(torrentPath));
      const pieceLength = torrent.pieceLength;
      const start = pieceIndex * pieceLength;
      const end = Math.min(start + pieceLength, torrent.size);

      const fullFilePath = path.join(UPLOADS_DIR, torrent.name);
      if (!fs.existsSync(fullFilePath)) {
         return sendError(peerId, requestId, 'Original file not found');
      }

      // Read the piece data
      const pieceData = fs.readFileSync(fullFilePath, { start, end: end - 1 });

      // Send piece data in chunks to avoid WebSocket message size limits
      const CHUNK_SIZE = 64 * 1024; // 64KB chunks
      const totalChunks = Math.ceil(pieceData.length / CHUNK_SIZE);

      const peer = connectedPeers.get(peerId);
      if (!peer) return;

      // Send piece header
      peer.ws.send(JSON.stringify({
         type: 'piece_response',
         requestId: requestId,
         infoHash: infoHash,
         pieceIndex: pieceIndex,
         totalSize: pieceData.length,
         totalChunks: totalChunks,
         status: 'start'
      }));

      // Send chunks
      for (let i = 0; i < totalChunks; i++) {
         const chunkStart = i * CHUNK_SIZE;
         const chunkEnd = Math.min(chunkStart + CHUNK_SIZE, pieceData.length);
         const chunk = pieceData.slice(chunkStart, chunkEnd);

         peer.ws.send(JSON.stringify({
            type: 'piece_chunk',
            requestId: requestId,
            chunkIndex: i,
            totalChunks: totalChunks,
            data: chunk.toString('base64')
         }));
      }

      // Send completion message
      peer.ws.send(JSON.stringify({
         type: 'piece_response',
         requestId: requestId,
         status: 'complete'
      }));

      console.log(`📦 Served piece ${pieceIndex} of ${infoHash} to peer ${peerId} (${pieceData.length} bytes)`);

   } catch (err) {
      console.error(`❌ Failed to serve piece ${pieceIndex} of ${infoHash}:`, err.message);
      sendError(peerId, requestId, err.message);
   }
}

async function handleHave(peerId, message) {
   const { infoHash, pieceIndex } = message;

   // Broadcast to other peers in the swarm that this peer has a new piece
   const swarmPeers = activeTorrents.get(infoHash) || new Set();

   for (const otherPeerId of swarmPeers) {
      if (otherPeerId !== peerId && connectedPeers.has(otherPeerId)) {
         const otherPeer = connectedPeers.get(otherPeerId);
         otherPeer.ws.send(JSON.stringify({
            type: 'peer_have',
            infoHash: infoHash,
            pieceIndex: pieceIndex,
            fromPeer: peerId
         }));
      }
   }
}

async function handleGetPeers(peerId, message) {
   const { infoHash } = message;
   const peer = connectedPeers.get(peerId);
   if (!peer) return;

   const swarmPeers = Array.from(activeTorrents.get(infoHash) || [])
      .filter(id => id !== peerId && connectedPeers.has(id))
      .map(id => ({
         peerId: id,
         ip: connectedPeers.get(id).ip,
         torrents: connectedPeers.get(id).torrents.size
      }));

   peer.ws.send(JSON.stringify({
      type: 'peers_response',
      infoHash: infoHash,
      peers: swarmPeers
   }));
}

function sendError(peerId, requestId, errorMessage) {
   const peer = connectedPeers.get(peerId);
   if (!peer) return;

   peer.ws.send(JSON.stringify({
      type: 'error',
      requestId: requestId,
      message: errorMessage
   }));
}

function handlePeerDisconnect(peerId) {
   const peer = connectedPeers.get(peerId);
   if (!peer) return;

   console.log(`🔌 Peer ${peerId} disconnected (${connectedPeers.size - 1} remaining)`);

   // Remove peer from all torrents
   for (const infoHash of peer.torrents) {
      const torrentPeers = activeTorrents.get(infoHash);
      if (torrentPeers) {
         torrentPeers.delete(peerId);
         if (torrentPeers.size === 0) {
            activeTorrents.delete(infoHash);
         }
      }
   }

   connectedPeers.delete(peerId);
}

function generatePeerId() {
   return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

// Keep HTTP endpoint for compatibility
app.get('/piece/:infoHash/:index', (req, res) => {
   const { infoHash, index } = req.params;
   const torrentPath = path.join(TORRENT_DIR, `${infoHash}${config.PATHS.TORRENT_EXTENSION}`);

   if (!fs.existsSync(torrentPath)) return res.status(404).send('Torrent not found');

   const torrent = JSON.parse(fs.readFileSync(torrentPath));
   const pieceIndex = parseInt(index);
   const pieceLength = torrent.pieceLength;
   const start = pieceIndex * pieceLength;
   const end = Math.min(start + pieceLength, torrent.size);

   const fullFilePath = path.join(UPLOADS_DIR, torrent.name);
   if (!fs.existsSync(fullFilePath)) return res.status(404).send('Original file not found');

   const stream = fs.createReadStream(fullFilePath, { start, end: end - 1 });
   stream.on('error', err => {
      console.error(`❌ Failed to stream piece ${index} of ${infoHash}`, err);
      res.status(500).send('Stream error');
   });
   stream.pipe(res);
});

// Health check endpoint
app.get('/health', (req, res) => {
   res.json({
      status: 'healthy',
      connectedPeers: connectedPeers.size,
      activeTorrents: activeTorrents.size,
      uptime: process.uptime()
   });
});

// Stats endpoint
app.get('/stats', (req, res) => {
   const stats = {
      connectedPeers: connectedPeers.size,
      activeTorrents: activeTorrents.size,
      torrents: {}
   };

   for (const [infoHash, peers] of activeTorrents.entries()) {
      stats.torrents[infoHash] = {
         swarmSize: peers.size,
         peers: Array.from(peers)
      };
   }

   res.json(stats);
});

// Periodic cleanup and health checks
setInterval(() => {
   const now = Date.now();
   const TIMEOUT = 60000; // 60 seconds

   for (const [peerId, peer] of connectedPeers.entries()) {
      if (now - peer.lastPing > TIMEOUT) {
         console.warn(`⏰ Peer ${peerId} timed out, disconnecting...`);
         peer.ws.terminate();
         handlePeerDisconnect(peerId);
      } else if (peer.ws.readyState === WebSocket.OPEN) {
         // Send ping
         peer.isAlive = false;
         peer.ws.ping();
      }
   }
}, 30000); // Check every 30 seconds

server.listen(PORT, () => {
   console.log(`🚀 WebSocket seeding server running on port ${PORT}`);
   console.log(`📊 HTTP endpoints: /health, /stats`);
   console.log(`🔌 WebSocket endpoint: ws://localhost:${PORT}`);
});