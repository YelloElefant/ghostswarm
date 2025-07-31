// Controller/app/tracker.js
const express = require('express');
const path = require('path');
const fs = require('fs');
const app = express();
const config = require('./config');
const { redis } = require('./redis/redis');
const WebSocket = require('ws');

const UPLOADS_DIR = config.UPLOADS_DIR;
const TORRENT_DIR = config.TORRENTS_DIR;
const HTTP_PORT = process.env.TRACKER_PORT || 5001;
const WS_PORT = process.env.TRACKER_WS_PORT || 5002;

// Memory management constants
const MAX_PEERS_PER_RESPONSE = 50; // Limit peer response size
const REDIS_TTL = 3600; // 1 hour TTL for swarm data
const CLEANUP_INTERVAL = 60000; // Clean up every minute

// Track active connections for cleanup
const activeConnections = new Set();

// HTTP Routes
app.get("/swarm/:infoHash", async (req, res) => {
   const infoHash = req.params.infoHash;

   if (!redis) {
      return res.status(500).json({ error: "Server not properly initialized" });
   }

   try {
      const swarm = await getSwarmMap(redis, infoHash);
      if (!swarm || Object.keys(swarm).length === 0) {
         return res.status(404).json({ error: "Swarm not found" });
      }
      res.json(swarm);
   } catch (error) {
      console.error(`❌ Error fetching swarm for ${infoHash}:`, error);
      res.status(500).json({ error: "Failed to fetch swarm data" });
   }
});

app.get('/bot/:botId', async (req, res) => {
   const botId = req.params.botId;
   if (!redis) {
      return res.status(500).json({ error: "Server not properly initialized" });
   }

   try {
      const data = await redis.get(`status:${botId}`);
      if (!data) {
         return res.status(404).json({ error: "Bot not found" });
      }

      const status = JSON.parse(data);
      res.json({
         id: botId,
         ip: status.ip || 'unknown',
         alive: status.status === "alive",
         lastSeen: status.lastSeen ? new Date(status.lastSeen).toLocaleString() : 'unknown',
      });
   } catch (parseError) {
      console.error(`❌ Error parsing status for ${botId}:`, parseError);
      res.status(500).json({ error: "Invalid bot status format" });
   }
});

async function getSwarmMap(redis, infoHash) {
   try {
      const entries = await redis.hgetall(`swarm:${infoHash}`);
      const swarm = {};

      // Limit the size to prevent memory issues
      const entryKeys = Object.keys(entries).slice(0, 1000); // Max 1000 pieces

      for (const pieceIndex of entryKeys) {
         try {
            swarm[pieceIndex] = JSON.parse(entries[pieceIndex] || '[]');
         } catch (err) {
            console.warn(`⚠️ Invalid JSON for piece ${pieceIndex}, skipping`);
         }
      }
      return swarm;
   } catch (err) {
      console.error(`❌ Error getting swarm map:`, err.message);
      return {};
   }
}

// WebSocket Server with better memory management
const wss = new WebSocket.Server({
   port: WS_PORT,
   maxPayload: 1024 * 1024, // 1MB max message size
   perMessageDeflate: false // Disable compression to save CPU/memory
});

console.log(`🎯 Tracker WebSocket server running on port ${WS_PORT}`);

wss.on('connection', (ws, req) => {
   const clientId = `${req.socket.remoteAddress}:${req.socket.remotePort}:${Date.now()}`;
   console.log(`🔗 Tracker client connected: ${clientId}`);

   // Add to active connections
   activeConnections.add(ws);
   ws.clientId = clientId;

   // Set ping/pong for connection health
   ws.isAlive = true;
   ws.on('pong', () => {
      ws.isAlive = true;
   });

   ws.on('message', async (data) => {
      try {
         // Limit message size
         if (data.length > 1024 * 10) { // 10KB max
            ws.send(JSON.stringify({
               type: 'error',
               message: 'Message too large'
            }));
            return;
         }

         const message = JSON.parse(data.toString());
         await handleTrackerMessage(ws, message);
      } catch (err) {
         console.error(`❌ Invalid tracker message from ${clientId}:`, err.message);
         ws.send(JSON.stringify({
            type: 'error',
            message: 'Invalid message format'
         }));
      }
   });

   ws.on('close', () => {
      console.log(`🔌 Tracker client disconnected: ${clientId}`);
      activeConnections.delete(ws);
   });

   ws.on('error', (err) => {
      console.error(`❌ WebSocket error for ${clientId}:`, err.message);
      activeConnections.delete(ws);
   });
});

async function handleTrackerMessage(ws, message) {
   switch (message.type) {
      case 'get_swarm':
         await handleGetSwarm(ws, message.infoHash);
         break;

      case 'announce_piece':
         await handleAnnouncePiece(message);
         break;

      default:
         console.warn(`⚠️ Unknown tracker message type: ${message.type}`);
   }
}

