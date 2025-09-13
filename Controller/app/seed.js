// Controller/app/seed.js
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const config = require('./config');

const UPLOADS_DIR = config.UPLOADS_DIR;
const TORRENT_DIR = config.TORRENTS_DIR;
const PORT = process.env.SEED_PORT || 5000;

// Memory management constants
const MAX_PIECE_SIZE = 1024 * 1024; // 1MB max piece size
const MAX_CHUNK_SIZE = 32 * 1024; // 32KB chunks instead of 64KB
const MAX_CONCURRENT_REQUESTS = 10; // Limit concurrent piece requests per peer
const CLEANUP_INTERVAL = 60000; // Clean up every minute
const PEER_TIMEOUT = 60000; // 60 seconds

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({
    server,
    maxPayload: 1024 * 1024, // 1MB max WebSocket message
    perMessageDeflate: false // Disable compression to save CPU/memory
});

// Track active connections and their capabilities
const connectedPeers = new Map();
const activeTorrents = new Map(); // infoHash -> Set of peer IDs that have it
const activeRequests = new Map(); // Track active piece requests per peer

// WebSocket connection handler
wss.on('connection', (ws, req) => {
    const peerId = generatePeerId();
    const peerInfo = {
        id: peerId,
        ws: ws,
        ip: req.socket.remoteAddress,
        torrents: new Set(), // Torrents this peer has
        lastPing: Date.now(),
        isAlive: true,
        activeRequests: 0 // Track concurrent requests
    };

    connectedPeers.set(peerId, peerInfo);
    activeRequests.set(peerId, new Set());

    console.log(`🔗 Peer ${peerId} connected from ${peerInfo.ip} (${connectedPeers.size} total peers)`);

    // Send welcome message
    ws.send(JSON.stringify({
        type: 'welcome',
        peerId: peerId,
        message: 'Connected to ghostswarm seed network'
    }));

    ws.on('message', async(data) => {
        try {
            // Limit message size
            if (data.length > 1024 * 10) { // 10KB max
                ws.send(JSON.stringify({
                    type: 'error',
                    message: 'Message too large'
                }));
                return;
            }

            const message = JSON.parse(data.toString());
            await handlePeerMessage(peerId, message);
        } catch (err) {
            console.error(`❌ Invalid message from peer ${peerId}:`, err.message);
            ws.send(JSON.stringify({
                type: 'error',
                message: 'Invalid message format'
            }));
        }
    });

    ws.on('pong', () => {
        peerInfo.isAlive = true;
        peerInfo.lastPing = Date.now();
    });

    ws.on('close', () => {
        handlePeerDisconnect(peerId);
    });

    ws.on('error', (err) => {
        console.error(`❌ WebSocket error for peer ${peerId}:`, err.message);
        handlePeerDisconnect(peerId);
    });
});

async function handlePeerMessage(peerId, message) {
    const peer = connectedPeers.get(peerId);
    if (!peer) return;

    switch (message.type) {
        case 'announce':
            await handleAnnounce(peerId, message);
            break;

        case 'request_piece':
            await handlePieceRequest(peerId, message);
            break;

        case 'have':
            await handleHave(peerId, message);
            break;

        case 'get_peers':
            await handleGetPeers(peerId, message);
            break;

        case 'ping':
            peer.ws.send(JSON.stringify({
                type: 'pong',
                timestamp: Date.now()
            }));
            break;

        default:
            console.warn(`⚠️ Unknown message type from peer ${peerId}: ${message.type}`);
    }
}

