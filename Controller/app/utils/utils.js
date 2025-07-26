const { exec } = require('child_process');

function getBots(redis) {
   return new Promise((resolve) => {
      exec('tailscale status --json', (err, stdout) => {
         if (err) {
            console.error('❌ Tailscale status error:', err);
            return resolve([]);
         }

         try {
            const data = JSON.parse(stdout);
            const peers = data.Peer || {};
            const online = Object.entries(peers)
               .filter(([_, p]) => p.Online)
               .map(([_, p]) => {
                  const botId = p.HostName;
                  const status = redis.get(`status:${botId}`) || { status: 'unknown', lastSeen: Date.now() };

                  return {
                     id: botId,
                     ip: p.TailscaleIPs[0],
                     alive: status.status === "alive",
                     lastSeen: status.lastSeen ? new Date(status.lastSeen).toLocaleString() : 'unknown',
                  };
               });

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