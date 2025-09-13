// Bot/state.js
const fs = require("fs");
const path = require("path");
const { PATHS } = require("../config");

function getStatePath(infoHash) {
   return path.join(PATHS.STATE_DIR, `${infoHash}.state.json`);
}

function loadState(infoHash) {
   const file = getStatePath(infoHash);
   if (!fs.existsSync(file)) return null;
   try {
      const raw = fs.readFileSync(file, "utf8");
      return JSON.parse(raw);
   } catch (err) {
      console.warn(`⚠️ Failed to load state for ${infoHash}:`, err.message);
      return null;
   }
}

function saveState(infoHash, stateObj) {
   const file = getStatePath(infoHash);
   fs.mkdirSync(path.dirname(file), { recursive: true });
   fs.writeFileSync(file, JSON.stringify(stateObj, null, 2));
}

function clearState(infoHash) {
   const file = getStatePath(infoHash);
   if (fs.existsSync(file)) fs.unlinkSync(file);
}

module.exports = { getStatePath, loadState, saveState, clearState };
