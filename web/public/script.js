function q(path, opts) {
    const o = opts || {};
    o.headers = Object.assign({ "content-type": "application/json" }, o.headers);
    return fetch(path, o).then(function(r) {
        return r.json().catch(function() { return {}; }).then(function(res) {
            if (!r.ok) throw new Error(res.error || "Request failed");
            return res;
        });
    });
}

function el(tag, className, text) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (text !== undefined) e.textContent = text;
    return e;
}

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

function formatUptime(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return h + "h " + m + "m " + Math.floor(seconds % 60) + "s";
}

function plural(n, word) {
    return n + " " + word + (n === 1 ? "" : "s");
}

let lastStatus = null;
let selectedId = null;

window.addEventListener("DOMContentLoaded", function() {
    refresh();
    setInterval(refresh, 1500);
    setupMessages();
    setupFiles();
    window.addEventListener("resize", function() {
        if (lastStatus) updateGraphSize();
    });
});

function setConnected(connected, id) {
    document.getElementById("botBadge").classList.toggle("online", connected);
    document.getElementById("botStatus").textContent = connected ? "Connected" : "Disconnected";
    if (id) document.getElementById("botId").textContent = id;
}

function refresh() {
    q("/api/status").then(function(s) {
        lastStatus = s;
        setConnected(true, s.id);
        renderRecipients(s);
        renderGraph(s);
        document.getElementById("graphSummary").textContent =
            plural(s.peers.length, "peer") + " connected · Drag To Move · Scroll To Zoom";
    }).catch(function() {
        setConnected(false);
        document.getElementById("graphSummary").textContent = "Unable to load swarm status";
    });
}

/* ---------- Graph: one table-style card per bot, joined by lines ---------- */
const CARD_W = 230;
const HEAD_H = 32;
const ROW_H = 22;
const ROWS = 6;
const CARD_H = HEAD_H + ROWS * ROW_H + 6;
const STALE_MS = 8000;

let graph = { sig: "", nodes: [], links: [], sim: null, viewport: null, nodeSel: null, linkSel: null };
let graphTransform = d3.zoomIdentity;
let zoomBehavior = null;

function cardRows(info) {
    if (!info) return [["Cpu", "-"], ["Memory", "-"], ["Uptime", "-"], ["Torrents", "-"], ["Downloading", "-"], ["Peers", "-"]];
    const t = info.torrents || { total: 0, complete: 0, downloading: 0 };
    return [
        ["Cpu", (info.cpu.percent || 0).toFixed(1) + "%"],
        ["Memory", formatSize(info.memory.rss)],
        ["Uptime", formatUptime(info.uptime)],
        ["Torrents", t.complete + " / " + t.total + " Held"],
        ["Downloading", String(t.downloading)],
        ["Peers", String((info.links || []).length)]
    ];
}

// Status for a node: ours comes with the response, a peer's arrives by heartbeat
function infoFor(s, id) {
    if (id === s.id) return { info: s.self, fresh: true };
    const entry = s.statuses && s.statuses[id];
    if (!entry) return { info: null, fresh: false };
    return { info: entry.status, fresh: Date.now() - entry.ts < STALE_MS };
}

function topology(s) {
    const ids = new Set([s.id]);
    const edges = new Set();
    const link = function(a, b) {
        if (a && b && a !== b) edges.add([a, b].sort().join("|"));
    };

    s.peers.forEach(function(p) {
        if (!p.id) return;
        ids.add(p.id);
        link(s.id, p.id);
    });
    Object.keys(s.statuses || {}).forEach(function(id) {
        ((s.statuses[id].status || {}).links || []).forEach(function(other) {
            ids.add(other);
            link(id, other);
        });
    });
    return { ids: Array.from(ids).sort(), edges: Array.from(edges).sort() };
}

function renderGraph(s) {
    const svg = d3.select("#swarmGraph");
    const topo = topology(s);
    const sig = topo.ids.join(",") + "#" + topo.edges.join(",") + "#" + s.id;
    if (sig !== graph.sig) buildGraph(s, topo, sig);
    updateCards(s);
}

