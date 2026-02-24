/**
 * Logger - Simple structured logging
 */
class Logger {
    constructor(botId) {
        this.botId = botId;
    }

    log(msg, data = {}) {
        console.log(`[${this.botId}] ${msg}`, data);
    }

    warn(msg, data = {}) {
        console.warn(`[${this.botId}] WARN: ${msg}`, data);
    }

    error(msg, err = null) {
        if (err) {
            console.error(`[${this.botId}] ERROR: ${msg}`, err.message);
        } else {
            console.error(`[${this.botId}] ERROR: ${msg}`);
        }
    }

    debug(msg, data = {}) {
        if (process.env.DEBUG) {
            console.debug(`[${this.botId}] DEBUG: ${msg}`, data);
        }
    }
}

module.exports = Logger;
