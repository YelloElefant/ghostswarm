// Controller/seed.js
const express = require('express');
const path = require('path');
const fs = require('fs');
const app = express();
const config = require('./config'); // Assuming you have a config file for constants
const { redis } = require('./redis/redis');

const UPLOADS_DIR = config.UPLOADS_DIR; // where the original uploaded files live
const TORRENT_DIR = config.TORRENTS_DIR; // where the torrent metadata files are stored
const PORT = process.env.TRACKER_PORT || 5001;

app.get("/swarm/:infoHash", async (req, res) => {
   const infoHash = req.params.infoHash;


   // get swarm map from redis
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



// GET takes a botID and returns the ip of that bot
app.get('/bot/:botId', async (req, res) => {
   const botId = req.params.botId;
   if (!redis) {
      return res.status(500).json({ error: "Server not properly initialized" });
   }

   await redis.get(`status:${botId}`, (err, data) => {
      if (err) {
         console.error(`❌ Error fetching status for ${botId}:`, err);
         return res.status(500).json({ error: "Failed to fetch bot status" });
      }
      if (!data) {
         return res.status(404).json({ error: "Bot not found" });
      }
      try {
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
});


async function getSwarmMap(redis, infoHash) {
   const entries = await redis.hgetall(`swarm:${infoHash}`);
   const swarm = {};
   for (const [pieceIndex, botsJson] of Object.entries(entries)) {
      swarm[pieceIndex] = JSON.parse(botsJson);
   }
   return swarm;
}



app.listen(PORT, () => {
   console.log(`Tracker service listening on port ${PORT}`);
});
