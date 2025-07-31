let nodes = [];
let selectedBot = null;
let updateInterval = null;

async function drawSwarmGraph() {
   const res = await fetch("api/bots/");
   const bots = await res.json();

   console.log(bots);

   const tempNodes = bots.map(bot => ({
      id: bot.id,
      label: `${bot.id}\n${bot.ip}`,
      alive: bot.alive,
      downloading: bot.stats.activeDownloads > 0,
      data: bot // Store full bot data
   }));

   console.log("Temp nodes:", tempNodes);

   function arraysEqualByProps(a, b) {
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) {
         if (a[i].id !== b[i].id ||
            a[i].label !== b[i].label ||
            a[i].alive !== b[i].alive ||
            a[i].downloading !== b[i].downloading) {
            return false;
         }
      }
      return true;
   }

   const needsRedraw = !arraysEqualByProps(tempNodes, nodes);

   if (!needsRedraw) {
      console.log("No structural changes, updating node classes only");

      // Update node classes even if no redraw is needed
      updateNodeClasses(tempNodes);

      // Update selected bot data if side panel is open
      if (selectedBot && document.getElementById("sidePanel").classList.contains("open")) {
         const updatedBot = bots.find(bot => bot.id === selectedBot.id);
         if (updatedBot) {
            selectedBot = updatedBot;
            updateBotDetails(updatedBot);
         }
      }
      return;
   }

   nodes = tempNodes;

   const container = document.getElementById("graphWrapper");
   const width = container.clientWidth;
   const height = container.clientHeight;

   const svg = d3.select("#swarmGraph");
   svg.selectAll("*").remove();
   svg.attr("width", width).attr("height", height);

   // Zoom group wrapper
   const svgGroup = svg.append("g");

   const zoom = d3.zoom()
      .scaleExtent([0.5, 4])
      .on("zoom", (event) => {
         svgGroup.attr("transform", event.transform);
      });

   svg.call(zoom);

   const links = [];
   for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
         links.push({ source: nodes[i].id, target: nodes[j].id });
      }
   }

   const simulation = d3.forceSimulation(nodes)
      .force("link", d3.forceLink(links).id(d => d.id).distance(200))
      .force("charge", d3.forceManyBody().strength(-300))
      .force("center", d3.forceCenter(width / 2, height / 2))
      .force("collision", d3.forceCollide().radius(60));

   const link = svgGroup.append("g")
      .attr("stroke", "#888")
      .attr("stroke-opacity", 0.6)
      .selectAll("line")
      .data(links)
      .join("line")
      .attr("class", "link")
      .attr("stroke-width", 1.5);

   const node = svgGroup.append("g")
      .selectAll("g")
      .data(nodes)
      .join("g")
      .attr("class", "node")
      .call(d3.drag()
         .on("start", dragStarted)
         .on("drag", dragged)
         .on("end", dragEnded)
      );

   node.append("circle")
      .attr("r", 16)
      .attr("class", d => getNodeClass(d));

   node.append("text")
      .text(d => d.id)
      .attr("dy", 28);

   simulation.on("tick", () => {
      link
         .attr("x1", d => d.source.x)
         .attr("y1", d => d.source.y)
         .attr("x2", d => d.target.x)
         .attr("y2", d => d.target.y);

      node.attr("transform", d => `translate(${d.x},${d.y})`);
   });

   function dragStarted(event, d) {
      if (!event.active) simulation.alphaTarget(0.3).restart();
      d.fx = d.x;
      d.fy = d.y;
   }

   function dragged(event, d) {
      d.fx = event.x;
      d.fy = event.y;
   }

   function dragEnded(event, d) {
      if (!event.active) simulation.alphaTarget(0);
      d.fx = null;
      d.fy = null;
   }

   node.filter(d => d.alive).on("click", (event, d) => {
      d3.selectAll("circle").classed("selected", false);
      d3.select(event.currentTarget).select("circle").classed("selected", true);

      selectedBot = d.data;
      showBotDetails(d.data);
      document.getElementById("sidePanel").classList.add("open");

      // Start continuous updates for side panel
      startSidePanelUpdates();
   });

   // Update selected bot data if side panel is open
   if (selectedBot && document.getElementById("sidePanel").classList.contains("open")) {
      const updatedBot = bots.find(bot => bot.id === selectedBot.id);
      if (updatedBot) {
         selectedBot = updatedBot;
         updateBotDetails(updatedBot);
      }
   }
}

