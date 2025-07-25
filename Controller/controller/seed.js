// Controller/seed.js
const express = require('express');
const path = require('path');
const fs = require('fs');
const app = express();

const UPLOADS_DIR = '/uploads'; // where the original uploaded files live
const TORRENT_DIR = path.join(__dirname, 'torrents'); // .ghostswarm files
const PORT = process.env.SEED_PORT || 5000;

// GET /piece/:infoHash/:index
app.get('/piece/:infoHash/:index', (req, res) => {
   const { infoHash, index } = req.params;
   const torrentPath = path.join(TORRENT_DIR, `${infoHash}.json`);

   if (!fs.existsSync(torrentPath)) return res.status(404).send('Torrent not found');

   const torrent = JSON.parse(fs.readFileSync(torrentPath));
   const pieceIndex = parseInt(index);
   const pieceLength = torrent.pieceLength;
   const start = pieceIndex * pieceLength;
   const end = Math.min(start + pieceLength, torrent.size);

   console.log(`📦 Serving piece ${index} of ${infoHash} (${start}-${end}) to ${req.ip}`);

   const fullFilePath = path.join(UPLOADS_DIR, torrent.name);
   if (!fs.existsSync(fullFilePath)) return res.status(404).send('Original file not found');

   const stream = fs.createReadStream(fullFilePath, { start, end: end - 1 });
   stream.on('error', err => {
      console.error(`❌ Failed to stream piece ${index} of ${infoHash}`, err);
      res.status(500).send('Stream error');
   });
   stream.pipe(res);
});

app.listen(PORT, () => {
   console.log(`🚀 Seeding server running on port ${PORT}`);
});