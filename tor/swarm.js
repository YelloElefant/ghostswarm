const fs = require("fs");
const path = require("path");
const tor = require("./tor");

const MAX_INFLIGHT = 8; // requests in flight per torrent
const MAX_PER_PEER = 3;
const REQUEST_TIMEOUT = 10000;
const TICK_MS = 1000;

// Bit i of the bitfield is chunk i (LSB first within each byte), sent as hex
function encodeBitfield(have, total) {
    const bytes = Buffer.alloc(Math.ceil(total / 8));
    for (const i of have) if (i < total) bytes[i >> 3] |= 1 << (i & 7);
    return bytes.toString("hex");
}

function decodeBitfield(hex, total) {
    const have = new Set();
    if (typeof hex !== "string" || !/^[a-f0-9]*$/.test(hex)) return have;
    const bytes = Buffer.from(hex, "hex");
    for (let i = 0; i < total && (i >> 3) < bytes.length; i++) {
        if (bytes[i >> 3] & (1 << (i & 7))) have.add(i);
    }
    return have;
}

/**
 * Tracks which chunks we hold for each torrent, which chunks each connected peer holds,
 * and requests missing chunks from peers while a torrent's download is switched on.
 *
 * Per torrent hash (entries):  { torrent, have:Set, enabled, complete }
 * Per peer (peerHave):         hash -> Map(peerId -> Set of chunk indexes)
 * Persisted per torrent:       <dataDir>/swarm/<hash>.json = { enabled, have:bitfield }
 * Partial download:            <dataDir>/parts/<hash>.part (final file is <dataDir>/<hash>)
 * Peer availability is not persisted; peers re-announce with HAVE on connect.
 */
class Swarm {
    constructor(state, gstp, dataDir = tor.DATA_DIR) {
        this.state = state;
        this.gstp = gstp;
        this.dataDir = dataDir;
        this.torrentDir = path.join(dataDir, "torrents");
        this.partDir = path.join(dataDir, "parts");
        this.metaDir = path.join(dataDir, "swarm");
        this.deletedDir = path.join(dataDir, "deleted");

        this.entries = new Map();
        this.loading = new Map();
        this.peerHave = new Map();
        this.chain = Promise.resolve();
        this.requests = new Map(); // request id -> { hash, index, peer, timer }

        this.timer = setInterval(() => this.tick().catch(() => { }), TICK_MS);
        this.timer.unref();

        state.onConnect = (id, conn) => this.announceAll(conn).catch(() => { });
    }

    stop() {
        clearInterval(this.timer);
        for (const r of this.requests.values()) clearTimeout(r.timer);
        this.requests.clear();
    }

    filePath(hash) { return path.join(this.dataDir, hash); }
    partPath(hash) { return path.join(this.partDir, hash + ".part"); }
    metaPath(hash) { return path.join(this.metaDir, hash + ".json"); }

    // Loads a torrent's entry from disk the first time it is needed
    ensure(hash) {
        if (!tor.HASH_RE.test(hash)) return Promise.resolve(null);
        if (this.entries.has(hash)) return Promise.resolve(this.entries.get(hash));
        if (!this.loading.has(hash)) {
            this.loading.set(hash, this.load(hash).finally(() => this.loading.delete(hash)));
        }
        return this.loading.get(hash);
    }

    async load(hash) {
        let torrent;
        try {
            torrent = await tor.readTorrentFile(path.join(this.torrentDir, hash + tor.TORRENT_EXT));
        } catch (e) {
            return null;
        }
        const total = torrent.info.chunks.length;
        const entry = { torrent, have: new Set(), enabled: false, complete: false };

        const exists = (p) => fs.promises.access(p).then(() => true, () => false);
        if (await exists(this.filePath(hash))) {
            entry.complete = true;
            for (let i = 0; i < total; i++) entry.have.add(i);
        }

        try {
            const meta = JSON.parse(await fs.promises.readFile(this.metaPath(hash), "utf8"));
            entry.enabled = !!meta.enabled;
            if (!entry.complete && await exists(this.partPath(hash))) {
                entry.have = decodeBitfield(meta.have, total);
            }
        } catch (e) { /* no saved state yet */ }

        if (!this.entries.has(hash)) this.entries.set(hash, entry);
        return this.entries.get(hash);
    }

