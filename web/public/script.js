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
                console.log("DM response:", res);
            })
            
        });
    }

});

function setTitle(s) {
    const title = document.getElementById("title");
    if (!title) return;
    title.textContent = `🐘 Bot (${s.id})`;
}

// Fetch /api/status and update UI
function refresh() {
    q("/api/status").then(function(s) {        
        lastStatus = s;
        renderPeers(s);
        setTitle(s);

        // find differnce between old and new peers
        const oldPeers = peersMap;
        const newPeers = s.peers.map(p => p.id);
        for (const p of newPeers) {
            if (!oldPeers.includes(p)) {
                console.log("New peer:", p);
                renderGraph(s);
                peersMap = newPeers;
                break;
            }
        }
        
        
        if (selectedPeerId) updateDetailPanel(selectedPeerId);
    }).catch((error) => {
        console.error("Failed to fetch status:", error);
    });
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

        var tdLast = document.createElement("td");
        tdLast.textContent = lastSeenHuman(p.lastSeen);
        tr.appendChild(tdLast);

        var tdActions = document.createElement("td");
        var btnPanel = document.createElement("button");
        btnPanel.textContent = "Details";
        btnPanel.addEventListener("click", (function(id) {
            return function() {
                openSidePanel(id);
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
        tdActions.appendChild(btnDrop);
        tr.appendChild(tdActions);

        tbody.appendChild(tr);
    }
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