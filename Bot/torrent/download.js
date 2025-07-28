// Bot/download.js
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');

const config = require("../config.js");
const PATHS = config.PATHS;
const DOWNLOAD_CONFIG = config.DOWNLOAD_CONFIG;

let botId;
try {
   botId = fs.readFileSync(PATHS.HOST_HOSTNAME, "utf8").trim();
} catch {
   botId = require("os").hostname(); // fallback
}

let mqtt;

function handleTorrentDownload(infoHash, payload) {
   const torrentPath = path.join(PATHS.TORRENTS_DIR, `${infoHash}${PATHS.TORRENT_EXTENSION}`);
   fs.mkdirSync(path.dirname(torrentPath), { recursive: true });
   fs.writeFileSync(torrentPath, JSON.stringify(payload, null, 2));

   const outDir = path.join(PATHS.PIECES_DIR, infoHash);
   fs.mkdirSync(outDir, { recursive: true });


   // Track download progress
   const downloadProgress = {
      total: payload.pieces.length,
      completed: 0,
      pieces: new Set()
   };


   // initialize swarm map 
   let swarmMap = {};
   for (let i = 0; i < downloadProgress.total; i++) {
      swarmMap[i] = [];
   }

   // get swarm map from tracker
   const swarmUrl = `http://${DOWNLOAD_CONFIG.CONTROLLER_IP}:${DOWNLOAD_CONFIG.TRACKER_PORT}/swarm/${infoHash}`;
   http.get(swarmUrl, res => {
      if (res.statusCode !== 200) {
         console.error(`❌ Failed to fetch swarm map for ${infoHash}: ${res.statusCode} `);
         return;
      }

      // save response to file
      let data = '';



      let dest = path.join(PATHS.SWARM_DIR, `${infoHash}.json`);




      fs.mkdirSync(PATHS.SWARM_DIR, { recursive: true });
      console.log(`📥 Fetching swarm map for ${infoHash} for ${infoHash}`);

      res.on('data', chunk => data += chunk);
      res.on('end', () => {
         try {
            const json = JSON.parse(data);



            // check if my botId is in the swarm map
            if (removeBotFromSwarmMap(json, botId)) {
               console.log(`🧠 Removed bot ${botId} from swarm map for ${infoHash}`);
            } else {
               console.log(`🧠 Bot ${botId} not found in swarm map for ${infoHash}`);
            }

            // for each piece add to swarmMap
            for (const [p, botList] of Object.entries(json)) {
               swarmMap[p] = botList; // Overwrite or set
            }


            fs.writeFileSync(dest, JSON.stringify(swarmMap, null, 2));
            console.log(`✅ JSON saved to ${dest}`);
         } catch (err) {
            console.error('❌ Failed to parse/save JSON:', err.message);
         }


         let peers = getPeers();


         // download each piece
         payload.pieces.forEach(piece => {
            const pieceIndex = piece.index;
            const pieceHash = piece.hash;

            // get list of bots that have this piece
            const botsWithPiece = swarmMap[pieceIndex] || [];
            // randomly select a bot from the list
            let pickedPeer;
            if (botsWithPiece.length === 0) {
               console.warn(`⚠️ No bots available for piece ${pieceIndex} of ${infoHash}, downloading from controller`);
               pickedPeer = { ip: DOWNLOAD_CONFIG.CONTROLLER_IP, port: DOWNLOAD_CONFIG.CONTROLLER_PORT };
            } else {
               peerid = botsWithPiece[Math.floor(Math.random() * botsWithPiece.length)];
               pickedPeer = peers.find(p => p.id === peerid);
               if (!pickedPeer) {
                  console.warn(`⚠️ No valid peer found for ID ${peerid}, downloading from controller`);
                  pickedPeer = { ip: DOWNLOAD_CONFIG.CONTROLLER_IP, port: DOWNLOAD_CONFIG.CONTROLLER_PORT };
               }
               pickedPeer[port] = 5000;
               console.log(`🔄 Requesting piece ${pieceIndex} of ${infoHash} from ${pickedPeer}`);
            }


            peers = getPeers();

            requestPiece(pickedPeer.ip, pickedPeer.port, infoHash, pieceIndex, (err, buffer) => {
               if (err) {
                  console.error(`❌ Failed to download piece ${pieceIndex} of ${infoHash}: `, err);
                  return;
               }

               const pieceFile = path.join(outDir, `${pieceIndex}.part`);
               fs.writeFileSync(pieceFile, buffer);

               // Verify hash
               const hash = crypto.createHash('sha1').update(buffer).digest('hex');
               if (hash !== pieceHash) {
                  console.log(`❌ Hash mismatch for piece ${pieceIndex} of ${infoHash}: expected ${pieceHash}, got ${hash} `);
                  return;
               }

               console.log(`✅ Successfully downloaded and verified piece ${pieceIndex} of ${infoHash} `);
               announceHave(infoHash, pieceIndex);

               // Track progress
               downloadProgress.pieces.add(pieceIndex);
               downloadProgress.completed++;

               // Check if all pieces are downloaded
               if (downloadProgress.completed === downloadProgress.total) {
                  console.log(`🎉 All pieces downloaded for ${infoHash}, combining...`);
                  combineIntorrent(infoHash, payload);
               }
            });
         });

      });
   });
}

