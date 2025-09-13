const { exec } = require('child_process');
const config = require('../config.js');
const botId = config.mqtt.botId;


function executeShellCommand(payload, mqttClient) {
   exec(payload.cmd, (err, stdout, stderr) => {
      const statusTopic = config.mqtt.topics.status;
      mqttClient.publish(statusTopic, JSON.stringify({
         requestId: payload.requestId,
         output: err ? stderr || 'Command failed' : stdout.trim(),
         status: err ? 'error' : 'ok',
         time: Date.now()
      }));
      console.log(`📤 [${botId}] shell command executed and responded`);
   });



}

module.exports = {
   executeShellCommand
};