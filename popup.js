
const toggle = document.getElementById("toggle");
const status = document.getElementById("status");

const controls = {
  viewAllSpacing: document.getElementById("viewAllSpacing"),
  showDimensions: document.getElementById("showDimensions"),
  showTypography: document.getElementById("showTypography"),
  showLayout: document.getElementById("showLayout")
};

async function sendMessage(message) {
  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true
  });

  if (!tab?.id || !/^https?:/.test(tab.url || "")) {
    status.textContent = "Open a normal website first.";
    return null;
  }

  try {
    return await chrome.tabs.sendMessage(tab.id, message);
  } catch {
    status.textContent = "Reload the webpage and try again.";
    return null;
  }
}

function updateUI(state) {
  toggle.textContent = state.enabled
    ? "Disable Inspector"
    : "Enable Inspector";

  toggle.classList.toggle("off", state.enabled);
  status.textContent = state.enabled
    ? "Inspector is ON"
    : "Inspector is OFF";

  Object.entries(controls).forEach(([key, input]) => {
    input.checked = !!state.options?.[key];
  });
}

toggle.addEventListener("click", async () => {
  const result = await sendMessage({ action: "TOGGLE" });
  if (result) updateUI(result);
});

Object.entries(controls).forEach(([key, input]) => {
  input.addEventListener("change", async () => {
    const options = Object.fromEntries(
      Object.entries(controls).map(([name, control]) => [
        name,
        control.checked
      ])
    );

    const result = await sendMessage({
      action: "SET_OPTIONS",
      options
    });

    if (result) updateUI(result);
  });
});

(async () => {
  const result = await sendMessage({ action: "GET_STATE" });
  if (result) updateUI(result);
})();
