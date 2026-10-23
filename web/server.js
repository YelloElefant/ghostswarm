const express = require("express");
const path = require("path");
const fs = require("fs");
const { pipeline } = require("stream/promises");
const state = require("../state");

const crypto = require("crypto");
const tor = require("../tor/tor");

const DATA_DIR = tor.DATA_DIR;

class SERVER {
    constructor(port, state, gstp) {

        this.port = port;
        this.gstp = gstp;
        this.state = state;
        this.app = express();
        this.app.use(express.json());
        this.app.use(express.static(path.join(__dirname, "public")));

        this.app.get("/api/status", (req, res) => {
            const snap = this.state.getStatus();
            const peers = this.state.getAllPeers();
            res.json({ snap, peers, id: state.botId });
        });


        this.app.get("/api/uploads", async (req, res) => {
            try {
                res.json({ files: await tor.listTorrents() });
            } catch (err) {
                res.status(500).json({ error: "could not read uploads" });
            }
        });

        this.app.post("/api/upload", async (req, res) => {
            const name = path.basename(String(req.query.name || "")).replace(/[\x00-\x1f]/g, "");
            if (!name || name === "." || name === "..") {
                return res.status(400).json({ error: "invalid file name" });
            }

            await fs.promises.mkdir(DATA_DIR, { recursive: true });
            const tmpPath = path.join(DATA_DIR, `.upload-${crypto.randomBytes(8).toString("hex")}`);

            // Streamed to a temp file, then hashed and renamed to data/<hash> with its .gs torrent
            try {
                await pipeline(req, fs.createWriteStream(tmpPath, { flags: "wx" }));
                const { hash, duplicate, torrent } = await tor.storeFile(tmpPath, name);
                res.json({ ok: true, name, hash, duplicate, bytes: torrent.info.size });
            } catch (err) {
                fs.promises.unlink(tmpPath).catch(() => { });
                if (!res.headersSent) res.status(500).json({ error: "upload failed" });
            }
        });

        this.app.get("/api/torrents", async (req, res) => {
            try {
                res.json({ torrents: await tor.listTorrents() });
            } catch (err) {
                res.status(500).json({ error: "could not read torrents" });
            }
        });

        // Deleting either side removes the file and its torrent together
        const removeStored = async (req, res) => {
            try {
                await tor.deleteTorrent(String(req.query.hash || ""));
                res.json({ ok: true });
            } catch (err) {
                const status = err.code === "EINVAL" ? 400 : err.code === "ENOENT" ? 404 : 500;
                res.status(status).json({ error: "could not delete" });
            }
        };
        this.app.delete("/api/uploads", removeStored);
        this.app.delete("/api/torrents", removeStored);

        this.app.post("/api/peer-torrents", async (req, res) => {
            const conn = this.state.getConnection(req.body && req.body.to ? req.body.to : "");
            if (!conn) return res.status(400).json({ error: "peer not found" });

            const packet = this.gstp.mkLIST();
            let timeoutHandle = null;
            const p = new Promise((resolve) => {
                timeoutHandle = setTimeout(() => {
                    if (this.state.getPending(packet.id)) {
                        this.state.removePending(packet.id);
                        resolve({ timeout: true });
                    }
                }, 3000);
                this.state.addPending(packet.id, { resolve, timeoutHandle });
            });

            this.state.markSeen(packet.id);
            conn.send(packet);

            const reply = await p;
            if (reply.timeout) return res.status(504).json({ error: "No response" });
            res.json({ ok: true, torrents: reply.body && reply.body.torrents || [] });
        });

        this.app.post("/api/peer-status", async (req, res) => {
            const to = req.body && req.body.to ? req.body.to : "";
            const conn = this.state.getConnection(to);
            if (!conn) {
                return res.status(400).json({ error: "peer not found" });
            }

            const packet = this.gstp.mkSTATUS();

            let timeoutHandle = null;
            const p = new Promise((resolve) => {
                timeoutHandle = setTimeout(() => {
                    if (this.state.getPending(packet.id)) {
                        this.state.removePending(packet.id);
                        resolve({ timeout: true, error: "No response" });
                    }
                }, 3000);
                this.state.addPending(packet.id, { resolve, timeoutHandle });
            });

            this.state.markSeen(packet.id);
            conn.send(packet);

            const reply = await p;
            if (reply.timeout) {
                return res.status(504).json({ error: reply.error });
            }
            res.json({ ok: true, status: reply.body ? reply.body.status : null });
        });

        this.app.post("/api/dm", async (req, res) => {
            const to = req.body && req.body.to ? req.body.to : "";
            const msg = req.body && req.body.msg ? req.body.msg : "";
            const timeoutMs = 3000;

            const conn = this.state.getConnection(to);
            if (!conn) {
                return res.status(400).json({ error: "peer not found" });
            }

            const packet = this.gstp.mkDM(to, "message", { text: msg }, 8);

            let timeoutHandle = null;
            const p = new Promise((resolve) => {
                timeoutHandle = setTimeout(() => {
                    if (this.state.getPending(packet.id)) {
                        this.state.removePending(packet.id);
                        console.log("DM timed out:", packet.id);
                        resolve({ timeout: true, error: "No response" });
                    }
                }, timeoutMs);

                this.state.addPending(packet.id, { resolve, timeoutHandle });
            });

            this.state.markSeen(packet.id);
            conn.send(packet);
            console.log("Sent DM to", to, "with id", packet.id);

            const reply = await p;
            res.json({ ok: true, reply });
        });


        this.app.listen(this.port, () => {
            console.log(`HTTP API listening on port ${this.port}`);
        });

    }
}

module.exports = SERVER;