    async persist(hash) {
        const e = this.entries.get(hash);
        if (!e) return;
        await fs.promises.mkdir(this.metaDir, { recursive: true });
        await fs.promises.writeFile(this.metaPath(hash), JSON.stringify({
            enabled: e.enabled,
            have: encodeBitfield(e.have, e.torrent.info.chunks.length)
        }));
    }

    // Called after a file is stored locally or a torrent arrives so it is picked up straight away
    async refresh(hash) {
        this.entries.delete(hash);
        return this.ensure(hash);
    }

    async forget(hash) {
        const e = this.entries.get(hash);
        if (e) e.enabled = false;
        for (const [id, r] of this.requests) {
            if (r.hash === hash) { clearTimeout(r.timer); this.requests.delete(id); }
        }
        this.entries.delete(hash);
        this.peerHave.delete(hash);
        await Promise.all([this.partPath(hash), this.metaPath(hash)].map((p) => fs.promises.unlink(p).catch(() => { })));
    }

    // Counts for the status heartbeat: torrents known, fully held, and downloading
    async summary() {
        const out = { total: 0, complete: 0, downloading: 0 };
        let files;
        try { files = await fs.promises.readdir(this.torrentDir); } catch (e) { return out; }
        for (const f of files) {
            const hash = f.slice(0, -tor.TORRENT_EXT.length);
            if (!f.endsWith(tor.TORRENT_EXT) || !tor.HASH_RE.test(hash)) continue;
            const e = await this.ensure(hash);
            if (!e) continue;
            out.total++;
            if (e.complete) out.complete++;
            else if (e.enabled) out.downloading++;
        }
        return out;
    }

    // Local view of a torrent for the dashboard
    async info(hash) {
        const e = await this.ensure(hash);
        if (!e) return null;
        const total = e.torrent.info.chunks.length;
        let peers = 0, seeds = 0;
        const map = this.peerHave.get(hash);
        if (map) {
            for (const [id, set] of map) {
                if (!this.state.connections.has(id)) continue;
                if (set.size > 0) peers++;
                if (set.size >= total && total > 0) seeds++;
            }
        }
        return { enabled: e.enabled, complete: e.complete, have: e.have.size, total, peers, seeds };
    }

    // Packets this class owns; returns true if the packet was handled
    handle(msg, conn) {
        const T = this.gstp.T;
        const work = {
            [T.TORRENT]: () => this.onTorrent(msg, conn),
            [T.SWARM]: () => this.onSwarm(msg, conn),
            [T.HAVE]: () => this.onHave(msg, conn),
            [T.DEL]: () => this.onDel(msg, conn),
            [T.GET]: () => this.onGet(msg, conn),
            [T.TEG]: () => this.onTeg(msg, conn)
        }[msg && msg.t];
        if (!work) return false;
        // Torrent, swarm and have packets run in order so a SWARM never overtakes the TORRENT it refers to
        if (msg.t === T.TORRENT || msg.t === T.SWARM || msg.t === T.HAVE || msg.t === T.DEL) {
            this.chain = this.chain.then(work).catch(() => { });
        } else {
            Promise.resolve().then(work).catch(() => { });
        }
        return true;
    }

    flood(msg, exceptId) {
        if (!(msg.ttl > 1)) return;
        const fwd = Object.assign({}, msg, { ttl: msg.ttl - 1 });
        for (const [id, c] of this.state.connections) {
            if (id !== exceptId) c.send(fwd);
        }
    }

    // First sight only: dedupes flooded packets
    firstSight(msg) {
        if (this.state.hasSeen(msg.id)) return false;
        this.state.markSeen(msg.id);
        return true;
    }

    async onTorrent(msg, conn) {
        if (!this.firstSight(msg)) return;
        const t = msg.body && msg.body.torrent;
        const hash = t && t.info && t.info.hash;
        if (typeof hash === "string" && tor.HASH_RE.test(hash)) {
            // A resync must not bring back something deleted here; a fresh upload does
            if (msg.body.sync) { if (await this.isDeleted(hash)) return; }
            else await this.untomb(hash);
        }
        if (await tor.saveTorrent(t, this.torrentDir)) await this.refresh(t.info.hash);
        this.flood(msg, conn.remoteId);
    }

    // Switches downloading on or off for a torrent and optionally tells every other bot
    async setEnabled(hash, on, propagate = true) {
        const e = await this.ensure(hash);
        if (!e) return false;
        e.enabled = !!on;
        await this.persist(hash);

        if (!on) {
            for (const [id, r] of this.requests) {
                if (r.hash === hash) { clearTimeout(r.timer); this.requests.delete(id); }
            }
        } else {
            this.announceHash(hash);
        }

        if (propagate) {
            const packet = this.gstp.mkSWARM(hash, !!on);
            this.state.markSeen(packet.id);
            for (const c of this.state.connections.values()) c.send(packet);
        }
        return true;
    }

