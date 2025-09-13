const config = require('../config');
const fs = require('fs');




function deleteTorrent(hash, mqtt) {
   // delete torrent from /data/torrents and the uploaded file and the pieces dir and the swarm json
   const torrentFile = `${config.PATHS.TORRENTS_DIR}/${hash}${config.PATHS.TORRENT_EXTENSION}`;
   const uploadsDir = `${config.PATHS.UPLOADS_DIR}/`;
   const swarmFile = `${config.PATHS.SWARM_DIR}/${hash}.json`;

   // Read the torrent file to get metadata
   let torrentData;
   if (fs.existsSync(torrentFile)) {
      torrentData = JSON.parse(fs.readFileSync(torrentFile, 'utf8'));
      console.log(`📥 Deleting torrent: ${torrentData.name} (${hash})`);
   }

   // delete the files and directories
   fs.rmSync(torrentFile);
   fs.rmSync(uploadsDir + torrentData.name, { recursive: true });
   try {
      fs.rmSync(swarmFile);
   } catch (err) {
      console.warn(`⚠️ Could not delete swarm file ${swarmFile}:`, err.message);
   }
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