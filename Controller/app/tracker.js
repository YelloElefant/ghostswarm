// Controller/seed.js
const express = require('express');
const path = require('path');
const fs = require('fs');
const app = express();
const config = require('./config');
const { redis } = require('./redis/redis');
const WebSocket = require('ws');

const UPLOADS_DIR = config.UPLOADS_DIR;
const TORRENT_DIR = config.TORRENTS_DIR;
const HTTP_PORT = process.env.TRACKER_PORT || 5001; // HTTP API
const WS_PORT = process.env.TRACKER_WS_PORT || 5002; // WebSocket

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
   const entries = await redis.hgetall(`swarm:${infoHash}`);
   const swarm = {};
   for (const [pieceIndex, botsJson] of Object.entries(entries)) {
      swarm[pieceIndex] = JSON.parse(botsJson);
   }
   return swarm;
}

// WebSocket Server
const wss = new WebSocket.Server({ port: WS_PORT });

console.log(`🎯 Tracker WebSocket server running on port ${WS_PORT}`);

wss.on('connection', (ws, req) => {
   console.log(`🔗 Tracker client connected from ${req.socket.remoteAddress}`);

   ws.on('message', async (data) => {
      try {
         const message = JSON.parse(data.toString());
         await handleTrackerMessage(ws, message);
      } catch (err) {
         console.error(`❌ Invalid tracker message:`, err.message);
         ws.send(JSON.stringify({
            type: 'error',
            message: 'Invalid message format'
         }));
      }
   });

   ws.on('close', () => {
      console.log(`🔌 Tracker client disconnected`);
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
      // Get swarm map from Redis
      const swarmKey = `swarm:${infoHash}`;
      const swarmData = await redis.hgetall(swarmKey);

      const peers = [];
      for (const [pieceIndex, botsJson] of Object.entries(swarmData)) {
         const bots = JSON.parse(botsJson || '[]');

         bots.forEach(botId => {
            let peer = peers.find(p => p.botId === botId);
            if (!peer) {
               peer = { botId, pieces: [] };
               peers.push(peer);
            }
            peer.pieces.push(parseInt(pieceIndex));
         });
      }

      // Also include IP addresses for peers
      const peersWithIPs = await Promise.all(peers.map(async (peer) => {
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
      }));

      ws.send(JSON.stringify({
         type: 'swarm_response',
         infoHash: infoHash,
         peers: peersWithIPs
      }));

      console.log(`📊 Sent swarm info for ${infoHash}: ${peersWithIPs.length} peers`);

   } catch (err) {
      console.error(`❌ Failed to get swarm info:`, err.message);
      ws.send(JSON.stringify({
         type: 'error',
         message: 'Failed to get swarm info'
      }));
   }
}

async function handleAnnouncePiece(message) {
   const { infoHash, pieceIndex, botId } = message;

   try {
      // Update Redis swarm map
      const swarmKey = `swarm:${infoHash}`;
      const pieceKey = pieceIndex.toString();

      const existingBots = await redis.hget(swarmKey, pieceKey);
      const bots = existingBots ? JSON.parse(existingBots) : [];

      if (!bots.includes(botId)) {
         bots.push(botId);
         await redis.hset(swarmKey, pieceKey, JSON.stringify(bots));
         console.log(`📦 Updated swarm: ${botId} has piece ${pieceIndex} of ${infoHash}`);
      }

      // Broadcast to other connected clients
      wss.clients.forEach(client => {
         if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({
               type: 'peer_update',
               infoHash: infoHash,
               pieceIndex: pieceIndex,
               botId: botId
            }));
         }
      });

   } catch (err) {
      console.error(`❌ Failed to announce piece:`, err.message);
   }
}

// Start HTTP server
app.listen(HTTP_PORT, () => {
   console.log(`🌐 Tracker HTTP API listening on port ${HTTP_PORT}`);
});

module.exports = { wss, app };
