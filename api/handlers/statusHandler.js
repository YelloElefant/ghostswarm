/**
 * StatusHandler - GET /api/status
 */
class StatusHandler {
    constructor(stateManager, gstp) {
        this.state = stateManager;
        this.gstp = gstp;
    }

    handle(req, res) {
        const snap = this.state.getStatusSnapshot();
        res.json({
            bot: snap.bot,
            tcp: {
                host: "127.0.0.1", // TODO: from config
                port: this.gstp.tcpPort
            },
            http: {
                port: "6565" // TODO: from config
            },
            ...snap
        });
    }
}

module.exports = StatusHandler;
