/**
 * ConnectHandler - POST /api/connect
 * Add a target endpoint to dial
 */
class ConnectHandler {
    constructor(config, stateManager, meshManager, logger) {
        this.config = config;
        this.state = stateManager;
        this.mesh = meshManager;
        this.logger = logger;
    }

    handle(req, res) {
        const hp = req.body && req.body.hp ? req.body.hp : "";
        
        if (!hp) {
            return res.status(400).json({ error: "hp required (host:port)" });
        }

        const parts = hp.split(":");
        if (parts.length !== 2) {
            return res.status(400).json({ error: "bad host:port format" });
        }

        const host = parts[0];
        const port = parseInt(parts[1], 10);
        
        if (isNaN(port)) {
            return res.status(400).json({ error: "bad port" });
        }

        this.mesh.addTarget(host, port);
        this.mesh.dial(host, port);
        
        res.json({ ok: true, target: hp });
    }
}

module.exports = ConnectHandler;