function buildGraph(s, topo, sig) {
    const svg = d3.select("#swarmGraph");
    const width = svg.node().clientWidth || 800;
    const height = svg.node().clientHeight || 500;

    if (graph.sim) graph.sim.stop();
    svg.selectAll("*").remove();

    // Keep positions of cards that were already on screen
    const old = new Map(graph.nodes.map(function(n) { return [n.id, n]; }));
    graph.nodes = topo.ids.map(function(id, i) {
        const prev = old.get(id);
        if (prev) return { id: id, x: prev.x, y: prev.y };
        const angle = i * 2.4;
        return { id: id, x: width / 2 + Math.cos(angle) * 260, y: height / 2 + Math.sin(angle) * 220 };
    });
    graph.links = topo.edges.map(function(e) {
        const parts = e.split("|");
        return { source: parts[0], target: parts[1] };
    });

    graph.viewport = svg.append("g");
    graph.viewport.attr("transform", graphTransform);
    zoomBehavior = d3.zoom().scaleExtent([0.2, 3]).on("zoom", function(event) {
        graphTransform = event.transform;
        graph.viewport.attr("transform", graphTransform);
    });
    svg.call(zoomBehavior).on("dblclick.zoom", null);

    graph.sim = d3.forceSimulation(graph.nodes)
        .force("link", d3.forceLink(graph.links).id(function(d) { return d.id; }).distance(380))
        .force("charge", d3.forceManyBody().strength(-1500))
        .force("collide", d3.forceCollide(150))
        .force("center", d3.forceCenter(width / 2, height / 2));

    graph.linkSel = graph.viewport.append("g").selectAll("line")
        .data(graph.links).enter().append("line").attr("class", "link");

    const drag = d3.drag()
        .on("start", function(event, d) {
            if (!event.active) graph.sim.alphaTarget(0.3).restart();
            d.fx = d.x;
            d.fy = d.y;
        })
        .on("drag", function(event, d) {
            d.fx = event.x;
            d.fy = event.y;
        })
        .on("end", function(event, d) {
            if (!event.active) graph.sim.alphaTarget(0);
            d.fx = null;
            d.fy = null;
        });

    graph.nodeSel = graph.viewport.append("g").selectAll("g")
        .data(graph.nodes, function(d) { return d.id; }).enter().append("g")
        .attr("class", "node").call(drag)
        .on("click", function(event, d) { selectNode(d.id); });

    graph.nodeSel.each(function(d) {
        const g = d3.select(this);
        g.append("rect").attr("class", "card-bg").attr("width", CARD_W).attr("height", CARD_H).attr("rx", 10)
            .attr("x", -CARD_W / 2).attr("y", -CARD_H / 2);
        g.append("rect").attr("class", "card-head").attr("width", CARD_W).attr("height", HEAD_H).attr("rx", 10)
            .attr("x", -CARD_W / 2).attr("y", -CARD_H / 2);
        g.append("circle").attr("class", "dot").attr("r", 4).attr("cx", -CARD_W / 2 + 14).attr("cy", -CARD_H / 2 + HEAD_H / 2);
        g.append("text").attr("class", "card-title").attr("x", -CARD_W / 2 + 26).attr("y", -CARD_H / 2 + HEAD_H / 2 + 4);
        for (let i = 0; i < ROWS; i++) {
            const y = -CARD_H / 2 + HEAD_H + i * ROW_H;
            g.append("line").attr("class", "row-line").attr("x1", -CARD_W / 2).attr("x2", CARD_W / 2).attr("y1", y).attr("y2", y);
            g.append("text").attr("class", "row-label row-label-" + i).attr("x", -CARD_W / 2 + 14).attr("y", y + 15);
            g.append("text").attr("class", "row-value row-value-" + i).attr("x", CARD_W / 2 - 14).attr("y", y + 15);
        }
    });

    graph.sim.on("tick", function() {
        graph.linkSel
            .attr("x1", function(d) { return d.source.x; })
            .attr("y1", function(d) { return d.source.y; })
            .attr("x2", function(d) { return d.target.x; })
            .attr("y2", function(d) { return d.target.y; });
        graph.nodeSel.attr("transform", function(d) { return "translate(" + d.x + "," + d.y + ")"; });
    });

    graph.sig = sig;
}

// Refreshes card text in place so live status does not reset the layout
function updateCards(s) {
    if (!graph.nodeSel) return;
    graph.nodeSel.each(function(d) {
        const g = d3.select(this);
        const res = infoFor(s, d.id);
        g.classed("self", d.id === s.id)
            .classed("stale", !res.fresh)
            .classed("selected", d.id === selectedId);
        g.select(".card-title").text(d.id === s.id ? d.id + " (This Bot)" : d.id);
        cardRows(res.info).forEach(function(row, i) {
            g.select(".row-label-" + i).text(row[0]);
            g.select(".row-value-" + i).text(row[1]);
        });
    });
}

