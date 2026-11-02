const SETTING_KEY = "enabled";

async function applyMode(tabId, enabled) {
  try {
    if (enabled) {
      await chrome.scripting.insertCSS({
        target: { tabId },
        files: ["site-mode.css"]
      });
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["site-mode.js"]
      });
    } else {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          document.documentElement.classList.remove("bw-extension-mode");
          document.getElementById("bw-extension-dynamic-style")?.remove();
        }
      });
    }
  } catch (error) {
    console.debug(`Black & White mode unavailable in tab ${tabId}.`, error);
  }
}

async function applyToAllTabs(enabled) {
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs
    .filter(tab => tab.id && /^https?:/.test(tab.url || ""))
    .map(tab => applyMode(tab.id, enabled)));
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && changes[SETTING_KEY]) {
    applyToAllTabs(Boolean(changes[SETTING_KEY].newValue));
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" && /^https?:/.test(tab.url || "")) {
    chrome.storage.local.get(SETTING_KEY).then(({ enabled = false }) => {
      if (enabled) applyMode(tabId, true);
    });
  }
});

chrome.runtime.onStartup.addListener(() => {
  chrome.storage.local.get(SETTING_KEY).then(({ enabled = false }) => {
    if (enabled) applyToAllTabs(true);
  });
});

chrome.storage.local.get(SETTING_KEY).then(({ enabled = false }) => {
  if (enabled) applyToAllTabs(true);
});