const express = require("express");
const { startMQTT } = require("./mqtt/client");
const { startWebSocket } = require("./ws/server");
const routes = require("./routes");
const config = require("./config");

const app = express();
app.use(express.json());
app.use("/", routes);

startMQTT();
startWebSocket();

app.listen(config.port, () => {
   console.log(`🎛️ Controller live on http://localhost:${config.port}`);
});
