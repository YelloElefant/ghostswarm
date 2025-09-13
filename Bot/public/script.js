async function q(path, opts) {
    var o = opts || {};
    var headers = o.headers || {};
    headers["content-type"] = "application/json";
    o.headers = headers;
    var r = await fetch(path, o);
    return r.json();
}

async function refresh() {
    var s = await q('/api/status');

    // title info
    document.getElementById("title").textContent = "🐘 " + s.bot;
    document.getElementById("subtitle").textContent =
        "TCP: " + s.tcp.host + ":" + s.tcp.port +
        " • HTTP: " + s.http.port +
        " • Max peers: " + s.maxPeers;

    // peers
    var tb = document.querySelector('#peers tbody');
    tb.innerHTML = '';
    for (var i = 0; i < s.peers.length; i++) {
        var p = s.peers[i];
        var tr = document.createElement('tr');
        tr.innerHTML =
            '<td>' + (p.id || '??') + '</td>' +
            '<td>' + (p.rtt === null ? '-' : p.rtt) + '</td>' +
            '<td>' + p.inflight + '</td>' +
            '<td>' + p.win + '</td>' +
            '<td>' + p.lastSeenAgoMs + ' ms ago</td>' +
            '<td>' +
            '<button onclick="chill(\'' + (p.id || '') + '\',8)">CHILL 8</button> ' +
            '<button onclick="chill(\'' + (p.id || '') + '\',64)">CHILL 64</button> ' +
            '<button onclick="drop(\'' + (p.id || '') + '\')">Drop</button>' +
            '</td>';
        tb.appendChild(tr);
    }

    // targets
    var ul = document.querySelector('#targets');
    ul.innerHTML = '';
    for (var j = 0; j < s.targets.length; j++) {
        var li = document.createElement('li');
        li.textContent = s.targets[j];
        ul.appendChild(li);
    }
}

async function addTarget() {
    var hp = document.getElementById('hp').value.trim();
    if (!hp) return;
    await q('/api/connect', {
        method: 'POST',
        body: JSON.stringify({
            hp: hp
        })
    });
    document.getElementById('hp').value = '';
    refresh();
}

async function sendBlast() {
    var topic = document.getElementById('topic').value.trim() || 'chat';
    var data = document.getElementById('data').value.trim();
    await q('/api/blast', {
        method: 'POST',
        body: JSON.stringify({
            topic: topic,
            data: data
        })
    });
}

async function sendDM() {
    var to = document.getElementById('to').value.trim();
    var op = document.getElementById('op').value.trim() || 'getStatus';
    var ttl = parseInt(document.getElementById('ttl').value, 10);
    if (isNaN(ttl)) ttl = 8;
    var data = {};
    try {
        data = JSON.parse(document.getElementById('json').value || '{}');
    } catch (e) {
        alert('bad JSON');
        return;
    }
    var res = await q('/api/dm', {
        method: 'POST',
        body: JSON.stringify({
            to: to,
            op: op,
            ttl: ttl,
            data: data
        })
    });
    document.getElementById('dmResult').textContent = JSON.stringify(res, null, 2);
}

async function chill(id, win) {
    await q('/api/chill', {
        method: 'POST',
        body: JSON.stringify({
            to: id,
            win: win
        })
    });
    refresh();
}

async function drop(id) {
    await q('/api/drop', {
        method: 'POST',
        body: JSON.stringify({
            id: id
        })
    });
    refresh();
}

refresh();
setInterval(refresh, 2000);