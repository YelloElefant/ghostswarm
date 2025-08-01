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

      <h3>Tag Management</h3>
      <form id="tagForm" class="tag-form">
         <input type="hidden" id="tagBotId" value="${bot.id}" />
         <label>Add Tags (comma-separated):</label>
         <input type="text" id="tagInput" placeholder="e.g. high-speed, storage, backup" />
         <button type="submit">Update Tags</button>
         <div class="tag-suggestions">
            <span class="suggestion-label">Quick tags:</span>
            <button type="button" class="tag-suggestion" onclick="addQuickTag('high-speed')">high-speed</button>
            <button type="button" class="tag-suggestion" onclick="addQuickTag('storage')">storage</button>
            <button type="button" class="tag-suggestion" onclick="addQuickTag('backup')">backup</button>
            <button type="button" class="tag-suggestion" onclick="addQuickTag('priority')">priority</button>
            <button type="button" class="tag-suggestion" onclick="addQuickTag('testing')">testing</button>
         </div>
         <div id="tagOutput" class="tag-output"></div>
      </form>

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

   // Attach event handlers
   document.getElementById("cmdForm").addEventListener("submit", handleCommandSubmit);
   document.getElementById("tagForm").addEventListener("submit", handleTagSubmit);
}

// Add tag management functions
function addQuickTag(tag) {
   const tagInput = document.getElementById("tagInput");
   const currentTags = tagInput.value.split(',').map(t => t.trim()).filter(t => t);

   if (!currentTags.includes(tag)) {
      const newTags = [...currentTags, tag];
      tagInput.value = newTags.join(', ');
   }
}

async function handleTagSubmit(e) {
   e.preventDefault();

   const botId = document.getElementById("tagBotId").value;
   const tagInput = document.getElementById("tagInput").value;
   const outputBox = document.getElementById("tagOutput");

   // Parse tags from input
   const tags = tagInput.split(',')
      .map(tag => tag.trim())
      .filter(tag => tag.length > 0)
      .filter((tag, index, arr) => arr.indexOf(tag) === index); // Remove duplicates

   if (tags.length === 0) {
      outputBox.innerHTML = '<div class="error">❌ Please enter at least one tag</div>';
      return;
   }

   outputBox.innerHTML = '<div class="info">⏳ Updating tags...</div>';

   try {
      const res = await fetch(`/api/bots/${botId}/setTag`, {
         method: "POST",
         headers: { "Content-Type": "application/json" },
         body: JSON.stringify({ tags: tags }),
      });

      const result = await res.json();

      if (res.ok) {
         outputBox.innerHTML = `<div class="success">✅ Tags updated successfully!</div>`;
         document.getElementById("tagInput").value = ''; // Clear input

         // Force refresh the bot data to show new tags
         setTimeout(async () => {
            try {
               const botsRes = await fetch("api/bots/");
               const bots = await botsRes.json();
               const updatedBot = bots.find(bot => bot.id === botId);
               if (updatedBot) {
                  selectedBot = updatedBot;
                  updateBotInfo(updatedBot);
               }
            } catch (error) {
               console.error("Failed to refresh bot data:", error);
            }
         }, 1000);
      } else {
         outputBox.innerHTML = `<div class="error">❌ Error: ${result.error || "Failed to update tags"}</div>`;
      }
   } catch (error) {
      console.error("Tag update error:", error);
      outputBox.innerHTML = '<div class="error">❌ Network error occurred</div>';
   }
}

