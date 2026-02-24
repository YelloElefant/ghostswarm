/**
 * DropHandler - POST /api/drop
 * Close a peer connection
 */
class DropHandler {
    constructor(stateManager) {
        this.state = stateManager;
    }

    handle(req, res) {
        const id = req.body && req.body.id ? req.body.id : "";
        const conn = this.state.getConnection(id);
        
        if (!conn) {
            return res.status(404).json({ error: "peer not found" });
        }

        conn.close("admin-drop");
        res.json({ ok: true, dropped: id });
    }
}

module.exports = DropHandler;
