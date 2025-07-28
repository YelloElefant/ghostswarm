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
      const res = await fetch("/api/upload", {
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

// Handle drag/drop styling
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

// Handle dropped file
window.addEventListener('drop', e => {
   if (e.dataTransfer.files.length > 0) {
      fileInput.files = e.dataTransfer.files; // assign to real input
      uploadStatus.textContent = `📂 File ready: ${e.dataTransfer.files[0].name}`;
   }
});