async function handleAnnounce(peerId, message) {
    const {
        infoHash,
        pieces,
        torrentName
    } = message;
    const peer = connectedPeers.get(peerId);

    if (!peer) return;

    // Add this torrent to peer's list
    peer.torrents.add(infoHash);

    // Track which peers have this torrent
    if (!activeTorrents.has(infoHash)) {
        activeTorrents.set(infoHash, new Set());
    }
    activeTorrents.get(infoHash).add(peerId);

    console.log(`📢 Peer ${peerId} announced ${torrentName} with ${pieces && pieces.length ? pieces.length : 'all'} pieces`);

    // Respond with current swarm info (limit to prevent large responses)
    const swarmPeers = Array.from(activeTorrents.get(infoHash) || [])
        .filter(id => id !== peerId && connectedPeers.has(id))
        .slice(0, 50) // Limit to 50 peers max
        .map(id => ({
            peerId: id,
            ip: connectedPeers.get(id).ip
        }));

    peer.ws.send(JSON.stringify({
        type: 'announce_response',
        infoHash: infoHash,
        swarmSize: swarmPeers.length + 1,
        peers: swarmPeers
    }));
}

async function handlePieceRequest(peerId, message) {
    const {
        infoHash,
        pieceIndex,
        requestId
    } = message;
    const peer = connectedPeers.get(peerId);

    if (!peer) return;

    // Check if peer has too many concurrent requests
    if (peer.activeRequests >= MAX_CONCURRENT_REQUESTS) {
        return sendError(peerId, requestId, 'Too many concurrent requests');
    }

    peer.activeRequests++;
    const peerRequests = activeRequests.get(peerId);
    peerRequests.add(requestId);

    try {
        const torrentPath = path.join(TORRENT_DIR, `${infoHash}${config.TORRENT_EXTENSION}`);

        if (!fs.existsSync(torrentPath)) {
            return sendError(peerId, requestId, 'Torrent not found');
        }

        // Use async file operations
        const torrentData = await fs.promises.readFile(torrentPath, 'utf8');
        const torrent = JSON.parse(torrentData);

        const pieceLength = torrent.pieceLength;

        // Limit piece size to prevent memory issues
        if (pieceLength > MAX_PIECE_SIZE) {
            return sendError(peerId, requestId, 'Piece too large');
        }

        const start = pieceIndex * pieceLength;
        const end = Math.min(start + pieceLength, torrent.size);

        const fullFilePath = path.join(UPLOADS_DIR, torrent.name);
        if (!fs.existsSync(fullFilePath)) {
            return sendError(peerId, requestId, 'Original file not found');
        }

        // Stream the piece data instead of loading it all into memory
        await streamPieceToClient(peerId, requestId, infoHash, pieceIndex, fullFilePath, start, end);

    } catch (err) {
        console.error(`❌ Failed to serve piece ${pieceIndex} of ${infoHash}:`, err.message);
        sendError(peerId, requestId, err.message);
    } finally {
        // Clean up request tracking
        peer.activeRequests--;
        const peerRequests = activeRequests.get(peerId);
        if (peerRequests) {
            peerRequests.delete(requestId);
        }
    }
}

async function streamPieceToClient(peerId, requestId, infoHash, pieceIndex, filePath, start, end) {
    const peer = connectedPeers.get(peerId);
    if (!peer) return;

    const pieceSize = end - start;
    const totalChunks = Math.ceil(pieceSize / MAX_CHUNK_SIZE);

    // Send piece header
    peer.ws.send(JSON.stringify({
        type: 'piece_response',
        requestId: requestId,
        infoHash: infoHash,
        pieceIndex: pieceIndex,
        totalSize: pieceSize,
        totalChunks: totalChunks,
        status: 'start'
    }));

    // Create read stream for the specific piece
    const stream = fs.createReadStream(filePath, {
        start,
        end: end - 1
    });

    let chunkIndex = 0;
    let buffer = Buffer.alloc(0);

    return new Promise((resolve, reject) => {
        stream.on('data', (chunk) => {
            buffer = Buffer.concat([buffer, chunk]);

            // Send chunks when we have enough data
            while (buffer.length >= MAX_CHUNK_SIZE) {
                const chunkData = buffer.slice(0, MAX_CHUNK_SIZE);
                buffer = buffer.slice(MAX_CHUNK_SIZE);

                if (peer.ws.readyState === WebSocket.OPEN) {
                    peer.ws.send(JSON.stringify({
                        type: 'piece_chunk',
                        requestId: requestId,
                        chunkIndex: chunkIndex,
                        totalChunks: totalChunks,
                        data: chunkData.toString('base64')
                    }));
                } else {
                    return reject(new Error('Peer disconnected'));
                }

                chunkIndex++;
            }
        });

        stream.on('end', () => {
            // Send remaining data
            if (buffer.length > 0) {
                if (peer.ws.readyState === WebSocket.OPEN) {
                    peer.ws.send(JSON.stringify({
                        type: 'piece_chunk',
                        requestId: requestId,
                        chunkIndex: chunkIndex,
                        totalChunks: totalChunks,
                        data: buffer.toString('base64')
                    }));
                }
            }

            // Send completion message
            if (peer.ws.readyState === WebSocket.OPEN) {
                peer.ws.send(JSON.stringify({
                    type: 'piece_response',
                    requestId: requestId,
                    status: 'complete'
                }));
            }

            console.log(`📦 Served piece ${pieceIndex} of ${infoHash} to peer ${peerId} (${pieceSize} bytes, ${chunkIndex + 1} chunks)`);
            resolve();
        });

        stream.on('error', (err) => {
            console.error(`❌ Stream error for piece ${pieceIndex}:`, err.message);
            sendError(peerId, requestId, `Stream error: ${err.message}`);
            reject(err);
        });
    });
}

