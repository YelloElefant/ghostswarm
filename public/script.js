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

var lastStatus = null;
var selectedPeerId = null;

// Wire UI events
window.addEventListener("DOMContentLoaded", function() {
    // Buttons
    var addTargetBtn = document.getElementById("addTargetBtn");
    if (addTargetBtn) addTargetBtn.addEventListener("click", addTarget);

    var sendBlastBtn = document.getElementById("sendBlastBtn");
    if (sendBlastBtn) sendBlastBtn.addEventListener("click", sendBlast);

    var sendDmBtn = document.getElementById("sendDmBtn");
    if (sendDmBtn) sendDmBtn.addEventListener("click", sendDM);

    var openPanelBtn = document.getElementById("openPanelBtn");
    if (openPanelBtn) openPanelBtn.addEventListener("click", function(e) {
        e.preventDefault();
        openSidePanel();
    });

    var closePanelBtn = document.getElementById("closePanelBtn");
    if (closePanelBtn) closePanelBtn.addEventListener("click", function() {
        closeSidePanel();
    });

    var refreshBtn = document.getElementById("refreshBtn");
    if (refreshBtn) refreshBtn.addEventListener("click", refresh);

    // Detail panel buttons
    var dChill8 = document.getElementById("detailChill8");
    if (dChill8) dChill8.addEventListener("click", function() {
        if (selectedPeerId) postChill(selectedPeerId, 8);
    });

    var dChill64 = document.getElementById("detailChill64");
    if (dChill64) dChill64.addEventListener("click", function() {
        if (selectedPeerId) postChill(selectedPeerId, 64);
    });

    var dDrop = document.getElementById("detailDrop");
    if (dDrop) dDrop.addEventListener("click", function() {
        if (selectedPeerId) dropPeer(selectedPeerId);
    });

    var dSend = document.getElementById("detailSendDm");
    if (dSend) dSend.addEventListener("click", sendDetailDM);

    // First load + poll
    refresh();
    setInterval(refresh, 2000);
});

// Fetch /api/status and update UI
function refresh() {
    q("/api/status").then(function(s) {
        lastStatus = s;
        setTitle(s);
        renderPeers(s);
        renderTargets(s);
        renderGraph(s);
        if (selectedPeerId) updateDetailPanel(selectedPeerId);
    }).catch(function() {
        /* ignore */
    });
}

function setTitle(s) {
    var title = document.getElementById("title");
    if (title) title.textContent = "🐘 " + s.bot;
    var subtitle = document.getElementById("subtitle");
    if (subtitle) {
        subtitle.textContent = "TCP: " + s.tcp.host + ":" + s.tcp.port +
            " • HTTP: " + s.http.port +
            " • Max peers: " + s.maxPeers;
    }
}

function renderPeers(s) {
    var tbody = document.querySelector("#peers tbody");
    if (!tbody) return;
    tbody.innerHTML = "";

    for (var i = 0; i < s.peers.length; i++) {
        var p = s.peers[i];
        var tr = document.createElement("tr");

        var tdId = document.createElement("td");
        tdId.textContent = p.id || "??";
        tr.appendChild(tdId);

        var tdRtt = document.createElement("td");
        tdRtt.textContent = (p.rtt === null ? "-" : p.rtt);
        tr.appendChild(tdRtt);

        var tdInflight = document.createElement("td");
        tdInflight.textContent = p.inflight;
        tr.appendChild(tdInflight);

        var tdWin = document.createElement("td");
        tdWin.textContent = p.win;
        tr.appendChild(tdWin);

        var tdLast = document.createElement("td");
        tdLast.textContent = p.lastSeenAgoMs + " ms ago";
        tr.appendChild(tdLast);

        var tdActions = document.createElement("td");
        var btnPanel = document.createElement("button");
        btnPanel.textContent = "Details";
        btnPanel.addEventListener("click", (function(id) {
            return function() {
                openSidePanel(id);
            };
        })(p.id || ""));

        var btnChill8 = document.createElement("button");
        btnChill8.textContent = "CHILL 8";
        btnChill8.addEventListener("click", (function(id) {
            return function() {
                postChill(id, 8);
            };
        })(p.id || ""));

        var btnChill64 = document.createElement("button");
        btnChill64.textContent = "CHILL 64";
        btnChill64.addEventListener("click", (function(id) {
            return function() {
                postChill(id, 64);
            };
        })(p.id || ""));

        var btnDrop = document.createElement("button");
        btnDrop.className = "secondary";
        btnDrop.textContent = "Drop";
        btnDrop.addEventListener("click", (function(id) {
            return function() {
                dropPeer(id);
            };
        })(p.id || ""));

        tdActions.appendChild(btnPanel);
        tdActions.appendChild(document.createTextNode(" "));
        tdActions.appendChild(btnChill8);
        tdActions.appendChild(document.createTextNode(" "));
        tdActions.appendChild(btnChill64);
        tdActions.appendChild(document.createTextNode(" "));
        tdActions.appendChild(btnDrop);
        tr.appendChild(tdActions);

        tbody.appendChild(tr);
    }
}

function renderTargets(s) {
    var ul = document.getElementById("targets");
    if (!ul) return;
    ul.innerHTML = "";
    for (var i = 0; i < s.targets.length; i++) {
        var li = document.createElement("li");
        li.textContent = s.targets[i];
        ul.appendChild(li);
    }
}

