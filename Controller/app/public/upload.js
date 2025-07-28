const form = document.getElementById("uploadForm");
const statusBox = document.getElementById("uploadStatus");

form.addEventListener("submit", async (e) => {
   e.preventDefault();
   const fileInput = form.querySelector('input[type="file"]');
   const file = fileInput.files[0];
   if (!file) return (statusBox.textContent = "⚠️ No file selected.");

   statusBox.textContent = "⏳ Uploading...";
   const formData = new FormData();
   formData.append("torrentFile", file);

   try {
      const res = await fetch("/api/torrent/register", {
         method: "POST",
         body: formData,
      });

      if (res.ok) {
         statusBox.textContent = `✅ Upload successful: ${file.name}`;
      } else {
         statusBox.textContent = `❌ Upload failed: ${res.statusText}`;
      }
   } catch (err) {
      statusBox.textContent = `❌ Error: ${err.message}`;
   }
});

const uploadForm = document.getElementById("uploadForm");
const uploadStatus = document.getElementById("uploadStatus");
const fileInput = document.getElementById("torrentFile");
const modal = document.getElementById("settingsModal");
const torrentNameInput = document.getElementById("torrentName");
const cancelSettings = document.getElementById("cancelSettings");
const settingsForm = document.getElementById("settingsForm");

// Drag-n-drop logic (unchanged)
['dragenter', 'dragover'].forEach(evt =>
   window.addEventListener(evt, e => {
      e.preventDefault();
      e.stopPropagation();
      uploadForm.classList.add("dropzone-active");
   })
);

['dragleave', 'drop'].forEach(evt =>
   window.addEventListener(evt, e => {
      e.preventDefault();
      e.stopPropagation();
      uploadForm.classList.remove("dropzone-active");
   })
);

window.addEventListener("drop", e => {
   if (e.dataTransfer.files.length > 0) {
      fileInput.files = e.dataTransfer.files;
      const file = e.dataTransfer.files[0];
      uploadStatus.textContent = `📂 File ready: ${file.name}`;

      checkIfTorrentExists(file.name).then(exists => {
         console.log(`checking if torrent exists: ${file.name} - ${file.name} - Exists: ${exists}`);
         if (exists) {
            uploadStatus.textContent = `⚠️ Torrent already exists: ${file.name}`;
         } else {
            showSettings(file);
         }
      });
   }
});

fileInput.addEventListener("change", () => {
   const file = fileInput.files[0];
   if (file) {
      uploadStatus.textContent = `📂 File ready: ${file.name}`;
      checkIfTorrentExists(file.name).then(exists => {
         console.log(`Checking if torrent exists: ${file.name} - Exists: ${exists}`);

         if (exists) {
            uploadStatus.textContent = `⚠️ Torrent already exists: ${file.name}`;
         } else {
            showSettings(file);
         }
      });
   }
});

function showSettings(file) {
   modal.style.display = "flex";
   torrentNameInput.value = file.name.replace(/\.[^/.]+$/, ""); // Strip extension
}

cancelSettings.addEventListener("click", () => {
   modal.style.display = "none";
   uploadStatus.textContent = "Upload cancelled.";
});

// Final upload submit
settingsForm.addEventListener("submit", async e => {
   e.preventDefault();
   modal.style.display = "none";

   const file = fileInput.files[0];
   if (!file) {
      uploadStatus.textContent = "❌ No file selected.";
      return;
   }

   const formData = new FormData();
   formData.append("torrentFile", file);
   formData.append("name", settingsForm.name.value);
   formData.append("tags", settingsForm.tags.value);
   formData.append("seeding", settingsForm.seeding.checked);

   uploadStatus.textContent = "⏳ Uploading...";

   try {
      const res = await fetch("/api/torrents/register", {
         method: "POST",
         body: formData
      });

      if (res.ok) {
         uploadStatus.textContent = `✅ Upload complete: ${file.name}`;
      } else {
         uploadStatus.textContent = `❌ Upload failed: ${res.statusText}`;
      }
   } catch (err) {
      uploadStatus.textContent = `❌ Error: ${err.message}`;
   }
});

const tagInput = document.getElementById("tagInput");
const tagList = document.getElementById("tagList");
let tags = [];

tagInput.addEventListener("keydown", e => {
   if (["Enter", ","].includes(e.key)) {
      e.preventDefault();
      const val = tagInput.value.trim();
      if (val && !tags.includes(val)) {
         tags.push(val);
         renderTags();
      }
      tagInput.value = "";
   } else if (e.key === "Backspace" && tagInput.value === "") {
      tags.pop();
      renderTags();
   }
});

function renderTags() {
   tagList.innerHTML = "";
   tags.forEach((tag, idx) => {
      const tagElem = document.createElement("span");
      tagElem.className = "tag";
      tagElem.innerHTML = `${tag}<span class="remove-tag" data-index="${idx}">&times;</span>`;
      tagList.appendChild(tagElem);
   });
}

tagList.addEventListener("click", e => {
   if (e.target.classList.contains("remove-tag")) {
      tags.splice(e.target.dataset.index, 1);
      renderTags();
   }
});

const previewBtn = document.getElementById("previewSettings");
const previewModal = document.getElementById("previewModal");
const settingsModal = document.getElementById("settingsModal");
const previewList = document.getElementById("previewList");

previewBtn.addEventListener("click", () => {
   const name = document.getElementById("torrentName").value;
   const seeding = document.getElementById("enableSeeding").checked;
   const file = document.getElementById("torrentFile").files[0];

   previewList.innerHTML = `
    <li><strong>File:</strong> ${file.name}</li>
    <li><strong>Name:</strong> ${name}</li>
    <li><strong>Tags:</strong> ${tags.join(", ") || "None"}</li>
    <li><strong>Seeding:</strong> ${seeding ? "Enabled" : "Disabled"}</li>
  `;

   settingsModal.style.display = "none";
   previewModal.style.display = "flex";
});

document.getElementById("backToSettings").addEventListener("click", () => {
   previewModal.style.display = "none";
   settingsModal.style.display = "flex";
});

document.getElementById("confirmUpload").addEventListener("click", async () => {
   const file = document.getElementById("torrentFile").files[0];
   if (!file) return;

   const formData = new FormData();
   formData.append("torrentFile", file);
   formData.append("name", document.getElementById("torrentName").value);
   formData.append("tags", tags.join(","));
   formData.append("seeding", document.getElementById("enableSeeding").checked);

   document.getElementById("uploadStatus").textContent = "⏳ Uploading...";
   previewModal.style.display = "none";

   try {
      const res = await fetch("/api/upload", {
         method: "POST",
         body: formData
      });
      if (res.ok) {
         uploadStatus.textContent = `✅ Upload complete: ${file.name}`;
      } else {
         uploadStatus.textContent = `❌ Upload failed: ${res.statusText}`;
      }
   } catch (err) {
      uploadStatus.textContent = `❌ Error: ${err.message}`;
   }
});



function checkIfTorrentExists(hash) {
   return fetch(`/api/torrents/exists/${hash}`)
      .then(res => res.json())
      .then(data => data.exists)
      .catch(() => false);
}