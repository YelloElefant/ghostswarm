/**
 * ChillHandler - POST /api/chill
 * Update peer flow control window
 */
class ChillHandler {
    constructor(stateManager, gstp) {
        this.state = stateManager;
        this.gstp = gstp;
    }

    handle(req, res) {
        const to = req.body && req.body.to ? req.body.to : "";
        const win = req.body && typeof req.body.win !== "undefined" ? req.body.win : 64;
        
        const conn = this.state.getConnection(to);
        if (!conn) {
            return res.status(400).json({ error: "unknown peer id" });
        }

        const clamped = Math.max(1, Math.min(256, parseInt(win, 10) || 64));
        conn.send(this.gstp.mkCHILL(clamped));
        
        res.json({ ok: true, to, win: clamped });
    }
}

module.exports = ChillHandler;