// Helper function to determine node class based on bot status
function getNodeClass(node) {
   if (!node.alive) return "dead";
   if (node.downloading) return "downloading";
   return "alive";
}

// Function to update node classes without redrawing the entire graph
function updateNodeClasses(updatedNodes) {
   const svg = d3.select("#swarmGraph");
   const nodeGroups = svg.selectAll(".node");

   // Update each node's class based on current data
   nodeGroups.each(function (d) {
      const updatedNode = updatedNodes.find(n => n.id === d.id);
      if (updatedNode) {
         // Update the node data
         d.alive = updatedNode.alive;
         d.downloading = updatedNode.downloading;
         d.data = updatedNode.data;

         // Update the circle class
         const circle = d3.select(this).select("circle");
         circle
            .attr("class", getNodeClass(updatedNode))
            .classed("selected", circle.classed("selected")); // Preserve selected state
      }
   });

   // Update the global nodes array
   nodes = updatedNodes;
}

function startSidePanelUpdates() {
   // Clear any existing interval
   if (updateInterval) {
      clearInterval(updateInterval);
   }

   // Start new interval for faster updates when side panel is open
   updateInterval = setInterval(async () => {
      if (selectedBot && document.getElementById("sidePanel").classList.contains("open")) {
         try {
            const res = await fetch("api/bots/");
            const bots = await res.json();
            const updatedBot = bots.find(bot => bot.id === selectedBot.id);

            if (updatedBot) {
               selectedBot = updatedBot;
               updateBotDetails(updatedBot);
            }
         } catch (error) {
            console.error("Failed to update bot details:", error);
         }
      } else {
         // Stop the interval if side panel is closed
         clearInterval(updateInterval);
         updateInterval = null;
      }
   }, 1000); // Update every 1 second when side panel is open
}

function showBotDetails(bot) {
   const sidePanel = document.getElementById("sidePanel");

   // Create the full HTML structure
   createBotDetailsHTML(bot);

   // Re-attach form handler
   document.getElementById("cmdForm").addEventListener("submit", handleCommandSubmit);
}

function updateBotDetails(bot) {
   // Only update the dynamic content, preserve form state
   updateBotInfo(bot);
   updateDownloadStats(bot);
   updateDownloadList(bot);
}

function createBotDetailsHTML(bot) {
   const sidePanel = document.getElementById("sidePanel");

   sidePanel.innerHTML = `
      <button class="close-panel" onclick="closeSidePanel()">&times;</button>
      
      <h2>Bot Details</h2>
      
      <div id="bot-info-container">
         <!-- Bot info will be updated here -->
      </div>

      <h3>Download Statistics</h3>
      <div id="stats-container" class="status-grid">
         <!-- Stats will be updated here -->
      </div>

      <div id="downloads-container">
         <!-- Downloads will be updated here -->
      </div>

      <h3>Send Command</h3>
      <form id="cmdForm">
         <input type="hidden" id="botId" value="${bot.id}" />
         <label>Command:</label>
         <input type="text" id="cmdInput" placeholder="e.g. uptime" required />
         <button type="submit">Send</button>
         <pre id="cmdOutput"></pre>
      </form>
   `;

   // Initial update
   updateBotInfo(bot);
   updateDownloadStats(bot);
   updateDownloadList(bot);
}

