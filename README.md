# 👻 GhostSwarm

**GhostSwarm** is a distributed, Tailscale-connected, MQTT-orchestrated botnet-style control platform designed for educational and self-hosting purposes. It allows you to send commands, distribute scripts and binaries via a torrent-like swarm system, and orchestrate bot behavior with powerful targeting using tags and manifests.

> *"From the shadows, the swarm obeys."*

---

## 🧐 What Is GhostSwarm?

GhostSwarm is a lightweight orchestration system where:

* The **controller** sends commands or scripts
* **Bots** (called the Swarm) receive, download, and execute payloads
* Payloads (files, scripts, binaries) can be distributed **via a custom P2P torrent-like system**
* Bots can be tagged (e.g., `can-build`, `pi`, `trusted`) and only eligible bots will download or execute a payload
* Commands can be issued via a **web-based CLI interface**

---

## ✨ Core Features

* ✅ **MQTT-based command dispatch** over Tailscale
* ✅ **Bot command listeners** in Python
* ✅ **Controller command sender** with output listener
* ✅ **Swarm-distributed payload system** (`.ghostswarm` torrent files)
* ✅ **Per-bot targeting via tag system**
* ✅ **Executable uploads become dynamic commands**
* ✅ **Web CLI terminal** for remote command entry
* ✅ **Bot self-reporting of tags and metadata**

---

## 🛡️ Architecture Overview

```
                +------------------------+
                |     GhostSwarm UI      |
                |  - Web CLI             |
                |  - Upload files        |
                |  - Assign tags         |
                +------------------------+
                          |
                          v
                   +-------------+
                   | Controller  |
                   |  (MQTT Pub) |
                   +-------------+
                          |
         +----------------+------------------+
         |                                   |
+-------------------+             +---------------------+
|   GhostSwarm Bot  |             |   GhostSwarm Bot    |
| - MQTT Subscriber |             | - MQTT Subscriber   |
| - Torrent Fetcher |             | - Torrent Seeder    |
| - Tag Advertiser  |             | - Payload Runner    |
+-------------------+             +---------------------+
```

---

## 📀 Bot Behavior

Each bot:

* Subscribes to its own topic: `bots/<bot_id>/cmd`
* Receives commands via MQTT
* Publishes output to: `bots/<bot_id>/output`
* Publishes metadata to: `bots/<bot_id>/meta`
* Accepts torrent jobs via `.ghostswarm` files
* Only downloads payloads it is **allowed** to (based on `allowed_bots` or `allowed_tags`)
* Installs valid scripts into `/opt/swarmcmds/`

---

## 💾 `.ghostswarm` File Format

Example manifest file:

```json
{
  "name": "scan.sh",
  "hash": "abc123...",
  "pieces": ["sha256(p1)", "sha256(p2)"],
  "size": 10485760,
  "piece_length": 1048576,
  "target_path": "/opt/swarmcmds/scan.sh",
  "executable": true,
  "type": "command",
  "allowed_bots": ["bigpppi5", "bigppserver3"],
  "allowed_tags": ["can-build", "pi"]
}
```

---

## 🧑‍⚖️ Controller CLI (Planned)

```bash
ghostctl upload scan.sh --allow bigpppi5,bigppserver2
ghostctl run scan.sh --target pi
ghostctl bots
ghostctl swarm list
```

---

## 💾 Web CLI UI (HTML + JS)

Simple JS terminal where you can enter:

```
send bigpppi5 uptime
run-all df -h
swarm upload deploy.sh
bots
```

Backend routes commands via PHP or Node + MQTT.

---

## 🐝 Tagging System

Each bot reports tags like:

```json
{
  "bot_id": "bigpppi5",
  "tags": ["pi", "can-build", "trusted"]
}
```

Tags can be:

* Hardcoded in config
* Auto-detected (based on arch, memory, etc.)
* Assigned from the controller UI
* Used for payload targeting and access control

---

## 🔐 Security Practices

* ✅ Bots verify SHA256 hashes of payload pieces
* ✅ Manifest can be signed by the controller
* ✅ Commands restricted to `/opt/swarmcmds/`
* ✅ Bots only download payloads they're tagged to handle
* ✅ Payloads can be encrypted (future)

---

## 🧰 Future Plans

* WebSocket live output streaming
* Real DHT or piece-sharing between bots
* Redis-based message broker fallback
* Web UI for bot tag assignment + payload tracking
* CLI tool (`ghostctl`) for admin tasks
* Logging, audit, and metrics dashboard
* Portable `ghostswarm-agent` Docker container

---

## 🧪 Tech Stack

* **MQTT Broker**: Mosquitto
* **Bots**: Python 3 (optional Java for P2P)
* **Controller**: PHP or Node.js backend
* **Messaging**: MQTT (pub/sub), Redis (optional)
* **File Distribution**: Custom torrent-style piece exchange

---

## 💬 Terminology

| Term            | Meaning                                 |
| --------------- | --------------------------------------- |
| **Swarm**       | All GhostSwarm-connected bots           |
| **Payload**     | A script, binary, or file to distribute |
| **.ghostswarm** | Torrent-style manifest for a payload    |
| **Tags**        | Labels describing bot capabilities      |
| **Whispers**    | Commands sent to bots via CLI or MQTT   |

---

## 💫 Project Status

GhostSwarm is in active development by [@YelloElefant](https://github.com/yelloelefant).
Use responsibly and ethically. Designed for learning, automation, and homelab orchestration.

---

> *“Control the swarm. Haunt the network.”*
