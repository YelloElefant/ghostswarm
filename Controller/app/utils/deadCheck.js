function startDeadCheck(swarmMap) {
   setInterval(() => {
      const now = Date.now();
      swarmMap.forEach((status, botId) => {
         if (status.lastSeen && now - status.lastSeen > 60000) { // 1 minute timeout
            console.log(`🕒 Bot ${botId} is dead`);
            status.status = 'dead';
            status.lastSeen = now;
            swarmMap.set(botId, status);
            // Also update Redis
            redis.set(`status:${botId}`, JSON.stringify({
               status: 'dead',
               lastSeen: now,
            }));
         }
      });
   }, 15500);
}


module.exports = {
   startDeadCheck,
};