async function handleHave(peerId, message) {
    const {
        infoHash,
        pieceIndex
    } = message;

    // Broadcast to other peers in the swarm that this peer has a new piece
    const swarmPeers = activeTorrents.get(infoHash) || new Set();

    let broadcastCount = 0;
    for (const otherPeerId of swarmPeers) {
        if (otherPeerId !== peerId && connectedPeers.has(otherPeerId)) {
            const otherPeer = connectedPeers.get(otherPeerId);
            if (otherPeer.ws.readyState === WebSocket.OPEN) {
                try {
                    otherPeer.ws.send(JSON.stringify({
                        type: 'peer_have',
                        infoHash: infoHash,
                        pieceIndex: pieceIndex,
                        fromPeer: peerId
                    }));
                    broadcastCount++;
                } catch (err) {
                    console.warn(`⚠️ Failed to broadcast to peer ${otherPeerId}:`, err.message);
                }
            }
        }
    }

    if (broadcastCount > 0) {
        console.log(`📡 Broadcasted piece ${pieceIndex} availability to ${broadcastCount} peers`);
    }
}

async function handleGetPeers(peerId, message) {
    const {
        infoHash
    } = message;
    const peer = connectedPeers.get(peerId);
    if (!peer) return;

    const swarmPeers = Array.from(activeTorrents.get(infoHash) || [])
        .filter(id => id !== peerId && connectedPeers.has(id))
        .slice(0, 30) // Limit response size
        .map(id => ({
            peerId: id,
            ip: connectedPeers.get(id).ip,
            torrents: connectedPeers.get(id).torrents.size
        }));

    peer.ws.send(JSON.stringify({
        type: 'peers_response',
        infoHash: infoHash,
        peers: swarmPeers
    }));
}

function sendError(peerId, requestId, errorMessage) {
    const peer = connectedPeers.get(peerId);
    if (!peer || peer.ws.readyState !== WebSocket.OPEN) return;

    peer.ws.send(JSON.stringify({
        type: 'error',
        requestId: requestId,
        message: errorMessage
    }));
}

function handlePeerDisconnect(peerId) {
    const peer = connectedPeers.get(peerId);
    if (!peer) return;

    console.log(`🔌 Peer ${peerId} disconnected (${connectedPeers.size - 1} remaining)`);

    // Remove peer from all torrents
    for (const infoHash of peer.torrents) {
        const torrentPeers = activeTorrents.get(infoHash);
        if (torrentPeers) {
            torrentPeers.delete(peerId);
            if (torrentPeers.size === 0) {
                activeTorrents.delete(infoHash);
            }
        }
    }

    // Clean up tracking maps
    connectedPeers.delete(peerId);
    activeRequests.delete(peerId);
}