async function handleGetSwarm(ws, infoHash) {
   try {
      // Get swarm map from Redis with size limits
      const swarmKey = `swarm:${infoHash}`;
      const swarmData = await redis.hgetall(swarmKey);

      const peerMap = new Map(); // Use Map for better performance
      let processedPieces = 0;

      // Limit processing to prevent memory exhaustion
      for (const [pieceIndex, botsJson] of Object.entries(swarmData)) {
         if (processedPieces >= 1000) break; // Max 1000 pieces

         try {
            const bots = JSON.parse(botsJson || '[]');

            bots.forEach(botId => {
               if (!peerMap.has(botId)) {
                  peerMap.set(botId, { botId, pieces: [] });
               }
               peerMap.get(botId).pieces.push(parseInt(pieceIndex));
            });

            processedPieces++;
         } catch (err) {
            console.warn(`⚠️ Invalid JSON for piece ${pieceIndex}:`, err.message);
         }
      }

      // Convert to array and limit size
      const peers = Array.from(peerMap.values()).slice(0, MAX_PEERS_PER_RESPONSE);

      // Batch get IP addresses with limited concurrency
      const peersWithIPs = await getIPsForPeers(peers);

      const response = {
         type: 'swarm_response',
         infoHash: infoHash,
         peers: peersWithIPs,
         truncated: peerMap.size > MAX_PEERS_PER_RESPONSE
      };

      ws.send(JSON.stringify(response));
      console.log(`📊 Sent swarm info for ${infoHash}: ${peersWithIPs.length} peers (${peerMap.size} total)`);

      // Clean up
      peerMap.clear();

   } catch (err) {
      console.error(`❌ Failed to get swarm info:`, err.message);
      ws.send(JSON.stringify({
         type: 'error',
         message: 'Failed to get swarm info'
      }));
   }
}

async function getIPsForPeers(peers) {
   const results = [];
   const batchSize = 10; // Process in batches to limit concurrent Redis calls

   for (let i = 0; i < peers.length; i += batchSize) {
      const batch = peers.slice(i, i + batchSize);

      const batchPromises = batch.map(async (peer) => {
         try {
            const statusData = await redis.get(`status:${peer.botId}`);
            if (statusData) {
               const status = JSON.parse(statusData);
               peer.ip = status.ip || null;
            }
         } catch (err) {
            console.warn(`⚠️ Could not get IP for peer ${peer.botId}:`, err.message);
         }
         return peer;
      });

      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults);
   }

   return results;
}

async function handleAnnouncePiece(message) {
   const { infoHash, pieceIndex, botId } = message;

   try {
      // Update Redis swarm map with TTL
      const swarmKey = `swarm:${infoHash}`;
      const pieceKey = pieceIndex.toString();

      const existingBots = await redis.hget(swarmKey, pieceKey);
      const bots = existingBots ? JSON.parse(existingBots) : [];

      if (!bots.includes(botId)) {
         bots.push(botId);

         // Limit bots per piece to prevent unlimited growth
         const limitedBots = bots.slice(-20); // Keep only last 20 bots

         await redis.hset(swarmKey, pieceKey, JSON.stringify(limitedBots));

         // Set TTL on the swarm key
         await redis.expire(swarmKey, REDIS_TTL);

         console.log(`📦 Updated swarm: ${botId} has piece ${pieceIndex} of ${infoHash} (${limitedBots.length} bots)`);
      }

      // Broadcast to connected clients (clean up dead connections first)
      broadcastToClients({
         type: 'peer_update',
         infoHash: infoHash,
         pieceIndex: pieceIndex,
         botId: botId
      });

   } catch (err) {
      console.error(`❌ Failed to announce piece:`, err.message);
   }
}

function broadcastToClients(message) {
   const messageStr = JSON.stringify(message);
   let broadcastCount = 0;

   activeConnections.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
         try {
            client.send(messageStr);
            broadcastCount++;
         } catch (err) {
            console.warn(`⚠️ Failed to send to client ${client.clientId}:`, err.message);
            activeConnections.delete(client);
         }
      } else {
         // Remove dead connections
         activeConnections.delete(client);
      }
   });

   if (broadcastCount > 0) {
      console.log(`📡 Broadcasted update to ${broadcastCount} clients`);
   }
}

// Periodic cleanup to prevent memory leaks
setInterval(() => {
   // Clean up dead WebSocket connections
   const deadConnections = [];
   activeConnections.forEach(ws => {
      if (ws.readyState !== WebSocket.OPEN) {
         deadConnections.push(ws);
      }
   });

   deadConnections.forEach(ws => {
      activeConnections.delete(ws);
   });

   if (deadConnections.length > 0) {
      console.log(`🧹 Cleaned up ${deadConnections.length} dead connections`);
   }

   // Log memory usage
   const memUsage = process.memoryUsage();
   console.log(`💾 Memory: ${Math.round(memUsage.heapUsed / 1024 / 1024)}MB used, ${Math.round(memUsage.heapTotal / 1024 / 1024)}MB total, ${activeConnections.size} active connections`);

}, CLEANUP_INTERVAL);

// Ping/pong to detect dead connections
setInterval(() => {
   activeConnections.forEach(ws => {
      if (!ws.isAlive) {
         console.log(`💀 Terminating dead connection: ${ws.clientId}`);
         ws.terminate();
         activeConnections.delete(ws);
         return;
      }

      ws.isAlive = false;
      ws.ping();
   });
}, 30000); // Ping every 30 seconds

// Graceful shutdown
process.on('SIGTERM', () => {
   console.log('🛑 Shutting down tracker...');
   wss.close(() => {
      console.log('✅ Tracker shutdown complete');
      process.exit(0);
   });
});

// Start HTTP server
app.listen(HTTP_PORT, () => {
   console.log(`🌐 Tracker HTTP API listening on port ${HTTP_PORT}`);
});

module.exports = { wss, app };
