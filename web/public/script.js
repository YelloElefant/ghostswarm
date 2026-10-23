// Simple helper to call the admin API
function q(path, opts) {
    var o = opts || {};
    var headers = o.headers || {};
    headers["content-type"] = "application/json";
    o.headers = headers;
    return fetch(path, o).then(function(r) {
        return r.json();
    });
}

let lastStatus = null;
let selectedPeerId = null;
let peersMap = [];
let graphSimulation = null;
let graphTransform = d3.zoomIdentity;


// Wire UI events
window.addEventListener("DOMContentLoaded", function() {
    // First load + poll
    refresh();
    setInterval(refresh, 2000);

    const sendDmBtn = document.getElementById("sendDmBtn");
    if (sendDmBtn) {
        sendDmBtn.addEventListener("click", function() {
            const to = document.getElementById("to").value.trim();
            const msg = document.getElementById("json").value.trim();
            if (!to || !msg) {
                alert("Please enter both recipient and message.");
                return;
            }
            q("/api/dm", {
                method: "POST",
                body: JSON.stringify({ to, msg })
            }).then((res) => {
                document.getElementById("dmResult").textContent = JSON.stringify(res, null, 2);
            }).catch((error) => {
                console.error("Failed to send direct message:", error);
                document.getElementById("dmResult").textContent = "Message failed to send.";
            });
        });
    }

    document.getElementById("sidebarToggle").addEventListener("click", function() {
        const sidebar = document.getElementById("sidebar");
        const isExpanded = this.getAttribute("aria-expanded") === "true";
        sidebar.classList.toggle("collapsed", isExpanded);
        this.setAttribute("aria-expanded", String(!isExpanded));
        this.setAttribute("aria-label", isExpanded ? "Show sidebar" : "Hide sidebar");
        requestAnimationFrame(function() {
            if (lastStatus) renderGraph(lastStatus);
        });
    });

    document.getElementById("closePeerDetails").addEventListener("click", function() {
        selectedPeerId = null;
        document.getElementById("peerDetails").hidden = true;
        document.querySelectorAll(".peer-item").forEach(function(peer) {
            peer.classList.remove("selected");
        });
    });

    document.getElementById("messagePeerBtn").addEventListener("click", function() {
        const recipient = document.getElementById("to");
        recipient.value = selectedPeerId || "";
        document.getElementById("json").focus();
    });

    document.getElementById("getStatusBtn").addEventListener("click", getBotStatus);

    setupUpload();

    window.addEventListener("resize", function() {
        if (lastStatus) renderGraph(lastStatus);
    });
});

function setTitle(s) {
    const title = document.getElementById("botId");
    if (!title) return;
    title.textContent = s.id;
}

function setConnected(connected) {
    document.getElementById("botBadge").classList.toggle("online", connected);
    document.getElementById("botStatus").textContent = connected ? "Connected" : "Disconnected";
}

function formatBytes(bytes) {
    return (bytes / 1048576).toFixed(1) + " MB";
}

function formatUptime(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return h + "h " + m + "m " + Math.floor(seconds % 60) + "s";
}

function renderStatus(title, status) {
    const result = document.getElementById("statusResult");
    const card = document.createElement("div");
    card.className = "status-card";
    const heading = document.createElement("strong");
    heading.textContent = title;
    card.appendChild(heading);

    const rows = status ? [
        ["Uptime", formatUptime(status.uptime)],
        ["Memory (RSS)", formatBytes(status.memory.rss)],
        ["Heap used", formatBytes(status.memory.heapUsed) + " / " + formatBytes(status.memory.heapTotal)],
        ["CPU user", (status.cpu.user / 1e6).toFixed(2) + " s"],
        ["CPU system", (status.cpu.system / 1e6).toFixed(2) + " s"]
    ] : [["Status", "No response"]];

    const list = document.createElement("dl");
    rows.forEach(function(row) {
        const dt = document.createElement("dt");
        dt.textContent = row[0];
        const dd = document.createElement("dd");
        dd.textContent = row[1];
        list.append(dt, dd);
    });
    card.appendChild(list);
    result.replaceChildren(card);
}

function renderStatusTargets(s) {
    const select = document.getElementById("statusTarget");
    const selected = select.value;
    select.replaceChildren(new Option("Select a peer", ""));
    s.peers.forEach(function(peer) {
        if (peer.id) select.add(new Option(peer.id, peer.id));
    });
    if (Array.from(select.options).some(function(o) { return o.value === selected; })) {
        select.value = selected;
    }
}

