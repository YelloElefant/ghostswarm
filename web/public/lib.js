function lastSeenHuman(ms) {
    const now = Date.now();
    ms = now - ms;
    if (ms < 1000) return ms + " ms ago";
    if (ms < 60000) return Math.round(ms / 1000) + " s ago";
    if (ms < 3600000) return Math.round(ms / 60000) + " m ago";
    if (ms < 86400000) return Math.round(ms / 3600000) + " h ago";
    return Math.round(ms / 86400000) + " d ago";
}