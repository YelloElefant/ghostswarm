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

   await redis.get(`swarm:${infoHash}`, (err, data) => {
      if (err) {
         console.error(`❌ Error fetching swarm map for ${infoHash}:`, err);
         return res.status(500).json({ error: "Failed to fetch swarm map" });
      }
      if (!data) {
         return res.status(404).json({ error: "Swarm map not found" });
      }

      try {
         const swarmMap = JSON.parse(data);
         res.json(swarmMap);
      } catch (parseError) {
         console.error(`❌ Error parsing swarm map for ${infoHash}:`, parseError);
         res.status(500).json({ error: "Invalid swarm map format" });
      }
   });

});






app.listen(PORT, () => {
   console.log(`Tracker service listening on port ${PORT}`);
});