function updateGraphSize() {
    if (!graph.sim) return;
    const svg = d3.select("#swarmGraph");
    graph.sim.force("center", d3.forceCenter(svg.node().clientWidth / 2, svg.node().clientHeight / 2)).alpha(0.2).restart();
}

function selectNode(id) {
    if (lastStatus && id === lastStatus.id) return;
    selectedId = id;
    const to = document.getElementById("to");
    if (Array.from(to.options).some(function(o) { return o.value === id; })) to.value = id;
    document.getElementById("messageCard").open = true;
    document.getElementById("text").focus();
    updateCards(lastStatus);
}

/* ---------- Messages ---------- */
let messageSeq = null;

function setupMessages() {
    document.getElementById("sendBtn").addEventListener("click", sendMessage);
    document.getElementById("text").addEventListener("keydown", function(event) {
        if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            sendMessage();
        }
    });

    // The first call only learns the latest sequence so old messages are not replayed
    q("/api/messages").then(function(res) {
        messageSeq = res.seq;
        setInterval(pollMessages, 1000);
    }).catch(function() { });
}

function renderRecipients(s) {
    const select = document.getElementById("to");
    const ids = s.peers.map(function(p) { return p.id; }).filter(Boolean).join(",");
    if (select.dataset.ids === ids) return;

    const previous = select.value;
    select.dataset.ids = ids;
    select.replaceChildren(new Option("Everyone (Broadcast)", "*"));
    s.peers.forEach(function(p) {
        if (p.id) select.add(new Option(p.id, p.id));
    });
    if (Array.from(select.options).some(function(o) { return o.value === previous; })) select.value = previous;
}

function sendMessage() {
    const to = document.getElementById("to").value;
    const input = document.getElementById("text");
    const text = input.value.trim();
    if (!text) return;

    const request = to === "*"
        ? q("/api/broadcast", { method: "POST", body: JSON.stringify({ msg: text }) })
        : q("/api/dm", { method: "POST", body: JSON.stringify({ to: to, msg: text }) });

    input.value = "";
    request.then(function(res) {
        if (res.delivered === false) toast("No Response", "From " + to, "error");
    }).catch(function(err) {
        toast("Message Failed", err.message, "error");
    });
}

function pollMessages() {
    q("/api/messages?since=" + messageSeq).then(function(res) {
        messageSeq = res.seq;
        res.messages.forEach(function(m) {
            const target = m.kind === "broadcast" ? "Everyone" : m.to;
            const title = m.mine
                ? "You To " + target
                : "From " + m.from + (m.kind === "broadcast" ? " To Everyone" : "");
            toast(title, m.text);
        });
    }).catch(function() { });
}

function toast(title, text, kind) {
    const box = document.getElementById("toasts");
    const t = el("div", "toast" + (kind ? " " + kind : ""));
    t.append(el("div", "toast-from", title), el("div", "toast-text", text));
    box.appendChild(t);
    while (box.children.length > 5) box.firstChild.remove();
    setTimeout(function() { t.remove(); }, 6000);
}

/* ---------- Files ---------- */
function actionLink(label, url, disabled) {
    const a = el("a", "small" + (disabled ? " disabled" : ""), label);
    if (!disabled) a.href = url;
    return a;
}

function setupFiles() {
    const auto = document.getElementById("autoDownload");
    auto.checked = localStorage.getItem("autoDownload") === "1";
    auto.addEventListener("change", function() {
        localStorage.setItem("autoDownload", auto.checked ? "1" : "0");
    });

    document.getElementById("fileInput").addEventListener("change", function() {
        uploadFiles(this.files);
        this.value = "";
    });

    // Dropping a file anywhere on the page uploads it
    const overlay = document.getElementById("dropOverlay");
    let depth = 0;
    const hasFiles = function(event) {
        return event.dataTransfer && Array.from(event.dataTransfer.types || []).indexOf("Files") !== -1;
    };
    window.addEventListener("dragenter", function(event) {
        if (!hasFiles(event)) return;
        event.preventDefault();
        depth++;
        document.getElementById("dropMode").textContent = auto.checked
            ? "All bots will be told to download it"
            : "Saved here and the torrent is shared";
        document.getElementById("filesCard").open = true;
        overlay.hidden = false;
    });
    window.addEventListener("dragover", function(event) {
        if (hasFiles(event)) event.preventDefault();
    });
    window.addEventListener("dragleave", function(event) {
        if (!hasFiles(event)) return;
        depth = Math.max(0, depth - 1);
        if (depth === 0) overlay.hidden = true;
    });
    window.addEventListener("drop", function(event) {
        if (!hasFiles(event)) return;
        event.preventDefault();
        depth = 0;
        overlay.hidden = true;
        uploadFiles(event.dataTransfer.files);
    });

    loadFiles();
    setInterval(loadFiles, 2000);
}

