function formatSize(bytes) {
    if (bytes < 1024) return bytes + " B";
    const units = ["KB", "MB", "GB", "TB"];
    let value = bytes / 1024;
    let i = 0;
    while (value >= 1024 && i < units.length - 1) {
        value /= 1024;
        i++;
    }
    return value.toFixed(value < 10 ? 2 : 1) + " " + units[i];
}

function plural(n, word) {
    return n + " " + word + (n === 1 ? "" : "s");
}

function actionButton(label, onClick) {
    const btn = document.createElement("button");
    btn.className = "secondary";
    btn.textContent = label;
    btn.addEventListener("click", function() {
        btn.disabled = true;
        onClick().catch(function(err) {
            alert(err.message);
        }).finally(function() {
            btn.disabled = false;
        });
    });
    return btn;
}

function request(url, method) {
    return fetch(url, { method: method }).then(function(r) {
        return r.json().catch(function() { return {}; }).then(function(res) {
            if (!r.ok) throw new Error(res.error || "Request failed");
            return res;
        });
    });
}

function downloadLink(label, url, disabled) {
    const a = document.createElement("a");
    if (disabled) {
        a.className = "button secondary disabled";
        a.textContent = label;
        a.title = "File is not stored on this bot";
        return a;
    }
    a.className = "button secondary";
    a.textContent = label;
    a.href = url;
    return a;
}

function buildRow(values, numCols, actions, monoCols) {
    const tr = document.createElement("tr");
    values.forEach(function(text, i) {
        const td = document.createElement("td");
        td.textContent = text;
        if (numCols.indexOf(i) !== -1) td.className = "num";
        if (monoCols.indexOf(i) !== -1) td.classList.add("mono");
        tr.appendChild(td);
    });
    if (!actions.length) return tr;
    const td = document.createElement("td");
    const wrap = document.createElement("div");
    wrap.className = "row-actions";
    actions.forEach(function(a) { wrap.appendChild(a); });
    td.appendChild(wrap);
    tr.appendChild(td);
    return tr;
}

function loadUploads() {
    const summary = document.getElementById("uploadsSummary");
    return fetch("/api/uploads")
        .then(function(r) {
            if (!r.ok) throw new Error("Request failed");
            return r.json();
        })
        .then(function(res) {
            const body = document.getElementById("uploadsBody");
            body.replaceChildren();

            res.files.forEach(function(file) {
                const actions = [
                    downloadLink("Download", "/api/download?hash=" + file.hash, !file.have),
                    downloadLink("Download Torrent", "/api/download-torrent?hash=" + file.hash),
                    actionButton("Delete", function() {
                        if (!confirm("Delete " + file.name + "?")) return Promise.resolve();
                        return request("/api/uploads?hash=" + file.hash, "DELETE")
                            .then(refreshAll);
                    })
                ];
                body.appendChild(buildRow([
                    file.name,
                    file.ext || "-",
                    formatSize(file.size),
                    file.hash.slice(0, 16) + "…",
                    file.have ? "Yes" : "Torrent Only",
                    new Date(file.created).toLocaleString()
                ], [2], actions, [4]));
            });

            const total = res.files.reduce(function(sum, f) { return sum + f.size; }, 0);
            summary.textContent = plural(res.files.length, "file") + " · " + formatSize(total);
            document.getElementById("emptyState").hidden = res.files.length > 0;
        })
        .catch(function() {
            summary.textContent = "Unable to load uploads";
        });
}

function refreshAll() {
    loadUploads();
    loadPeers();
}

function loadPeers() {
    const select = document.getElementById("peerSelect");
    const previous = select.value;
    return fetch("/api/status")
        .then(function(r) { return r.json(); })
        .then(function(res) {
            select.replaceChildren(new Option("Select a peer", ""));
            (res.peers || []).forEach(function(peer) {
                if (peer.id !== res.id) select.appendChild(new Option(peer.id, peer.id));
            });
            select.value = previous;
        })
        .catch(function() {});
}

function loadPeerTorrents() {
    const to = document.getElementById("peerSelect").value;
    const summary = document.getElementById("peerSummary");
    if (!to) {
        summary.textContent = "Choose a peer first.";
        return;
    }
    summary.textContent = "Asking " + to + "…";
    fetch("/api/peer-torrents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: to })
    })
        .then(function(r) {
            return r.json().then(function(res) {
                if (!r.ok) throw new Error(res.error || "Request failed");
                return res;
            });
        })
        .then(function(res) {
            const body = document.getElementById("peerBody");
            body.replaceChildren();
            res.torrents.forEach(function(t) {
                body.appendChild(buildRow([
                    t.name,
                    formatSize(t.size),
                    String(t.chunks),
                    t.hash.slice(0, 16) + "…"
                ], [1, 2], [], [3]));
            });
            summary.textContent = to + " holds " + plural(res.torrents.length, "torrent");
        })
        .catch(function(err) {
            summary.textContent = "Unable to load: " + err.message;
        });
}

document.getElementById("peerLoadBtn").addEventListener("click", loadPeerTorrents);

document.getElementById("refreshBtn").addEventListener("click", refreshAll);
refreshAll();