function getBotStatus() {
    const target = document.getElementById("statusTarget").value;
    if (!target) return;

    const result = document.getElementById("statusResult");
    result.textContent = "Requesting status…";
    q("/api/peer-status", {
        method: "POST",
        body: JSON.stringify({ to: target })
    }).then(function(res) {
        renderStatus(target, res.ok ? res.status : null);
    }).catch(function() {
        renderStatus(target, null);
    });
}

// Fetch /api/status and update UI
function refresh() {
    q("/api/status").then(function(s) {        
        lastStatus = s;
        renderPeers(s);
        renderRecipientOptions(s.peers);
        setTitle(s);
        setConnected(true);
        renderPeerDetails(s);
        renderStatusTargets(s);

        const newPeers = s.peers.map(p => p.id);
        if (s.id !== peersMap[0] || newPeers.join("\0") !== peersMap.slice(1).join("\0")) {
            peersMap = [s.id].concat(newPeers);
            renderGraph(s);
        }

        const summary = document.getElementById("graphSummary");
        summary.textContent = s.peers.length + (s.peers.length === 1 ? " peer connected" : " peers connected");
    }).catch((error) => {
        console.error("Failed to fetch status:", error);
        setConnected(false);
        document.getElementById("graphSummary").textContent = "Unable to load swarm status";
    });
}

function renderRecipientOptions(peers) {
    var recipient = document.getElementById("to");
    if (!recipient) return;

    var selectedId = recipient.value;
    recipient.replaceChildren(new Option("Select a peer", ""));

    for (var i = 0; i < peers.length; i++) {
        var id = peers[i].id;
        if (!id) continue;
        recipient.add(new Option(id, id));
    }

    if (peers.some(function(peer) {
        return peer.id === selectedId;
    })) {
        recipient.value = selectedId;
    }
}

function renderPeers(s) {
    var peerList = document.getElementById("peerList");
    if (!peerList) return;
    peerList.replaceChildren();
    document.getElementById("peerCount").textContent = s.peers.length;

    for (var i = 0; i < s.peers.length; i++) {
        var p = s.peers[i];
        var peerButton = document.createElement("button");
        peerButton.type = "button";
        peerButton.className = "peer-item" + (p.id === selectedPeerId ? " selected" : "");
        peerButton.addEventListener("click", function(id) {
            return function() {
                selectPeer(id);
            };
        }(p.id || ""));

        var peerId = document.createElement("span");
        peerId.className = "peer-id";
        peerId.textContent = p.id || "Unknown peer";
        var lastSeen = document.createElement("span");
        lastSeen.className = "peer-last-seen";
        lastSeen.textContent = lastSeenHuman(p.lastSeen);
        peerButton.append(peerId, lastSeen);
        peerList.appendChild(peerButton);
    }
}

function selectPeer(id) {
    selectedPeerId = id;
    document.getElementById("peerDetails").hidden = false;
    document.getElementById("detailId").textContent = id;
    document.querySelectorAll(".peer-item").forEach(function(peer) {
        peer.classList.toggle("selected", peer.querySelector(".peer-id").textContent === id);
    });
    renderPeerDetails(lastStatus);
}

function renderPeerDetails(status) {
    if (!selectedPeerId || !status) return;

    var peer = status.peers.find(function(item) {
        return item.id === selectedPeerId;
    });
    if (!peer) {
        selectedPeerId = null;
        document.getElementById("peerDetails").hidden = true;
        return;
    }

    document.getElementById("detailId").textContent = peer.id;
    document.getElementById("detailLastSeen").textContent = lastSeenHuman(peer.lastSeen);
}