function uploadFiles(files) {
    Array.from(files).forEach(uploadFile);
}

function uploadFile(file) {
    const list = document.getElementById("uploadList");
    const item = el("li", "upload-item");
    const state = el("span", "file-meta", "Uploading");
    const bar = el("div", "bar");
    const fill = el("div");
    fill.style.width = "0%";
    bar.appendChild(fill);
    item.append(el("span", "file-name", file.name), state, bar);
    list.appendChild(item);

    const finish = function(text, failed) {
        state.textContent = text;
        if (failed) state.style.color = "var(--danger)";
        setTimeout(function() { item.remove(); }, failed ? 6000 : 2500);
        loadFiles();
    };

    const download = document.getElementById("autoDownload").checked ? "&download=1" : "";
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/upload?name=" + encodeURIComponent(file.name) + download);
    xhr.upload.onprogress = function(event) {
        if (event.lengthComputable) fill.style.width = (event.loaded / event.total * 100) + "%";
    };
    xhr.onload = function() {
        let res = {};
        try { res = JSON.parse(xhr.responseText); } catch (e) { /* not json */ }
        if (xhr.status === 200) finish(res.duplicate ? "Already Stored" : "Done", false);
        else finish(res.error || "Upload Failed", true);
    };
    xhr.onerror = function() { finish("Upload Failed", true); };
    xhr.send(file);
}

function loadFiles() {
    q("/api/uploads").then(function(res) {
        const list = document.getElementById("fileList");
        list.replaceChildren();
        res.files.forEach(function(f) { list.appendChild(fileItem(f)); });
        document.getElementById("filesCount").textContent = res.files.length;
        document.getElementById("filesEmpty").hidden = res.files.length > 0;
    }).catch(function() { });
}

function progressText(f) {
    const sw = f.swarm;
    if (!sw) return f.have ? "Complete" : "Torrent Only";
    if (sw.complete) return "Complete";
    return sw.have + " / " + sw.total + " Chunks";
}

function fileItem(f) {
    const sw = f.swarm;
    const item = el("li", "file-item");

    const head = el("div", "file-head");
    head.append(el("span", "file-name", f.name), el("span", "file-meta", formatSize(f.size)));
    item.appendChild(head);

    const peers = sw ? " · " + sw.peers + " With Chunks · " + sw.seeds + " Complete" : "";
    item.appendChild(el("div", "file-meta", progressText(f) + peers));

    if (sw && !sw.complete && sw.total > 0) {
        const bar = el("div", "bar");
        const fill = el("div");
        fill.style.width = (sw.have / sw.total * 100) + "%";
        bar.appendChild(fill);
        item.appendChild(bar);
    }

    const actions = el("div", "file-actions");
    actions.append(
        actionLink("Download", "/api/download?hash=" + f.hash, !f.have),
        actionLink("Torrent", "/api/download-torrent?hash=" + f.hash)
    );

    const label = el("label", "toggle");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = !!(sw && sw.enabled);
    box.addEventListener("change", function() {
        box.disabled = true;
        q("/api/swarm?hash=" + f.hash + "&on=" + (box.checked ? "1" : "0"), { method: "POST" })
            .catch(function(err) { toast("Swarm Failed", err.message, "error"); box.checked = !box.checked; })
            .then(function() { box.disabled = false; });
    });
    label.append(box, document.createTextNode("Download On All Bots"));
    actions.appendChild(label);

    const del = el("button", "secondary small", "Delete");
    del.addEventListener("click", function() {
        if (!confirm("Delete " + f.name + "?")) return;
        q("/api/uploads?hash=" + f.hash, { method: "DELETE" }).then(loadFiles)
            .catch(function(err) { toast("Delete Failed", err.message, "error"); });
    });
    actions.appendChild(del);

    item.appendChild(actions);
    return item;
}
