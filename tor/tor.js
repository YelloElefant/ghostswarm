const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
const TORRENT_DIR = path.join(DATA_DIR, "torrents");

const CHUNK_SIZE = 512 * 1024; // 0.5 MB
const HASH_ALGO = "sha256";
const TORRENT_EXT = ".gs";

// Streams the file so large files never sit in memory
function hashFile(filePath, algo = HASH_ALGO) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash(algo);
        fs.createReadStream(filePath)
            .on("error", reject)
            .on("data", (data) => hash.update(data))
            .on("end", () => resolve(hash.digest("hex")));
    });
}

function hashBuffer(buf, algo = HASH_ALGO) {
    return crypto.createHash(algo).update(buf).digest("hex");
}

// Splits a file into fixed-size chunks and returns where each one lives plus its hash:
// [{ index, offset, length, hash }]. The last chunk is whatever is left over.
async function chunkFile(filePath, chunkSize = CHUNK_SIZE) {
    const fd = await fs.promises.open(filePath, "r");
    try {
        const { size } = await fd.stat();
        const chunks = [];
        const buf = Buffer.alloc(chunkSize);

        for (let offset = 0, index = 0; offset < size; offset += chunkSize, index++) {
            const { bytesRead } = await fd.read(buf, 0, chunkSize, offset);
            chunks.push({
                index,
                offset,
                length: bytesRead,
                hash: hashBuffer(buf.subarray(0, bytesRead))
            });
        }
        return chunks;
    } finally {
        await fd.close();
    }
}

// Builds the torrent metadata. infoHash identifies the torrent and is derived
// from the file hash and chunk list, so any change to the content changes it.
async function buildTorrent(filePath, chunkSize = CHUNK_SIZE, name = path.basename(filePath)) {
    const stat = await fs.promises.stat(filePath);
    const [fileHash, chunks] = await Promise.all([hashFile(filePath), chunkFile(filePath, chunkSize)]);

    const info = {
        name,
        size: stat.size,
        chunkSize,
        algo: HASH_ALGO,
        hash: fileHash,
        chunks: chunks.map((c) => c.hash)
    };

    return {
        v: 1,
        infoHash: hashBuffer(Buffer.from(JSON.stringify(info))),
        created: Date.now(),
        info
    };
}

// Writes <file>.gs next to the file (or to outPath) and returns the torrent
async function createTorrentFile(filePath, outPath, chunkSize = CHUNK_SIZE) {
    const torrent = await buildTorrent(filePath, chunkSize);
    const dest = outPath || filePath + TORRENT_EXT;
    await fs.promises.writeFile(dest, JSON.stringify(torrent, null, 2));
    return { path: dest, torrent };
}

async function readTorrentFile(torrentPath) {
    const torrent = JSON.parse(await fs.promises.readFile(torrentPath, "utf8"));
    if (!torrent || torrent.v !== 1 || !torrent.info || !Array.isArray(torrent.info.chunks)) {
        throw new Error("Invalid .gs torrent file");
    }
    return torrent;
}

// Reads one chunk's bytes from a file by index, using the torrent's chunk size
async function readChunk(filePath, index, chunkSize = CHUNK_SIZE) {
    const fd = await fs.promises.open(filePath, "r");
    try {
        const buf = Buffer.alloc(chunkSize);
        const { bytesRead } = await fd.read(buf, 0, chunkSize, index * chunkSize);
        return buf.subarray(0, bytesRead);
    } finally {
        await fd.close();
    }
}

// Checks a chunk's bytes against the hash recorded in the torrent
function verifyChunk(torrent, index, data) {
    return torrent.info.chunks[index] === hashBuffer(data, torrent.info.algo);
}

const HASH_RE = /^[a-f0-9]{64}$/;

// Files are stored as data/<fileHash> with their metadata in data/torrents/<fileHash>.gs
async function storeFile(tmpPath, originalName) {
    const torrent = await buildTorrent(tmpPath, CHUNK_SIZE, originalName);
    const hash = torrent.info.hash;
    await fs.promises.mkdir(TORRENT_DIR, { recursive: true });

    const dest = path.join(DATA_DIR, hash);
    let duplicate = false;
    try {
        await fs.promises.access(dest);
        duplicate = true;
        await fs.promises.unlink(tmpPath);
    } catch (e) {
        await fs.promises.rename(tmpPath, dest);
    }

    if (!duplicate) {
        await fs.promises.writeFile(path.join(TORRENT_DIR, hash + TORRENT_EXT), JSON.stringify(torrent, null, 2));
    }
    return { hash, duplicate, torrent };
}

// Summaries of every torrent whose file is present
async function listTorrents() {
    let entries;
    try {
        entries = await fs.promises.readdir(TORRENT_DIR);
    } catch (err) {
        if (err.code === "ENOENT") return [];
        throw err;
    }

    const out = [];
    for (const file of entries) {
        const hash = file.slice(0, -TORRENT_EXT.length);
        if (!file.endsWith(TORRENT_EXT) || !HASH_RE.test(hash)) continue;
        try {
            const t = await readTorrentFile(path.join(TORRENT_DIR, file));
            const stat = await fs.promises.stat(path.join(DATA_DIR, hash));
            out.push({
                hash,
                name: t.info.name,
                ext: path.extname(t.info.name).slice(1).toLowerCase(),
                size: stat.size,
                chunks: t.info.chunks.length,
                infoHash: t.infoHash,
                created: t.created || stat.mtimeMs
            });
        } catch (e) { /* skip torrents that are unreadable or missing their file */ }
    }
    return out.sort((a, b) => b.created - a.created);
}

// Removes the stored file and its torrent together
async function deleteTorrent(hash) {
    if (!HASH_RE.test(hash)) throw Object.assign(new Error("invalid hash"), { code: "EINVAL" });
    const results = await Promise.allSettled([
        fs.promises.unlink(path.join(DATA_DIR, hash)),
        fs.promises.unlink(path.join(TORRENT_DIR, hash + TORRENT_EXT))
    ]);
    if (results.every((r) => r.status === "rejected")) {
        throw Object.assign(new Error("not found"), { code: "ENOENT" });
    }
}

module.exports = {
    DATA_DIR,
    TORRENT_DIR,
    HASH_RE,
    storeFile,
    listTorrents,
    deleteTorrent,
    CHUNK_SIZE,
    HASH_ALGO,
    TORRENT_EXT,
    hashFile,
    hashBuffer,
    chunkFile,
    buildTorrent,
    createTorrentFile,
    readTorrentFile,
    readChunk,
    verifyChunk
};