    // Deleted hashes are remembered so a bot that was offline learns about the deletion
    tombPath(hash) { return path.join(this.deletedDir, hash); }
    isDeleted(hash) { return fs.promises.access(this.tombPath(hash)).then(() => true, () => false); }
    untomb(hash) { return fs.promises.unlink(this.tombPath(hash)).catch(() => { }); }

    // Removes a torrent and its file from this bot, optionally telling every other bot
    async remove(hash, propagate = true) {
        await this.forget(hash);
        await fs.promises.mkdir(this.deletedDir, { recursive: true });
        await fs.promises.writeFile(this.tombPath(hash), "");
        let err = null;
        try { await tor.deleteTorrent(hash); } catch (e) { err = e; }
        if (propagate) {
            const packet = this.gstp.mkDEL(hash);
            this.state.markSeen(packet.id);
            for (const c of this.state.connections.values()) c.send(packet);
        }
        if (err && err.code !== "ENOENT") throw err;
        return !err;
    }

    async onDel(msg, conn) {
        if (!this.firstSight(msg)) return;
        const hash = msg.body && msg.body.hash;
        if (typeof hash === "string" && /^[0-9a-f]{64}$/.test(hash)) await this.remove(hash, false).catch(() => { });
        this.flood(msg, conn.remoteId);
    }

    async onSwarm(msg, conn) {
        if (!this.firstSight(msg)) return;
        const b = msg.body || {};
        if (typeof b.hash === "string") await this.setEnabled(b.hash, b.on === true, false);
        this.flood(msg, conn.remoteId);
    }

    bitfieldFor(hash) {
        const e = this.entries.get(hash);
        return e && e.have.size > 0 ? encodeBitfield(e.have, e.torrent.info.chunks.length) : null;
    }

    // Brings a (re)connected peer up to date: deletions, torrents, download switches and our chunks.
    // Sent to that peer only (ttl 1); the peer does the same for us when it sees our connection.
    async announceAll(conn) {
        const direct = (p) => Object.assign(p, { ttl: 1 });
        let tombs = [];
        try { tombs = await fs.promises.readdir(this.deletedDir); } catch (e) { /* none */ }
        for (const h of tombs) if (tor.HASH_RE.test(h)) conn.send(direct(this.gstp.mkDEL(h)));

        let files;
        try { files = await fs.promises.readdir(this.torrentDir); } catch (e) { return; }
        for (const f of files) {
            if (!f.endsWith(tor.TORRENT_EXT)) continue;
            const hash = f.slice(0, -tor.TORRENT_EXT.length);
            const e = await this.ensure(hash);
            if (!e) continue;
            const t = this.gstp.mkTORRENT(e.torrent);
            t.body.sync = true;
            conn.send(direct(t));
            if (e.enabled) conn.send(direct(this.gstp.mkSWARM(hash, true)));
            const bits = this.bitfieldFor(hash);
            if (bits) conn.send(this.gstp.mkHAVE(hash, bits));
        }
    }

    announceHash(hash) {
        const bits = this.bitfieldFor(hash);
        if (!bits) return;
        const packet = this.gstp.mkHAVE(hash, bits);
        for (const c of this.state.connections.values()) c.send(packet);
    }

    async onHave(msg, conn) {
        const b = msg.body || {};
        const e = await this.ensure(b.hash);
        if (!e || !conn.remoteId) return;
        if (!this.peerHave.has(b.hash)) this.peerHave.set(b.hash, new Map());
        this.peerHave.get(b.hash).set(conn.remoteId, decodeBitfield(b.have, e.torrent.info.chunks.length));
    }

    async onGet(msg, conn) {
        const b = msg.body || {};
        const e = await this.ensure(b.hash);
        let data = null;
        if (e && Number.isInteger(b.index) && e.have.has(b.index)) {
            try {
                const file = e.complete ? this.filePath(b.hash) : this.partPath(b.hash);
                const buf = await tor.readChunk(file, b.index, e.torrent.info.chunkSize);
                data = buf.toString("base64");
            } catch (err) { /* reply with no data */ }
        }
        conn.send(this.gstp.mkTEG(msg.id, { hash: b.hash, index: b.index, data }));
    }