function updateBotInfo(bot) {
   const container = document.getElementById("bot-info-container");
   if (!container) return;

   container.innerHTML = `
      <div class="bot-info ${!bot.alive ? 'dead' : (bot.stats.activeDownloads > 0 ? 'downloading' : '')}">
         <div><strong>ID:</strong> ${bot.id}</div>
         <div><strong>IP:</strong> ${bot.ip}</div>
         <div><strong>Status:</strong> ${bot.alive ? '🟢 Online' : '🔴 Offline'}</div>
         <div><strong>Last Seen:</strong> ${bot.lastSeen}</div>
         <div><strong>Last Updated:</strong> ${new Date().toLocaleTimeString()}</div>
      </div>
   `;
}

function updateDownloadStats(bot) {
   const container = document.getElementById("stats-container");
   if (!container) return;

   const totalProgress = bot.stats.totalPieces > 0
      ? Math.round((bot.stats.downloadedPieces / bot.stats.totalPieces) * 100)
      : 0;

   container.innerHTML = `
      <div class="status-item">
         <span class="label">Total Downloads</span>
         <span class="value">${bot.stats.totalDownloads}</span>
      </div>
      <div class="status-item">
         <span class="label">Active</span>
         <span class="value">${bot.stats.activeDownloads}</span>
      </div>
      <div class="status-item">
         <span class="label">Completed</span>
         <span class="value">${bot.stats.completedDownloads}</span>
      </div>
      <div class="status-item">
         <span class="label">Progress</span>
         <span class="value">${totalProgress}%</span>
      </div>
   `;
}

function updateDownloadList(bot) {
   const container = document.getElementById("downloads-container");
   if (!container) return;

   if (Object.keys(bot.downloads).length > 0) {
      container.innerHTML = `
         <h3>Active Downloads</h3>
         <div class="download-list">
            ${Object.entries(bot.downloads).map(([infoHash, download]) => {
         // Use correct field names from the status object
         const progress = download.total > 0
            ? Math.round((download.completed / download.total) * 100)
            : 0;

         // Get status with proper color coding
         let statusClass = download.status;
         if (download.status === 'completed') statusClass = 'completed';
         else if (download.status === 'stalled' || download.status === 'error') statusClass = 'error';

         return `
                  <div class="download-item ${statusClass}">
                     <div class="download-name">${download.name || infoHash.slice(0, 8)}...</div>
                     <div class="progress-bar">
                        <div class="progress-fill" style="width: ${progress}%"></div>
                     </div>
                     <div class="download-progress">
                        <span>${download.completed}/${download.total} pieces (${download.percent}%)</span>
                        <span>${download.status}</span>
                     </div>
                     <div style="font-size: 11px; color: #aaa;">
                        Peers: ${download.peers || 0} | 
                        Queue: ${download.queue || 0} | 
                        Failed: ${download.failed || 0}
                     </div>
                  </div>
               `;
      }).join('')}
         </div>
      `;
   } else {
      container.innerHTML = '<p style="color: #aaa;">No active downloads</p>';
   }
}

function closeSidePanel() {
   document.getElementById("sidePanel").classList.remove("open");
   d3.selectAll("circle").classed("selected", false);
   selectedBot = null;

   // Stop continuous updates
   if (updateInterval) {
      clearInterval(updateInterval);
      updateInterval = null;
   }
}

async function handleCommandSubmit(e) {
   e.preventDefault();

   const botId = document.getElementById("botId").value;
   const command = document.getElementById("cmdInput").value;
   const outputBox = document.getElementById("cmdOutput");

   outputBox.textContent = "⏳ Waiting for response...";

   const res = await fetch(`/api/bots/${botId}/command`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
         type: "shell",
         command: command,
         botId: botId,
      }),
   });

   const result = await res.json();
   console.log("Command result:", result);

   if (res.ok) {
      outputBox.textContent = `✅ ${botId} responded:\n\n` + result.output;
   } else {
      outputBox.textContent = `❌ Error: ${result.error || "no response"}`;
   }
}

// Close panel when clicking outside
document.addEventListener('click', (e) => {
   const sidePanel = document.getElementById("sidePanel");
   if (!sidePanel.contains(e.target) && !e.target.closest('.node')) {
      closeSidePanel();
   }
});

// Initial draw and refresh
drawSwarmGraph();
setInterval(drawSwarmGraph, 5000); // refresh every 5s