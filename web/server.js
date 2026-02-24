const express = require("express");
const path = require("path");
const state = require("../state");

app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.listen(6565, () => {
    console.log("HTTP API listening on port 6565");
});

module.exports = app;