function removeBotFromSwarmMap(swarmMap, botId) {
   let modified = false;

   for (const [pieceIndex, botList] of Object.entries(swarmMap)) {
      const updatedList = botList.filter(id => id !== botId);

      if (updatedList.length !== botList.length) {
         swarmMap[pieceIndex] = updatedList;
         modified = true;
      }

      // If the list becomes empty, you can optionally delete the entry:
      if (updatedList.length === 0) {
         delete swarmMap[pieceIndex];
      }
   }

   return modified; // returns true if any change was made
}


function combineIntorrent(infoHash, payload) {
   // Combine pieces into final file
   const piecePath = path.join(PATHS.PIECES_DIR, infoHash);
   const finalFile = path.join(PATHS.UPLOADS_DIR, payload.name);

   fs.mkdirSync(PATHS.UPLOADS_DIR, { recursive: true });

   console.log(`🔄 Starting to combine ${payload.pieces.length} pieces into ${finalFile}`);

   const writeStream = fs.createWriteStream(finalFile);
   let errorOccurred = false;

   writeStream.on('error', err => {
      console.error(`❌ Failed to write final file ${finalFile}: `, err);
      errorOccurred = true;
   });

   writeStream.on('finish', () => {
      if (!errorOccurred) {
         console.log(`📦 Successfully combined pieces into ${finalFile}`);

         // Verify final file size
         const stats = fs.statSync(finalFile);
         console.log(`📊 Final file size: ${stats.size} bytes(expected: ${payload.size} bytes)`);

         if (stats.size === payload.size) {
            console.log(`✅ File size matches expected size!`);
         } else {
            console.warn(`⚠️ File size mismatch! Expected ${payload.size}, got ${stats.size}`);
         }
      }
   });

   // Write pieces in order
   (async () => {
      try {
         let totalWritten = 0;

         for (let i = 0; i < payload.pieces.length; i++) {
            const partPath = path.join(piecePath, `${i}.part`);

            if (!fs.existsSync(partPath)) {
               console.error(`❌ Missing piece ${i}, aborting combine`);
               writeStream.destroy();
               fs.existsSync(finalFile) && fs.unlinkSync(finalFile);
               throw new Error(`Piece ${i} missing`);
            }

            const buffer = fs.readFileSync(partPath);
            writeStream.write(buffer);
            totalWritten += buffer.length;
            console.log(`🧩 Appended piece ${i}(${buffer.length} bytes, total: ${totalWritten})`);
         }

         writeStream.end();
         console.log(`✅ All pieces written, total: ${totalWritten} bytes`);
      } catch (err) {
         console.error(`❌ Failed during combination: `, err.message);
      }
   })();
}

function requestPiece(ip, port, infoHash, pieceIndex, cb) {
   const options = {
      hostname: ip,
      port: port,
      path: `/piece/${infoHash}/${pieceIndex}`,
      method: 'GET'
   };

   const req = http.request(options, res => {
      if (res.statusCode !== 200) return cb(res.statusMessage);

      const data = [];
      res.on('data', chunk => data.push(chunk));
      res.on('end', () => {
         const buffer = Buffer.concat(data);
         cb(null, buffer);
      });
   });

   req.on('error', cb);
   req.end();
}

function announceHave(infoHash, index) {
   const topic = `ghostswarm/torrent/have/${botId}`;
   const msg = { infoHash, pieceIndex: index };
   mqtt.publish(topic, JSON.stringify(msg), { qos: 1 });
   console.log(`📢 HAVE announced: ${infoHash} - piece ${index}`);
}



async function download(torrent, hash, client) {
   const infoHash = hash;

   mqtt = client;
   handleTorrentDownload(infoHash, torrent);
}

function getPeers() {
   try {
      const data = fs.readFileSync(PATHS.PEER_FILE, 'utf8');
      return JSON.parse(data);
   } catch (err) {
      console.error(`❌ Failed to read/parse peer file: `, err);
      return [];
   }
}

module.exports = {
   handleTorrentDownload,
   announceHave,
   download,
   requestPiece
};
