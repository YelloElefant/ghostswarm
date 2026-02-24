/**
 * DmHandler - POST /api/dm
 * Send direct message and await response
 */
class DmHandler {
    constructor(config, stateManager, gstp, logger) {
        this.config = config;
        this.state = stateManager;
        this.gstp = gstp;
        this.logger = logger;
    }

    async handle(req, res) {
        const to = req.body && req.body.to ? req.body.to : "";
        const op = req.body && req.body.op ? req.body.op : "getStatus";
        const ttl = req.body && typeof req.body.ttl === "number" ? req.body.ttl : 8;
        const timeoutMs = req.body && typeof req.body.timeoutMs === "number" ? req.body.timeoutMs : 3000;
        const data = req.body && req.body.data ? req.body.data : {};

        if (!to) {
            return res.status(400).json({ error: "to required" });
        }

        const msg = this.gstp.mkDM(to, op, data, ttl);
        this.state.markSeen(msg.id);

        const entries = this.state.getAllConnections();
        if (entries.length === 0) {
            return res.status(400).json({ error: "no peers connected" });
        }

        // Sort by RTT (prefer shortest)
        const peers = entries.map(([rid, conn]) => ({
            rid,
            conn,
            rtt: typeof conn.rtt === "number" ? conn.rtt : 1e9
        })).sort((a, b) => a.rtt - b.rtt);

        const best = peers[0];
        const rid = best.rid;
        const conn = best.conn;

        const win = this.state.getPeerWindow(rid);
        const cur = this.state.getInflight(rid);
        
        if (cur >= win) {
            return res.status(429).json({ 
                error: "peer window full",
                win, 
                inflight: cur 
            });
        }

        this.state.incrementInflight(rid, 1);

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

        conn.send(msg);
        const reply = await p;
        
        res.json({
            ok: true,
            id: msg.id,
            to,
            op,
            reply
        });
    }
}

module.exports = DmHandler;
