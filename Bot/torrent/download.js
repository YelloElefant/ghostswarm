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
let mqtt;

let botId;
try {
   botId = fs.readFileSync(PATHS.HOST_HOSTNAME, "utf8").trim();
} catch {
   botId = os.hostname();
}

function getPeers() {
   try {
      const data = fs.readFileSync(PATHS.PEER_FILE, 'utf8');
      return JSON.parse(data);
   } catch {
      return [];
   }
}

function announceHave(infoHash, index) {
   mqtt.publish(`ghostswarm/torrent/have/${botId}`, JSON.stringify({ infoHash, pieceIndex: index }), { qos: 1 });
}

function requestPiece(ip, port, infoHash, pieceIndex, cb) {
   http.get(`http://${ip}:${port}/piece/${infoHash}/${pieceIndex}`, res => {
      if (res.statusCode !== 200) return cb(new Error(res.statusMessage));
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
   }).on('error', cb);
}

function removeSelfFromSwarm(swarmMap, botId) {
   for (const [i, bots] of Object.entries(swarmMap)) {
      swarmMap[i] = bots.filter(b => b !== botId);
   }
   return swarmMap;
}

function combineIntorrent(infoHash, payload) {
   const piecePath = path.join(PATHS.PIECES_DIR, infoHash);
   const finalFile = path.join(PATHS.UPLOADS_DIR, payload.name);
   fs.mkdirSync(PATHS.UPLOADS_DIR, { recursive: true });

   const writeStream = fs.createWriteStream(finalFile);
   let i = 0;

   function next() {
      if (i >= payload.pieces.length) return writeStream.end();

      const partPath = path.join(piecePath, `${i}.part`);
      const read = fs.createReadStream(partPath);
      read.on('end', () => {
         fs.unlinkSync(partPath);
         i++;
         next();
      });
      read.pipe(writeStream, { end: false });
   }

   writeStream.on('finish', () => {
      state.clearState(infoHash);
      fs.rmSync(piecePath, { recursive: true, force: true });
      console.log(`✅ Combined ${infoHash} to ${finalFile}`);
   });

   next();
}

function downloadPieces(infoHash, payload, swarmMap, peers, outDir, progress) {
   const pending = payload.pieces.filter(p => !progress.pieces.has(p.index));
   const limit = 10;
   let active = 0;
   const retry = {};

   function downloadNextPiece() {
      if (progress.completed >= progress.total) return;

      while (active < limit && pending.length > 0) {
         const piece = pending.shift();
         const pathPart = path.join(outDir, `${piece.index}.part`);

         if (fs.existsSync(pathPart)) {
            const hash = crypto.createHash('sha1').update(fs.readFileSync(pathPart)).digest('hex');
            if (hash === piece.hash) {
               progress.pieces.add(piece.index);
               progress.completed++;
               announceHave(infoHash, piece.index);
               continue;
            } else {
               fs.unlinkSync(pathPart);
            }
         }

         let peer = { ip: DOWNLOAD_CONFIG.CONTROLLER_IP, port: DOWNLOAD_CONFIG.CONTROLLER_PORT };
         const candidates = swarmMap[piece.index] || [];
         if (candidates.length) {
            const peerId = candidates[Math.floor(Math.random() * candidates.length)];
            const found = peers.find(p => p.id === peerId);
            if (found) peer = { ip: found.ip, port: 5000 };
         }

         active++;
         requestPiece(peer.ip, peer.port, infoHash, piece.index, (err, data) => {
            active--;
            if (err || crypto.createHash('sha1').update(data).digest('hex') !== piece.hash) {
               retry[piece.index] = (retry[piece.index] || 0) + 1;
               if (retry[piece.index] < 5) pending.push(piece);
            } else {
               fs.writeFileSync(pathPart, data);
               progress.pieces.add(piece.index);
               progress.completed++;
               state.saveState(infoHash, { completed: progress.completed, pieces: [...progress.pieces] });
               announceHave(infoHash, piece.index);
               if (progress.completed >= progress.total) combineIntorrent(infoHash, payload);
            }
         });
      }
   }

   setInterval(downloadNextPiece, 250);
}

function handleTorrentDownload(infoHash, payload) {
   const outDir = path.join(PATHS.PIECES_DIR, infoHash);
   const torrentPath = path.join(PATHS.TORRENTS_DIR, `${infoHash}${PATHS.TORRENT_EXTENSION}`);
   fs.mkdirSync(outDir, { recursive: true });
   fs.writeFileSync(torrentPath, JSON.stringify(payload, null, 2));

   const progress = { total: payload.pieces.length, completed: 0, pieces: new Set() };
   const saved = state.loadState(infoHash);
   if (saved) {
      progress.completed = saved.completed;
      progress.pieces = new Set(saved.pieces);
   }

   activeDownloads[infoHash] = progress;

   const swarmUrl = `http://${DOWNLOAD_CONFIG.CONTROLLER_IP}:${DOWNLOAD_CONFIG.TRACKER_PORT}/swarm/${infoHash}`;
   http.get(swarmUrl, res => {
      const buf = [];
      res.on('data', d => buf.push(d));
      res.on('end', () => {
         let swarmMap = {};
         try {
            swarmMap = JSON.parse(Buffer.concat(buf));
            swarmMap = removeSelfFromSwarm(swarmMap, botId);
            fs.writeFileSync(path.join(PATHS.SWARM_DIR, `${infoHash}.json`), JSON.stringify(swarmMap, null, 2));
         } catch { }
         downloadPieces(infoHash, payload, swarmMap, getPeers(), outDir, progress);
      });
   }).on('error', () => {
      console.error(`⚠️ Failed to fetch swarm for ${infoHash}`);
      downloadPieces(infoHash, payload, {}, getPeers(), outDir, progress);
   });
}

function download(torrent, hash, client) {
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
   download,
   announceHave,
   getDownloadStatus,
};
