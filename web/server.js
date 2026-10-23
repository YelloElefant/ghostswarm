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

        this.app.get("/api/status", async (req, res) => {
            const self = await this.state.getFullStatus();
            const peers = this.state.getAllPeers();
            const statuses = Object.fromEntries(this.state.peerStatus);
            res.json({ snap: self, self, peers, statuses, id: state.botId });
        });

        // Messages since a sequence number; without one it only reports the latest sequence
        this.app.get("/api/messages", (req, res) => {
            const since = parseInt(req.query.since, 10);
            const messages = Number.isNaN(since) ? [] : this.state.getMessagesSince(since);
            res.json({ seq: this.state.messageSeq, messages });
        });

        this.app.post("/api/broadcast", (req, res) => {
            const text = String(req.body && req.body.msg || "").trim();
            if (!text) return res.status(400).json({ error: "message is empty" });

            const packet = this.gstp.mkBROADCAST("chat", { text });
            this.state.markSeen(packet.id);
            for (const c of this.state.connections.values()) c.send(packet);
            this.state.addMessage({ kind: "broadcast", from: this.state.botId, to: null, topic: "chat", text, mine: true });
            res.json({ ok: true });
        });


        this.app.get("/api/uploads", async (req, res) => {
            try {
                const files = await tor.listTorrents();
                for (const f of files) f.swarm = await this.state.swarm.info(f.hash);
                res.json({ files });
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
                if (!duplicate) {
                    await this.state.swarm.refresh(hash);
                    const packet = this.gstp.mkTORRENT(torrent);
                    this.state.markSeen(packet.id);
                    for (const conn of this.state.connections.values()) conn.send(packet);
                }
                // Optionally tell every bot to start downloading it straight away
                if (req.query.download === "1") await this.state.swarm.setEnabled(hash, true);
                res.json({ ok: true, name, hash, duplicate, bytes: torrent.info.size });
            } catch (err) {
                fs.promises.unlink(tmpPath).catch(() => { });
                if (!res.headersSent) res.status(500).json({ error: "upload failed" });
            }
        });

        // Sends the stored file or its .gs torrent under the original name
        const sendStored = (torrentOnly) => async (req, res) => {
            const hash = String(req.query.hash || "");
            if (!tor.HASH_RE.test(hash)) return res.status(400).json({ error: "invalid hash" });
            try {
                const t = await tor.readTorrentFile(path.join(tor.TORRENT_DIR, hash + tor.TORRENT_EXT));
                if (torrentOnly) {
                    return res.download(path.join(tor.TORRENT_DIR, hash + tor.TORRENT_EXT), t.info.name + tor.TORRENT_EXT);
                }
                res.download(path.join(DATA_DIR, hash), t.info.name, (err) => {
                    if (err && !res.headersSent) res.status(404).json({ error: "file not stored on this bot" });
                });
            } catch (err) {
                res.status(404).json({ error: "not found" });
            }
        };
        this.app.get("/api/download", sendStored(false));
        this.app.get("/api/download-torrent", sendStored(true));

        // Removes the file and its torrent from this bot and every other bot
        const removeStored = async (req, res) => {
            try {
                const hash = String(req.query.hash || "");
                if (!/^[0-9a-f]{64}$/.test(hash)) return res.status(400).json({ error: "invalid hash" });
                const found = await this.state.swarm.remove(hash);
                if (!found) return res.status(404).json({ error: "not found" });
                res.json({ ok: true });
            } catch (err) {
                const status = err.code === "EINVAL" ? 400 : err.code === "ENOENT" ? 404 : 500;
                res.status(status).json({ error: "could not delete" });
            }
        };
        this.app.delete("/api/uploads", removeStored);

        // Turns downloading on or off for this torrent on every bot
        this.app.post("/api/swarm", async (req, res) => {
            const hash = String(req.query.hash || "");
            const ok = await this.state.swarm.setEnabled(hash, req.query.on === "1");
            res.status(ok ? 200 : 404).json(ok ? { ok: true } : { error: "unknown torrent" });
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

            const packet = this.gstp.mkDM(to, { text: msg });

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

            this.state.addMessage({ kind: "dm", from: this.state.botId, to, text: msg, mine: true });

            const reply = await p;
            res.json({ ok: true, delivered: !reply.timeout });
        });


        this.app.listen(this.port, () => {
            console.log(`HTTP API listening on port ${this.port}`);
        });

    }
}

module.exports = SERVER;