function addTarget() {
    var input = document.getElementById("hp");
    if (!input) return;
    var hp = input.value.trim();
    if (!hp) return;
    q("/api/connect", {
            method: "POST",
            body: JSON.stringify({
                hp: hp
            })
        })
        .then(function() {
            input.value = "";
            refresh();
        });
}

function sendBlast() {
    var topic = document.getElementById("topic").value.trim() || "chat";
    var data = document.getElementById("data").value.trim();
    q("/api/blast", {
            method: "POST",
            body: JSON.stringify({
                topic: topic,
                data: data
            })
        })
        .then(function() {
            /* ok */
        });
}

function sendDM() {
    var to = document.getElementById("to").value.trim();
    var op = document.getElementById("op").value.trim() || "getStatus";
    var ttl = parseInt(document.getElementById("ttl").value, 10);
    if (isNaN(ttl)) ttl = 8;
    var data = {};
    try {
        data = JSON.parse(document.getElementById("json").value || "{}");
    } catch (e) {
        alert("bad JSON");
        return;
    }

    q("/api/dm", {
            method: "POST",
            body: JSON.stringify({
                to: to,
                op: op,
                ttl: ttl,
                data: data
            })
        })
        .then(function(res) {
            var pre = document.getElementById("dmResult");
            if (pre) pre.textContent = JSON.stringify(res, null, 2);
        });
}

function postChill(id, win) {
    if (!id) return;
    q("/api/chill", {
            method: "POST",
            body: JSON.stringify({
                to: id,
                win: win
            })
        })
        .then(function() {
            refresh();
        });
}

function dropPeer(id) {
    if (!id) return;
    q("/api/drop", {
            method: "POST",
            body: JSON.stringify({
                id: id
            })
        })
        .then(function() {
            refresh();
        });
}

/* ---------- Side Panel ---------- */
function openSidePanel(peerId) {
    selectedPeerId = peerId || selectedPeerId;
    var sp = document.getElementById("sidePanel");
    if (!sp) return;
    sp.classList.add("open");
    if (selectedPeerId) updateDetailPanel(selectedPeerId);
}

function closeSidePanel() {
    var sp = document.getElementById("sidePanel");
    if (sp) sp.classList.remove("open");
    selectedPeerId = null;
}

function updateDetailPanel(peerId) {
    if (!lastStatus) return;
    var peers = lastStatus.peers || [];
    var found = null;
    for (var i = 0; i < peers.length; i++) {
        if (peers[i].id === peerId) {
            found = peers[i];
            break;
        }
    }
    if (!found) return;

    var el;
    el = document.getElementById("detailId");
    if (el) el.textContent = found.id || "-";
    el = document.getElementById("detailRtt");
    if (el) el.textContent = (found.rtt === null ? "-" : found.rtt);
    el = document.getElementById("detailInflight");
    if (el) el.textContent = found.inflight;
    el = document.getElementById("detailWin");
    if (el) el.textContent = found.win;

    selectedPeerId = found.id;
}

function sendDetailDM() {
    if (!selectedPeerId) return;
    var opEl = document.getElementById("detailOp");
    var ttlEl = document.getElementById("detailTtl");
    var jsonEl = document.getElementById("detailJson");
    var outEl = document.getElementById("detailDmResult");

    var op = opEl ? (opEl.value || "getStatus") : "getStatus";
    var ttl = ttlEl ? parseInt(ttlEl.value, 10) : 8;
    if (isNaN(ttl)) ttl = 8;
    var data = {};
    try {
        data = jsonEl && jsonEl.value ? JSON.parse(jsonEl.value) : {};
    } catch (e) {
        alert("bad JSON");
        return;
    }

    q("/api/dm", {
            method: "POST",
            body: JSON.stringify({
                to: selectedPeerId,
                op: op,
                ttl: ttl,
                data: data
            })
        })
        .then(function(res) {
            if (outEl) outEl.textContent = JSON.stringify(res, null, 2);
        });
}

/* ---------- Tiny graph (local view) ---------- */
function renderGraph(s) {
    var svg = d3.select("#swarmGraph");
    if (!svg.node()) return;

    var width = svg.node().clientWidth || 600;
    var height = svg.node().clientHeight || 300;
    svg.attr("viewBox", "0 0 " + width + " " + height);

    svg.selectAll("*").remove();

    // Build a star: center bot -> each peer
    var nodes = [{
        id: s.bot,
        center: true
    }];
    for (var i = 0; i < s.peers.length; i++) nodes.push({
        id: s.peers[i].id
    });

    var links = [];
    for (var j = 0; j < s.peers.length; j++) links.push({
        source: s.bot,
        target: s.peers[j].id
    });

    var sim = d3.forceSimulation(nodes)
        .force("link", d3.forceLink(links).id(function(d) {
            return d.id;
        }).distance(120))
        .force("charge", d3.forceManyBody().strength(-300))
        .force("center", d3.forceCenter(width / 2, height / 2));

    var link = svg.append("g").attr("stroke", "#666").attr("stroke-opacity", 0.6)
        .selectAll("line").data(links).enter().append("line").attr("class", "link");

    var node = svg.append("g").selectAll("g").data(nodes).enter().append("g").attr("class", "node");
    node.append("circle")
        .attr("r", function(d) {
            return d.center ? 12 : 9;
        })
        .attr("class", function(d) {
            return d.center ? "alive" : "alive";
        })
        .on("click", function(event, d) {
            if (d.center) return;
            openSidePanel(d.id);
        });

    node.append("text").attr("dy", ".31em").text(function(d) {
        return d.id;
    });

    sim.on("tick", function() {
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