    async onTeg(msg, conn) {
        const req = this.requests.get(msg.rid);
        if (!req || req.peer !== conn.remoteId) return;
        clearTimeout(req.timer);
        this.requests.delete(msg.rid);

        const e = this.entries.get(req.hash);
        const b = msg.body || {};
        if (!e || e.complete || !e.enabled) return;

        const forgetClaim = () => {
            const set = this.peerHave.get(req.hash) && this.peerHave.get(req.hash).get(req.peer);
            if (set) set.delete(req.index);
        };

        if (typeof b.data !== "string" || b.hash !== req.hash || b.index !== req.index) return forgetClaim();

        const data = Buffer.from(b.data, "base64");
        const { size, chunkSize } = e.torrent.info;
        const expected = Math.min(chunkSize, size - req.index * chunkSize);
        if (data.length !== expected || !tor.verifyChunk(e.torrent, req.index, data)) return forgetClaim();

        await this.writeChunk(req.hash, e, req.index, data);
    }

    async writeChunk(hash, e, index, data) {
        if (e.have.has(index)) return;
        await fs.promises.mkdir(this.partDir, { recursive: true });
        const fd = await fs.promises.open(this.partPath(hash), "a");
        await fd.close();
        const rw = await fs.promises.open(this.partPath(hash), "r+");
        try {
            await rw.write(data, 0, data.length, index * e.torrent.info.chunkSize);
        } finally {
            await rw.close();
        }
        e.have.add(index);
        await this.persist(hash);

        if (e.have.size === e.torrent.info.chunks.length) await this.finish(hash, e);
        else this.announceHash(hash);
    }

    // All chunks are in: confirm the whole-file hash before promoting the part file
    async finish(hash, e) {
        if (await tor.hashFile(this.partPath(hash)) !== e.torrent.info.hash) {
            e.have.clear();
            await fs.promises.unlink(this.partPath(hash)).catch(() => { });
            await this.persist(hash);
            return;
        }
        await fs.promises.rename(this.partPath(hash), this.filePath(hash));
        e.complete = true;
        await this.persist(hash);
        this.announceHash(hash);
    }

    async tick() {
        for (const [id, r] of this.requests) {
            if (!this.state.connections.has(r.peer)) {
                clearTimeout(r.timer);
                this.requests.delete(id);
            }
        }

        for (const [hash, e] of this.entries) {
            if (!e.enabled || e.complete) continue;
            const total = e.torrent.info.chunks.length;

            if (total === 0) {
                await fs.promises.mkdir(this.dataDir, { recursive: true });
                await fs.promises.writeFile(this.filePath(hash), "");
                e.complete = true;
                await this.persist(hash);
                continue;
            }

            const peers = this.peerHave.get(hash);
            if (!peers) continue;

            const inflight = [...this.requests.values()].filter((r) => r.hash === hash);
            const pending = new Set(inflight.map((r) => r.index));
            const perPeer = new Map();
            for (const r of inflight) perPeer.set(r.peer, (perPeer.get(r.peer) || 0) + 1);

            // Rarest chunks first so scarce pieces spread before they can disappear
            const missing = [];
            for (let i = 0; i < total; i++) if (!e.have.has(i) && !pending.has(i)) missing.push(i);
            const rarity = (i) => {
                let n = 0;
                for (const set of peers.values()) if (set.has(i)) n++;
                return n;
            };
            missing.sort((a, b) => rarity(a) - rarity(b));

            let active = inflight.length;
            for (const index of missing) {
                if (active >= MAX_INFLIGHT) break;
                const candidates = [...peers].filter(([id, set]) =>
                    set.has(index) && this.state.connections.has(id) && (perPeer.get(id) || 0) < MAX_PER_PEER);
                if (!candidates.length) continue;
                candidates.sort((a, b) => (perPeer.get(a[0]) || 0) - (perPeer.get(b[0]) || 0));
                const peerId = candidates[0][0];

                const packet = this.gstp.mkGET(hash, index);
                const timer = setTimeout(() => this.requests.delete(packet.id), REQUEST_TIMEOUT);
                timer.unref();
                this.requests.set(packet.id, { hash, index, peer: peerId, timer });
                perPeer.set(peerId, (perPeer.get(peerId) || 0) + 1);
                active++;
                this.state.connections.get(peerId).send(packet);
            }
        }
    }
}

module.exports = { Swarm, encodeBitfield, decodeBitfield };
