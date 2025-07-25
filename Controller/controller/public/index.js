let nodes = [];

async function drawSwarmGraph() {
   const res = await fetch("/tailscale/clients");
   const bots = await res.json();



   // Build nodes from bots
   const tempNodes = bots.map(bot => ({
      id: bot.hostname,
      label: `${bot.hostname}\n${bot.ip}`,
   }));

   function arraysEqualByProps(a, b) {
      if (a.length !== b.length) return false;
      return a.every((val, i) =>
         val.id === b[i].id && val.label === b[i].label
      );
   }

   if (arraysEqualByProps(tempNodes, nodes)) {
      console.log("No changes in nodes, skipping redraw");
      return;
   }

   nodes = tempNodes;


   const width = 800, height = 500;
   const svg = d3.select("#swarmGraph");
   svg.selectAll("*").remove(); // clear previous graph

   // Build full-mesh links (every bot linked to every other bot once)
   const links = [];
   for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
         links.push({ source: nodes[i].id, target: nodes[j].id });
      }
   }

   const simulation = d3.forceSimulation(nodes)
      .force("link", d3.forceLink(links).id(d => d.id).distance(150))
      .force("charge", d3.forceManyBody().strength(-300))
      .force("center", d3.forceCenter(width / 2, height / 2))
      .force("collision", d3.forceCollide().radius(40))
      .on("tick", ticked);

   // Draw links (lines between nodes)
   svg.selectAll("line")
      .data(links)
      .enter()
      .append("line")
      .attr("stroke", "#aaa")
      .attr("stroke-width", 1);

   const node = svg.selectAll("g")
      .data(nodes)
      .enter()
      .append("g")
      .call(d3.drag()
         .on("start", dragStarted)
         .on("drag", dragged)
         .on("end", dragEnded)
      );

   node.append("circle")
      .attr("r", 20)
      .attr("fill", "#2ecc71");

   node.append("text")
      .attr("text-anchor", "middle")
      .attr("dy", 5)
      .attr("font-size", "10px")
      .text(d => d.label);

   function ticked() {
      svg.selectAll("line")
         .attr("x1", d => d.source.x)
         .attr("y1", d => d.source.y)
         .attr("x2", d => d.target.x)
         .attr("y2", d => d.target.y);

      node.attr("transform", d => `translate(${d.x},${d.y})`);
   }

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
}

drawSwarmGraph();
setInterval(drawSwarmGraph, 10000); // refresh every 10s





// Handle form submit
document
   .getElementById("cmdForm")
   .addEventListener("submit", async (e) => {
      e.preventDefault();

      const botId = document.getElementById("botId").value;
      const command = document.getElementById("cmdInput").value;
      const outputBox = document.getElementById("cmdOutput");
      outputBox.textContent = "⏳ Waiting for response...";

      const res = await fetch(`/bot/${botId}`, {
         method: "POST",
         headers: { "Content-Type": "application/json" },
         body: JSON.stringify({
            command: "shell",
            payload: { cmd: command },
         }),
      });

      const result = await res.json();
      if (res.ok) {
         outputBox.textContent =
            `✅ ${botId} responded:\n\n` + result.output;
      } else {
         outputBox.textContent = `❌ Error: ${result.error || "no response"
            }`;
      }
   });

// On load