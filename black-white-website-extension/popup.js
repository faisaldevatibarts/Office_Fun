const toggleButton = document.getElementById("toggle");
const statusText = document.getElementById("status");

function render(enabled) {
  toggleButton.setAttribute("aria-pressed", String(enabled));
  toggleButton.textContent = enabled ? "Turn off for all tabs" : "Enable on all tabs";
  statusText.textContent = enabled ? "Mode is on across tabs" : "Mode is off on all tabs";
}

(async () => {
  try {
    const { enabled = false } = await chrome.storage.local.get("enabled");
    render(enabled);
    toggleButton.addEventListener("click", async () => {
      toggleButton.disabled = true;
      try {
        const nextEnabled = toggleButton.getAttribute("aria-pressed") !== "true";
        await chrome.storage.local.set({ enabled: nextEnabled });
        render(nextEnabled);
      } catch (error) {
        statusText.textContent = "Could not save this setting.";
        console.error(error);
      } finally {
        toggleButton.disabled = false;
      }
    });
  } catch (error) {
    statusText.textContent = "Could not read the current tab.";
    console.error(error);
  }
})();