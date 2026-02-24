const crypto = require("crypto");

module.exports = {
    BOT_ID: process.env.BOT_ID || "bot_" + crypto.randomBytes(3).toString("hex"),
    TCP_PORT: parseInt(process.env.TCP_PORT || "5001", 10),
    HTTP_PORT: parseInt(process.env.HTTP_PORT || "6565", 10),
    MAX_PEERS: parseInt(process.env.MAX_PEERS || "4", 10),
    SEED_PEERS: (process.env.SEED_PEERS || "").split(",").filter(Boolean),
    ADMIN_TOKEN: process.env.ADMIN_TOKEN || "",
    MY_HOST: process.env.MY_HOST || "127.0.0.1"
}