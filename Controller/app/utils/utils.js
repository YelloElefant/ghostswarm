const { exec } = require('child_process');

async function getBots(redis) {
   return new Promise((resolve) => {
      exec('tailscale status --json', async (err, stdout) => {
         if (err) {
            console.error('❌ Tailscale status error:', err);
            return resolve([]);
         }

         try {
            const data = JSON.parse(stdout);
            const peers = data.Peer || {};
            const onlinePeers = Object.entries(peers).filter(([_, p]) => p.Online);

            // Use Promise.all to handle async operations properly
            const online = await Promise.all(
               onlinePeers.map(async ([_, p]) => {
                  const botId = p.HostName;
                  let status = { status: 'dead', lastSeen: Date.now() };

                  try {
                     const redisData = await redis.get(`status:${botId}`);
                     if (redisData) {
                        status = JSON.parse(redisData);
                     }
                  } catch (e) {
                     console.warn(`⚠️ Failed to get status for ${botId}:`, e.message);
                  }

                  console.log(`Bot ${botId} status:`, status);

                  return {
                     id: botId,
                     ip: p.TailscaleIPs[0],
                     alive: status.status === "alive",
                     lastSeen: status.lastSeen ? new Date(status.lastSeen).toLocaleString() : 'unknown',
                  };
               })
            );

            resolve(online);
         } catch (e) {
            console.error('❌ Parse error:', e);
            resolve([]);
         }
      });
   });
}

module.exports = {
   getBots
};