function generatePeerId() {
    return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

// Keep HTTP endpoint for compatibility with streaming
app.get('/piece/:infoHash/:index', (req, res) => {
    const {
        infoHash,
        index
    } = req.params;
    const torrentPath = path.join(TORRENT_DIR, `${infoHash}${config.TORRENT_EXTENSION}`);

    if (!fs.existsSync(torrentPath)) return res.status(404).send('Torrent not found');

    try {
        const torrent = JSON.parse(fs.readFileSync(torrentPath));
        const pieceIndex = parseInt(index);
        const pieceLength = torrent.pieceLength;
        const start = pieceIndex * pieceLength;
        const end = Math.min(start + pieceLength, torrent.size);

        const fullFilePath = path.join(UPLOADS_DIR, torrent.name);
        if (!fs.existsSync(fullFilePath)) return res.status(404).send('Original file not found');

        const stream = fs.createReadStream(fullFilePath, {
            start,
            end: end - 1
        });
        stream.on('error', err => {
            console.error(`❌ Failed to stream piece ${index} of ${infoHash}`, err);
            res.status(500).send('Stream error');
        });
        stream.pipe(res);
    } catch (err) {
        console.error(`❌ HTTP piece request error:`, err.message);
        res.status(500).send('Server error');
    }
});

// Health check endpoint
app.get('/health', (req, res) => {
    const memUsage = process.memoryUsage();
    res.json({
        status: 'healthy',
        connectedPeers: connectedPeers.size,
        activeTorrents: activeTorrents.size,
        uptime: process.uptime(),
        memory: {
            used: Math.round(memUsage.heapUsed / 1024 / 1024),
            total: Math.round(memUsage.heapTotal / 1024 / 1024)
        }
    });
});

// Stats endpoint
app.get('/stats', (req, res) => {
    const stats = {
        connectedPeers: connectedPeers.size,
        activeTorrents: activeTorrents.size,
        torrents: {}
    };

    // Limit stats response size
    let torrentCount = 0;
    for (const [infoHash, peers] of activeTorrents.entries()) {
        if (torrentCount >= 100) break; // Limit to 100 torrents

        stats.torrents[infoHash] = {
            swarmSize: peers.size,
            peers: Array.from(peers).slice(0, 20) // Limit to 20 peers per torrent
        };
        torrentCount++;
    }

    res.json(stats);
});

// Periodic cleanup and health checks
setInterval(() => {
    const now = Date.now();
    const deadPeers = [];

    for (const [peerId, peer] of connectedPeers.entries()) {
        if (now - peer.lastPing > PEER_TIMEOUT) {
            console.warn(`⏰ Peer ${peerId} timed out, disconnecting...`);
            peer.ws.terminate();
            deadPeers.push(peerId);
        } else if (peer.ws.readyState === WebSocket.OPEN) {
            // Send ping
            peer.isAlive = false;
            try {
                peer.ws.ping();
            } catch (err) {
                console.warn(`⚠️ Failed to ping peer ${peerId}:`, err.message);
                deadPeers.push(peerId);
            }
        } else {
            deadPeers.push(peerId);
        }
    }

    // Clean up dead peers
    deadPeers.forEach(peerId => handlePeerDisconnect(peerId));

    // Log memory usage
    const memUsage = process.memoryUsage();
    console.log(`💾 Seeder Memory: ${Math.round(memUsage.heapUsed / 1024 / 1024)}MB used, ${Math.round(memUsage.heapTotal / 1024 / 1024)}MB total, ${connectedPeers.size} peers`);

}, CLEANUP_INTERVAL);

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('🛑 Shutting down seeder...');

    // Close all WebSocket connections
    for (const [peerId, peer] of connectedPeers.entries()) {
        peer.ws.terminate();
    }

    wss.close(() => {
        console.log('✅ Seeder shutdown complete');
        process.exit(0);
    });
});

server.listen(PORT, () => {
    console.log(`🚀 WebSocket seeding server running on port ${PORT}`);
    console.log(`📊 HTTP endpoints: /health, /stats`);
    console.log(`🔌 WebSocket endpoint: ws://localhost:${PORT}`);
});

module.exports = {
    wss,
    app,
    server
};