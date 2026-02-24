const express = require("express");
const path = require("path");
const state = require("../state");

class SERVER {
    constructor(port, state, gstp) {

        this.port = port;
        this.gstp = gstp;
        this.state = state;
        this.app = express();
        this.app.use(express.json());
        this.app.use(express.static(path.join(__dirname, "public")));
        
        
        this.app.post("/api/dm", async (req, res) => {
            const to = req.body && req.body.to ? req.body.to : "";
            const msg = req.body && req.body.msg ? req.body.msg : "";
            
            const p = new Promise((resolve) => {
                this.state.addPending(msg.id, { resolve });
                
                const timeout = setTimeout(() => {
                    if (this.state.getPending(msg.id)) {
                        this.state.removePending(msg.id);
                        resolve({ timeout: true });
                    }
                    this.state.decrementInflight(rid, 1);
                }, timeoutMs);
            });

            const reply = await p;
            res.json({ ok: true, reply });
        });
        
        
        this.app.listen(this.port, () => {
            console.log(`HTTP API listening on port ${this.port}`);
        });

    }
}

module.exports = SERVER;