/* ---------- Tiny graph (local view) ---------- */
function renderGraph(s) {
    var svg = d3.select("#swarmGraph");
    if (!svg.node()) return;

    var width = svg.node().clientWidth || 600;
    var height = svg.node().clientHeight || 300;
    svg.attr("viewBox", "0 0 " + width + " " + height);

    if (graphSimulation) graphSimulation.stop();
    svg.selectAll("*").remove();

    var viewport = svg.append("g").attr("transform", graphTransform);
    var zoom = d3.zoom().scaleExtent([0.2, 4]).on("zoom", function(event) {
        graphTransform = event.transform;
        viewport.attr("transform", graphTransform);
    });
    svg.call(zoom).call(zoom.transform, graphTransform).on("dblclick.zoom", null);

    // Build a star: center bot -> each peer
    var nodes = [{
        id: s.id,
        center: true
    }];
    for (var i = 0; i < s.peers.length; i++) nodes.push({
        id: s.peers[i].id
    });

    var links = [];
    for (var j = 0; j < s.peers.length; j++) links.push({
        source: s.id,
        target: s.peers[j].id
    });

    graphSimulation = d3.forceSimulation(nodes)
        .force("link", d3.forceLink(links).id(function(d) {
            return d.id;
        }).distance(120))
        .force("charge", d3.forceManyBody().strength(-300))
        .force("center", d3.forceCenter(width / 2, height / 2));

    var link = viewport.append("g").attr("stroke", "#666").attr("stroke-opacity", 0.6)
        .selectAll("line").data(links).enter().append("line").attr("class", "link");

    var node = viewport.append("g").selectAll("g").data(nodes).enter().append("g").attr("class", "node")
        .call(d3.drag()
            .on("start", function(event, d) {
                if (!event.active) graphSimulation.alphaTarget(0.3).restart();
                d.fx = d.x;
                d.fy = d.y;
            })
            .on("drag", function(event, d) {
                d.fx = event.x;
                d.fy = event.y;
            })
            .on("end", function(event, d) {
                if (!event.active) graphSimulation.alphaTarget(0);
                d.fx = null;
                d.fy = null;
            }));
    node.append("circle")
        .attr("r", function(d) {
            return d.center ? 12 : 9;
        })
        .attr("class", function(d) {
            return d.center ? "alive" : "alive";
        })
        .on("click", function(event, d) {
            if (d.center) return;
            selectPeer(d.id);
        });

    node.append("text").attr("dy", ".31em").text(function(d) {
        return d.id;
    });

    graphSimulation.on("tick", function() {
        link
            .attr("x1", function(d) {
                return d.source.x;
            })
            .attr("y1", function(d) {
                return d.source.y;
            })
            .attr("x2", function(d) {
                return d.target.x;
            })
            .attr("y2", function(d) {
                return d.target.y;
            });
        node.attr("transform", function(d) {
            return "translate(" + d.x + "," + d.y + ")";
        });
    });
}

/* ---------- Upload modal ---------- */
function setupUpload() {
    const modal = document.getElementById("uploadModal");
    const zone = document.getElementById("dropZone");
    const input = document.getElementById("fileInput");

    document.getElementById("openUploadBtn").addEventListener("click", function() {
        modal.showModal();
    });
    document.getElementById("closeUploadBtn").addEventListener("click", function() {
        modal.close();
    });
    modal.addEventListener("click", function(event) {
        if (event.target === modal) modal.close();
    });

    ["dragenter", "dragover"].forEach(function(type) {
        zone.addEventListener(type, function(event) {
            event.preventDefault();
            zone.classList.add("dragging");
        });
    });
    ["dragleave", "drop"].forEach(function(type) {
        zone.addEventListener(type, function(event) {
            event.preventDefault();
            zone.classList.remove("dragging");
        });
    });
    zone.addEventListener("drop", function(event) {
        uploadFiles(event.dataTransfer.files);
    });
    input.addEventListener("change", function() {
        uploadFiles(input.files);
        input.value = "";
    });
}

function uploadFiles(files) {
    Array.from(files).forEach(uploadFile);
}

function uploadFile(file) {
    const item = document.createElement("li");
    const name = document.createElement("span");
    name.className = "upload-name";
    name.textContent = file.name;
    const state = document.createElement("span");
    state.className = "upload-state";
    state.textContent = "0%";
    const bar = document.createElement("progress");
    bar.max = 100;
    bar.value = 0;
    item.append(name, state, bar);
    document.getElementById("uploadList").prepend(item);

    const fail = function(message) {
        item.classList.add("failed");
        state.textContent = message;
    };

    // Sending the File itself lets the browser stream it from disk
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/upload?name=" + encodeURIComponent(file.name));
    xhr.setRequestHeader("content-type", "application/octet-stream");
    xhr.upload.onprogress = function(event) {
        if (!event.lengthComputable) return;
        const pct = Math.round((event.loaded / event.total) * 100);
        bar.value = pct;
        state.textContent = pct + "%";
    };
    xhr.onload = function() {
        let res = {};
        try { res = JSON.parse(xhr.responseText); } catch (e) { /* non-JSON error */ }
        if (xhr.status === 200 && res.ok) {
            bar.value = 100;
            item.classList.add("done");
            state.textContent = res.duplicate ? "Already Stored" : "Done";
        } else {
            fail(res.error || "Failed");
        }
    };
    xhr.onerror = function() { fail("Failed"); };
    xhr.send(file);
}
