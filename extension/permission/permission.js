/**
 * Microphone permission helper window.
 *
 * Opened by the side panel via chrome.windows.create when getUserMedia
 * fails from inside the side-panel context (where Chrome won't always
 * surface the permission prompt). A popup window has a clearer surface
 * for the prompt to appear on.
 *
 * On a successful grant we signal the side panel via chrome.runtime
 * sendMessage and close ourselves.
 */

/* global chrome */

const allowBtn = document.getElementById("allowBtn");
const settingsBtn = document.getElementById("settingsBtn");
const statusEl = document.getElementById("status");
const helpText = document.getElementById("helpText");

function setStatus(text, kind) {
  statusEl.textContent = text;
  statusEl.className = "status " + (kind || "");
}

allowBtn.addEventListener("click", async () => {
  allowBtn.disabled = true;
  setStatus("Requesting microphone access…", "");
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    setStatus("Microphone access granted. You can close this window and click Start in the side panel.", "ok");
    try {
      await chrome.runtime.sendMessage({ type: "MIC_PERMISSION_GRANTED" });
    } catch (e) { /* side panel may have moved on; that's fine */ }
    // Auto-close shortly so the user doesn't have to.
    setTimeout(() => window.close(), 1200);
  } catch (err) {
    allowBtn.disabled = false;
    settingsBtn.classList.remove("hidden");
    helpText.classList.remove("hidden");
    if (err && err.name === "NotAllowedError") {
      setStatus("Microphone access was denied. Open Chrome's microphone settings and remove the block for this extension, then try again.", "error");
    } else if (err && err.name === "NotFoundError") {
      setStatus("No microphone was detected. Connect or enable a microphone, then try again.", "error");
    } else {
      setStatus("Could not access microphone: " + (err && err.message ? err.message : "unknown error"), "error");
    }
  }
});

settingsBtn.addEventListener("click", () => {
  chrome.tabs.create({ url: "chrome://settings/content/microphone" });
});
