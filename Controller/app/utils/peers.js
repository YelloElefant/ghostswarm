const { getBots } = require('./utils');

function advertisePeers(redis, mqttClient) {
   console.log('Starting peer advertisement...');

   const publishPeers = () => {
      getBots(redis).then((bots) => {
         if (bots.length === 0) {
            console.log('No online bots found');
            return;
         }

         const peers = bots.map(bot => ({
            id: bot.id,
            ip: bot.ip,
            alive: bot.alive,
            lastSeen: bot.lastSeen
         }));

         mqttClient.publish('ghostswarm/peers', JSON.stringify(peers), { qos: 1 });
      }).catch(err => {
         console.error('Error fetching bots:', err);
      });
   };

   // Run once immediately
   publishPeers();

   // Then run every 60 seconds
   setInterval(publishPeers, 60000);
}

module.exports = { advertisePeers };