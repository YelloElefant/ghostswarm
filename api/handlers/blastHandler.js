/**
 * BlastHandler - POST /api/blast
 * Send broadcast message to all peers
 */
class BlastHandler {
    constructor(stateManager, gstp, meshManager, logger) {
        this.state = stateManager;
        this.gstp = gstp;
        this.mesh = meshManager;
        this.logger = logger;
    }

    handle(req, res) {
        const topic = req.body && typeof req.body.topic === "string" ? req.body.topic : "chat";
        const data = req.body && typeof req.body.data !== "undefined" ? req.body.data : "";
        
        const msg = this.gstp.mkBLAST(topic, data);
        this.state.markSeen(msg.id);
        
        const entries = this.state.getAllConnections();
        for (const [rid, conn] of entries) {
            conn.send(msg);
        }
        
        this.logger.log(`BLAST ${topic}:`, data);
        res.json({ ok: true, id: msg.id, topic, dataLength: JSON.stringify(data).length });
    }
}

module.exports = BlastHandler;