// Controller/app/public/index.js - Update updateBotInfo to include tags
function updateBotInfo(bot) {
   const container = document.getElementById("bot-info-container");
   if (!container) return;

   // Calculate memory usage percentage
   let memoryColor = '#4a9eff';
   let memoryUsage = 'N/A';

   if (bot.metadata?.memory) {
      const usage = bot.metadata.memory.used;
      const total = bot.metadata.memory.total;
      const percentage = Math.round((usage / total) * 100);

      memoryUsage = `${usage}/${total}MB (${percentage}%)`;

      if (percentage > 80) memoryColor = '#ff4444';
      else if (percentage > 60) memoryColor = '#ffa500';
      else memoryColor = '#28e96a';
   }

   // Generate bot tags HTML
   const botTagsHtml = bot.metadata?.tags && bot.metadata.tags.length > 0
      ? `<div class="bot-tags">
           <span class="tags-label">Tags:</span>
           ${bot.metadata.tags.map(tag => `<span class="bot-tag">${tag}</span>`).join('')}
         </div>`
      : '<div class="bot-tags"><span class="tags-label">No tags assigned</span></div>';

   container.innerHTML = `
      <div class="bot-info ${!bot.alive ? 'dead' : (bot.stats.activeDownloads > 0 ? 'downloading' : '')}">
         <div><strong>ID:</strong> ${bot.id}</div>
         <div><strong>Name:</strong> ${bot.metadata?.name || 'GhostSwarm Bot'}</div>
         <div><strong>IP:</strong> ${bot.ip}</div>
         <div><strong>Status:</strong> ${bot.alive ? '🟢 Online' : '🔴 Offline'}</div>
         <div><strong>Last Seen:</strong> ${bot.lastSeen}</div>
         <div><strong>Last Updated:</strong> ${new Date().toLocaleTimeString()}</div>
      </div>

      ${botTagsHtml}

      <h3>System Information</h3>
      <div class="system-info">
         <div class="system-grid">
            <div class="system-item">
               <span class="label">Platform</span>
               <span class="value">${bot.metadata?.platform || 'unknown'}</span>
            </div>
            <div class="system-item">
               <span class="label">Architecture</span>
               <span class="value">${bot.metadata?.arch || 'unknown'}</span>
            </div>
            <div class="system-item">
               <span class="label">Memory Usage</span>
               <span class="value" style="color: ${memoryColor}">${memoryUsage}</span>
            </div>
            <div class="system-item">
               <span class="label">Uptime</span>
               <span class="value">${formatUptime(bot.stats?.uptime || 0)}</span>
            </div>
            <div class="system-item">
               <span class="label">Node Version</span>
               <span class="value">${bot.metadata?.nodeVersion || 'unknown'}</span>
            </div>
            <div class="system-item">
               <span class="label">CPU Cores</span>
               <span class="value">${bot.metadata?.cpuCount || 'unknown'}</span>
            </div>
         </div>
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
         <span class="label">Total Torrents</span>
         <span class="value">${bot.stats.totalTorrents || 0}</span>
      </div>
      <div class="status-item">
         <span class="label">Total Files</span>
         <span class="value">${bot.stats.totalFiles || 0}</span>
      </div>
      <div class="status-item">
         <span class="label">Active Downloads</span>
         <span class="value">${bot.stats.activeDownloads}</span>
      </div>
      <div class="status-item">
         <span class="label">Progress</span>
         <span class="value">${totalProgress}%</span>
      </div>
      <div class="status-item">
         <span class="label">Uptime</span>
         <span class="value">${formatUptime(bot.stats.uptime || 0)}</span>
      </div>
      <div class="status-item">
         <span class="label">Memory</span>
         <span class="value">${bot.metadata.memory ? `${bot.metadata.memory.used}MB` : 'N/A'}</span>
      </div>
   `;
}

// Helper function to format uptime
function formatUptime(seconds) {
   const hours = Math.floor(seconds / 3600);
   const minutes = Math.floor((seconds % 3600) / 60);

   if (hours > 0) {
      return `${hours}h ${minutes}m`;
   } else {
      return `${minutes}m`;
   }
}

function updateDownloadList(bot) {
   const container = document.getElementById("downloads-container");
   if (!container) return;

   if (Object.keys(bot.downloads).length > 0) {
      container.innerHTML = `
         <h3>Active Downloads</h3>
         <div class="download-list">
            ${Object.entries(bot.downloads).map(([infoHash, download]) => {
         const progress = download.total > 0
            ? Math.round((download.completed / download.total) * 100)
            : 0;

         // Better status classification
         let statusClass = 'downloading'; // default
         let statusText = download.status;

         switch (download.status) {
            case 'completed':
               statusClass = 'completed';
               statusText = '✅ Complete';
               break;
            case 'downloading':
               statusClass = 'downloading';
               statusText = '⬇️ Downloading';
               break;
            case 'stalled':
               statusClass = 'stalled';
               statusText = '⏸️ Stalled';
               break;
            case 'no_peers':
               statusClass = 'error';
               statusText = '👥 No Peers';
               break;
            case 'failed':
               statusClass = 'error';
               statusText = '❌ Failed';
               break;
            default:
               statusText = download.status;
         }

         // Format file size
         const formatSize = (bytes) => {
            if (!bytes) return 'Unknown';
            const sizes = ['B', 'KB', 'MB', 'GB'];
            const i = Math.floor(Math.log(bytes) / Math.log(1024));
            return Math.round(bytes / Math.pow(1024, i) * 100) / 100 + ' ' + sizes[i];
         };

         // Generate tags HTML
         const tagsHtml = download.tags && download.tags.length > 0
            ? `<div class="download-tags">
                       ${download.tags.map(tag => `<span class="tag">${tag}</span>`).join('')}
                     </div>`
            : '';

         return `
                  <div class="download-item ${statusClass}">
                     <div class="download-header">
                        <div class="download-name">${download.name || infoHash.slice(0, 8)}...</div>
                        <div class="download-size">${formatSize(download.size)}</div>
                     </div>
                     ${tagsHtml}
                     <div class="progress-bar">
                        <div class="progress-fill" style="width: ${progress}%"></div>
                     </div>
                     <div class="download-progress">
                        <span>${download.completed}/${download.total} pieces (${download.percent}%)</span>
                        <span>${statusText}</span>
                     </div>
                     <div class="download-stats">
                        Peers: ${download.peers || 0} | 
                        Queue: ${download.queue || 0} | 
                        Failed: ${download.failed || 0}
                     </div>
                     ${download.createdAt ? `<div class="download-created">Created: ${new Date(download.createdAt).toLocaleDateString()}</div>` : ''}
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