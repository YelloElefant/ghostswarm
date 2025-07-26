const config = require('../config');
const fs = require('fs');




function deleteTorrent(hash, mqtt) {
   // delete torrent from /data/torrents and the uploaded file and the pieces dir and the swarm json
   const torrentFile = `${config.TORRENT_DIR}/${hash}${config.TORRENT_EXTENSION}`;
   const uploadsDir = `${config.PATHS.UPLOADS_DIR}/${hash}`;
   const piecesDir = `${config.PATHS.PIECES_DIR}/${hash}`;
   const swarmFile = `${config.PATHS.SWARM_DIR}/${hash}.json`;

   // delete the files and directories
   fs.unlinkSync(torrentFile);
   fs.rmdirSync(uploadsDir, { recursive: true });
   fs.rmdirSync(piecesDir, { recursive: true });
   fs.unlinkSync(swarmFile);
   console.log(`🗑️ Deleted torrent and associated files for ${hash}`);

   // Notify the controller via MQTT
   const statusTopic = `ghostswarm/${config.mqtt.botId}/torrent/delete/${hash}`;

   mqtt.publish(statusTopic, JSON.stringify({
      status: "deleted",
      infoHash: hash,
      time: Date.now()
   }));
   console.log(`📤 [${config.mqtt.botId}] sent delete notification for ${hash}`);

}


module.exports = {
   deleteTorrent
};