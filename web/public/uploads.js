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

function progressText(file) {
    const sw = file.swarm;
    if (!sw) return file.have ? "Complete" : "Torrent Only";
    if (sw.complete) return "Complete";
    return sw.have + " / " + sw.total + " Chunks";
}

function peersText(file) {
    const sw = file.swarm;
    return sw ? sw.peers + " With Chunks · " + sw.seeds + " Complete" : "-";
}

function swarmToggle(file) {
    const label = document.createElement("label");
    label.className = "toggle";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = !!(file.swarm && file.swarm.enabled);
    box.addEventListener("change", function() {
        box.disabled = true;
        request("/api/swarm?hash=" + file.hash + "&on=" + (box.checked ? "1" : "0"), "POST")
            .catch(function(err) { alert(err.message); box.checked = !box.checked; })
            .finally(function() { box.disabled = false; });
    });
    label.append(box, document.createTextNode(box.checked ? " On" : " Off"));
    return label;
}

function buildRow(values, numCols, actions, monoCols) {
    const tr = document.createElement("tr");
    values.forEach(function(text, i) {
        const td = document.createElement("td");
        if (text instanceof Node) td.appendChild(text);
        else td.textContent = text;
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
                    progressText(file),
                    peersText(file),
                    swarmToggle(file),
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
}


document.getElementById("refreshBtn").addEventListener("click", refreshAll);
refreshAll();
setInterval(function() { if (!document.hidden) loadUploads(); }, 2000);
