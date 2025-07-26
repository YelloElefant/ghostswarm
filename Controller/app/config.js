module.exports = {
   mqtt: {
      brokerUrl: process.env.MQTT_BROKER_URL,
      topicPrefix: "ghostswarm"
   },
   redis: {
      host: "localhost",
      port: 6379
   },
   UPLOADS_DIR: "/data/uploads",
   PIECES_DIR: "/data/pieces",
   TORRENTS_DIR: "/data/torrents",
   SWARM_DIR: "/data/swarm",
   TORRENT_EXTENSION: ".ghostswarm",
   PORT: 2319
};