let nodes = [];

async function drawSwarmGraph() {
   const res = await fetch("/tailscale/clients");
   const bots = await res.json();

   const tempNodes = bots.map(bot => ({
      id: bot.hostname,
      label: `${bot.hostname}\n${bot.ip}`,
      alive: true,
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
      .attr("class", d => d.alive ? "alive" : "dead");

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

   node.select("circle").attr("class", d =>
      d.alive ? "alive" : "dead"
   );

   node.on("click", (event, d) => {
      d3.selectAll("circle").classed("selected", false);
      d3.select(event.currentTarget).select("circle").classed("selected", true);

      document.getElementById("sidePanel").classList.add("open");
      document.getElementById("botId").value = d.id;
   });
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
      const topic = `ghostswarm/${botId}/command`;
      const res = await fetch(`/send`, {
         method: "POST",
         headers: { "Content-Type": "application/json" },
         body: JSON.stringify({
            topic: topic,
            command: "shell",
            payload: { cmd: command },
            botId: botId,
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