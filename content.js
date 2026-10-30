(() => {
  if (window.__websiteLayoutInspectorLoaded) return;
  window.__websiteLayoutInspectorLoaded = true;

  const state = {
    enabled: false,
    options: {
      viewAllSpacing: false,
      showDimensions: false,
      showTypography: false,
      showLayout: false
    },
    pinnedElements: new Set(),
    hoveredElement: null,
    host: null,
    shadow: null,
    allLayer: null,
    selectedLayer: null,
    pinnedLayer: null,
    detailLabel: null,
    refreshFrame: null
  };

  // --------------------------------------------------
  // Create Shadow DOM UI
  // --------------------------------------------------

  function createInspector() {
    if (state.host) return;

    state.host = document.createElement("div");
    state.host.id = "website-layout-inspector-host";

    Object.assign(state.host.style, {
      position: "fixed",
      inset: "0",
      zIndex: "2147483647",
      pointerEvents: "none"
    });

    document.documentElement.appendChild(state.host);
    state.shadow = state.host.attachShadow({ mode: "open" });

    const style = document.createElement("style");

    style.textContent = `
      * {
        box-sizing: border-box;
      }

      .layer {
        position: fixed;
        inset: 0;
        pointer-events: none;
        overflow: visible;
      }

      .element-outline {
        position: absolute;
        pointer-events: none;
        border: 1px solid #2563eb;
        background: rgba(37, 99, 235, 0.035);
      }

      .selected-outline {
        position: absolute;
        pointer-events: none;
        border: 2px solid #2563eb;
        background: rgba(37, 99, 235, 0.045);
      }

      .pinned-outline {
        position: absolute;
        pointer-events: none;
        border: 2px solid #9333ea;
        background: rgba(147, 51, 234, 0.045);
      }

      .margin-box {
        position: absolute;
        pointer-events: none;
        border: 1px dashed #f97316;
        background: rgba(249, 115, 22, 0.09);
      }

      .padding-box {
        position: absolute;
        pointer-events: none;
        border: 1px dashed #16a34a;
        background: rgba(22, 163, 74, 0.09);
      }

      .spacing-label {
        position: absolute;
        max-width: 280px;
        padding: 5px 7px;
        border-radius: 4px;
        background: #111827;
        color: #fff;
        font: 11px/1.5 Arial, sans-serif;
        white-space: normal;
        overflow-wrap: anywhere;
        box-shadow: 0 2px 8px rgba(0,0,0,.25);
      }

      .detail-label {
        position: absolute;
        min-width: 220px;
        max-width: 340px;
        padding: 10px 12px;
        border: 1px solid #475569;
        border-radius: 7px;
        background: #111827;
        color: #f8fafc;
        font: 12px/1.55 Arial, sans-serif;
        box-shadow: 0 5px 20px rgba(0,0,0,.3);
        overflow-wrap: anywhere;
        white-space: normal;
      }

      .detail-label .heading {
        color: #93c5fd;
        font-weight: 700;
        margin-bottom: 5px;
        font-size: 13px;
      }

      .detail-label .section {
        margin-top: 7px;
        padding-top: 6px;
        border-top: 1px solid #334155;
      }

      .detail-label .key {
        color: #94a3b8;
      }

      .detail-label .value {
        color: #f8fafc;
        overflow-wrap: anywhere;
      }

      .detail-label .tag {
        color: #facc15;
        font-weight: 700;
      }

      .detail-label .pinned-status {
        color: #c4b5fd;
        font-weight: 700;
        margin-top: 5px;
      }

      .spacing-label .margin {
        color: #fdba74;
      }

      .spacing-label .padding {
        color: #86efac;
      }
    `;

    state.allLayer = document.createElement("div");
    state.allLayer.className = "layer";

    state.pinnedLayer = document.createElement("div");
    state.pinnedLayer.className = "layer";

    state.selectedLayer = document.createElement("div");
    state.selectedLayer.className = "layer";

    state.shadow.append(style, state.allLayer, state.pinnedLayer, state.selectedLayer);
  }

  // --------------------------------------------------
  // Helpers
  // --------------------------------------------------

  function escapeHTML(value) {
    return String(value ?? "").replace(/[&<>"']/g, char => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    })[char]);
  }

  function getRect(element) {
    return element.getBoundingClientRect();
  }

  function isVisible(element) {
    if (!(element instanceof Element)) return false;

    const rect = getRect(element);
    const style = getComputedStyle(element);

    return (
      rect.width > 0 &&
      rect.height > 0 &&
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      style.opacity !== "0" &&
      rect.bottom > 0 &&
      rect.right > 0 &&
      rect.top < window.innerHeight &&
      rect.left < window.innerWidth
    );
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return "Not available";

    const units = ["Bytes", "KB", "MB", "GB"];
    const index = Math.min(
      Math.floor(Math.log(bytes) / Math.log(1024)),
      units.length - 1
    );

    const value = bytes / Math.pow(1024, index);

    return `${value.toFixed(index === 0 ? 0 : 2)} ${units[index]}`;
  }

  function getFileExtension(url) {
    if (!url) return "Unknown";

    try {
      if (url.startsWith("data:")) {
        const mime = url.substring(5).split(/[;,]/)[0];
        return mime.split("/")[1]?.toUpperCase() || "Unknown";
      }

      const pathname = new URL(url, location.href).pathname;
      const match = pathname.match(/\.([a-z0-9]{2,8})$/i);

      return match ? match[1].toUpperCase() : "Unknown";
    } catch {
      return "Unknown";
    }
  }

  function getResourceSize(url) {
    if (!url || url.startsWith("data:") || url.startsWith("blob:")) {
      return "Not available";
    }

    try {
      const entries = performance.getEntriesByName(url, "resource");
      const entry = entries.length ? entries[entries.length - 1] : null;

      if (!entry) return "Not available";

      const size = entry.encodedBodySize || entry.decodedBodySize;

      return size ? formatBytes(size) : "Not available";
    } catch {
      return "Not available";
    }
  }

  function getMediaDetails(element) {
    const tag = element.tagName.toLowerCase();

    if (tag !== "img" && tag !== "video" && tag !== "source") {
      return null;
    }

    let url = "";

    if (tag === "img") {
      url = element.currentSrc || element.src || "";
    } else if (tag === "video") {
      url = element.currentSrc || element.src || "";

      if (!url) {
        const source = element.querySelector("source[src]");
        url = source?.src || "";
      }
    } else {
      url = element.src || "";
    }

    if (!url && tag === "source") return null;

    const details = {
      type: tag === "img" ? "Image" : "Video",
      extension: getFileExtension(url),
      size: getResourceSize(url),
      filename: "Unknown",
      url
    };

    try {
      if (url && !url.startsWith("data:") && !url.startsWith("blob:")) {
        const pathname = new URL(url, location.href).pathname;
        details.filename = decodeURIComponent(pathname.split("/").pop()) || "Unknown";
      } else if (url.startsWith("blob:")) {
        details.filename = "Blob resource";
      } else if (url.startsWith("data:")) {
        details.filename = "Data URL";
      }
    } catch {
      // Keep fallback filename.
    }

    if (tag === "img") {
      details.alt = element.alt || "Not set";
      details.title = element.title || "Not set";
      details.naturalSize = `${element.naturalWidth} × ${element.naturalHeight}`;
      details.renderedSize = `${Math.round(element.getBoundingClientRect().width)} × ${Math.round(element.getBoundingClientRect().height)}`;
    }

    if (tag === "video") {
      details.videoSize = `${Math.round(element.videoWidth || 0)} × ${Math.round(element.videoHeight || 0)}`;
      details.renderedSize = `${Math.round(element.getBoundingClientRect().width)} × ${Math.round(element.getBoundingClientRect().height)}`;
    }

    return details;
  }

  function getElementIdentity(element) {
    const tag = element.tagName.toLowerCase();
    const id = element.id ? `#${element.id}` : "None";
    const classes = Array.from(element.classList || []);

    return {
      tag,
      id,
      classes: classes.length ? classes.join(" ") : "None"
    };
  }

  function getSpacing(element) {
    const css = getComputedStyle(element);

    return {
      marginTop: css.marginTop,
      marginRight: css.marginRight,
      marginBottom: css.marginBottom,
      marginLeft: css.marginLeft,
      paddingTop: css.paddingTop,
      paddingRight: css.paddingRight,
      paddingBottom: css.paddingBottom,
      paddingLeft: css.paddingLeft
    };
  }

  function getDimensions(element) {
    const rect = getRect(element);

    return {
      width: `${Math.round(rect.width)}px`,
      height: `${Math.round(rect.height)}px`,
      top: `${Math.round(rect.top)}px`,
      left: `${Math.round(rect.left)}px`
    };
  }

  // --------------------------------------------------
  // Optional Modules
  // --------------------------------------------------

  function getTypographyHTML(element) {
    if (!state.options.showTypography) return "";

    const css = getComputedStyle(element);

    return `
      <div class="section">
        <strong>Typography</strong><br>
        <span class="key">Font:</span>
        <span class="value">${escapeHTML(css.fontFamily)}</span><br>
        <span class="key">Size:</span>
        <span class="value">${escapeHTML(css.fontSize)}</span><br>
        <span class="key">Weight:</span>
        <span class="value">${escapeHTML(css.fontWeight)}</span><br>
        <span class="key">Line height:</span>
        <span class="value">${escapeHTML(css.lineHeight)}</span><br>
        <span class="key">Color:</span>
        <span class="value">${escapeHTML(css.color)}</span><br>
        <span class="key">Alignment:</span>
        <span class="value">${escapeHTML(css.textAlign)}</span><br>
        <span class="key">Letter spacing:</span>
        <span class="value">${escapeHTML(css.letterSpacing)}</span><br>
        <span class="key">Text transform:</span>
        <span class="value">${escapeHTML(css.textTransform)}</span>
      </div>
    `;
  }

  function getLayoutHTML(element) {
    if (!state.options.showLayout) return "";

    const css = getComputedStyle(element);

    return `
      <div class="section">
        <strong>Layout</strong><br>
        <span class="key">Display:</span>
        <span class="value">${escapeHTML(css.display)}</span><br>
        <span class="key">Position:</span>
        <span class="value">${escapeHTML(css.position)}</span><br>
        <span class="key">Flex direction:</span>
        <span class="value">${escapeHTML(css.flexDirection)}</span><br>
        <span class="key">Justify content:</span>
        <span class="value">${escapeHTML(css.justifyContent)}</span><br>
        <span class="key">Align items:</span>
        <span class="value">${escapeHTML(css.alignItems)}</span><br>
        <span class="key">Grid columns:</span>
        <span class="value">${escapeHTML(css.gridTemplateColumns)}</span><br>
        <span class="key">Overflow:</span>
        <span class="value">${escapeHTML(css.overflow)}</span><br>
        <span class="key">Z-index:</span>
        <span class="value">${escapeHTML(css.zIndex)}</span>
      </div>
    `;
  }

  function getDimensionsHTML(element) {
    if (!state.options.showDimensions) return "";

    const dimensions = getDimensions(element);

    return `
      <div class="section">
        <strong>Dimensions</strong><br>
        <span class="key">Width:</span>
        <span class="value">${dimensions.width}</span><br>
        <span class="key">Height:</span>
        <span class="value">${dimensions.height}</span><br>
        <span class="key">Top:</span>
        <span class="value">${dimensions.top}</span><br>
        <span class="key">Left:</span>
        <span class="value">${dimensions.left}</span>
      </div>
    `;
  }

  function getMediaHTML(element) {
    const media = getMediaDetails(element);
    if (!media) return "";

    let html = `
      <div class="section">
        <strong>${media.type} Information</strong><br>
        <span class="key">Extension:</span>
        <span class="value">${escapeHTML(media.extension)}</span><br>
        <span class="key">File size:</span>
        <span class="value">${escapeHTML(media.size)}</span><br>
        <span class="key">Filename:</span>
        <span class="value">${escapeHTML(media.filename)}</span>
      </div>
    `;

    if (media.type === "Image") {
      html += `
        <div>
          <span class="key">ALT:</span>
          <span class="value">${escapeHTML(media.alt)}</span><br>
          <span class="key">Title:</span>
          <span class="value">${escapeHTML(media.title)}</span><br>
          <span class="key">Original size:</span>
          <span class="value">${escapeHTML(media.naturalSize)}</span><br>
          <span class="key">Rendered size:</span>
          <span class="value">${escapeHTML(media.renderedSize)}</span>
        </div>
      `;
    }

    if (media.type === "Video") {
      html += `
        <div>
          <span class="key">Video dimensions:</span>
          <span class="value">${escapeHTML(media.videoSize)}</span><br>
          <span class="key">Rendered size:</span>
          <span class="value">${escapeHTML(media.renderedSize)}</span>
        </div>
      `;
    }

    html += `
      <div>
        <span class="key">Source:</span>
        <span class="value">${escapeHTML(media.url || "Not available")}</span>
      </div>
    `;

    return html;
  }

  // --------------------------------------------------
  // Element Detail Label
  // --------------------------------------------------

  function getDetailHTML(element) {
    const identity = getElementIdentity(element);
    const spacing = getSpacing(element);

    const pinned = state.pinnedElements.has(element);

    return `
      <div class="heading">
        &lt;${escapeHTML(identity.tag)}&gt;
      </div>

      <div>
        <span class="key">ID:</span>
        <span class="value">${escapeHTML(identity.id)}</span>
      </div>

      <div>
        <span class="key">Classes:</span>
        <span class="value">${escapeHTML(identity.classes)}</span>
      </div>

      ${pinned ? `<div class="pinned-status">Pinned element</div>` : ""}

      ${!state.options.viewAllSpacing ? `
        <div class="section">
          <strong>Spacing</strong><br>
          <span class="key">Margin:</span>
          <span class="value">
            ${spacing.marginTop} ${spacing.marginRight}
            ${spacing.marginBottom} ${spacing.marginLeft}
          </span><br>
          <span class="key">Padding:</span>
          <span class="value">
            ${spacing.paddingTop} ${spacing.paddingRight}
            ${spacing.paddingBottom} ${spacing.paddingLeft}
          </span>
        </div>
      ` : ""}

      ${getMediaHTML(element)}
      ${getDimensionsHTML(element)}
      ${getTypographyHTML(element)}
      ${getLayoutHTML(element)}
    `;
  }

  function positionLabel(label, rect) {
    const margin = 8;

    label.style.display = "block";
    label.style.left = "0px";
    label.style.top = "0px";

    const labelRect = label.getBoundingClientRect();

    let left = rect.left;
    let top = rect.bottom + margin;

    if (top + labelRect.height > window.innerHeight) {
      top = rect.top - labelRect.height - margin;
    }

    if (top < 0) top = margin;

    if (left + labelRect.width > window.innerWidth) {
      left = window.innerWidth - labelRect.width - margin;
    }

    if (left < 0) left = margin;

    label.style.left = `${left}px`;
    label.style.top = `${top}px`;
  }

  function updateSelected() {
    if (!state.enabled || !state.hoveredElement) {
      state.selectedLayer.replaceChildren();
      return;
    }

    const element = state.hoveredElement;

    if (!element.isConnected || !isVisible(element)) {
      state.selectedLayer.replaceChildren();
      return;
    }

    const rect = getRect(element);

    state.selectedLayer.replaceChildren();

    const outline = document.createElement("div");
    outline.className = "selected-outline";

    Object.assign(outline.style, {
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`
    });

    state.detailLabel = document.createElement("div");
    state.detailLabel.className = "detail-label";
    state.detailLabel.innerHTML = getDetailHTML(element);

    state.selectedLayer.append(outline, state.detailLabel);

    positionLabel(state.detailLabel, rect);
  }

  // --------------------------------------------------
  // View All Spacing
  // --------------------------------------------------

  function renderSpacing() {
    if (!state.enabled || !state.options.viewAllSpacing) {
      state.allLayer.replaceChildren();
      return;
    }

    const fragment = document.createDocumentFragment();
    const elements = document.querySelectorAll("body *");

    let count = 0;
    const maxElements = 500;

    elements.forEach(element => {
      if (count >= maxElements || !isVisible(element)) return;

      // Avoid inspecting the inspector itself.
      if (state.host.contains(element)) return;

      const rect = getRect(element);
      const spacing = getSpacing(element);

      const outline = document.createElement("div");
      outline.className = "element-outline";

      Object.assign(outline.style, {
        left: `${rect.left}px`,
        top: `${rect.top}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`
      });

      const label = document.createElement("div");
      label.className = "spacing-label";

      label.innerHTML = `
        <span class="margin">M: ${spacing.marginTop} ${spacing.marginRight} ${spacing.marginBottom} ${spacing.marginLeft}</span><br>
        <span class="padding">P: ${spacing.paddingTop} ${spacing.paddingRight} ${spacing.paddingBottom} ${spacing.paddingLeft}</span>
      `;

      label.style.left = `${Math.max(2, rect.left)}px`;
      label.style.top = `${Math.max(2, rect.top)}px`;

      fragment.append(outline, label);
      count++;
    });

    state.allLayer.replaceChildren(fragment);
  }

  // --------------------------------------------------
  // Multiple Pinned Elements
  // --------------------------------------------------

  function renderPinnedElements() {
    if (!state.enabled) {
      state.pinnedLayer.replaceChildren();
      return;
    }

    const fragment = document.createDocumentFragment();

    state.pinnedElements.forEach(element => {
      if (!element.isConnected || !isVisible(element)) return;

      const rect = getRect(element);
      const identity = getElementIdentity(element);

      const outline = document.createElement("div");
      outline.className = "pinned-outline";

      Object.assign(outline.style, {
        left: `${rect.left}px`,
        top: `${rect.top}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`
      });

      const label = document.createElement("div");
      label.className = "spacing-label";

      label.style.left = `${Math.max(2, rect.left)}px`;
      label.style.top = `${Math.max(2, rect.top - 25)}px`;

      label.innerHTML = `
        <strong style="color:#c4b5fd">PINNED</strong>
        &lt;${escapeHTML(identity.tag)}&gt;
        ${escapeHTML(identity.id)}
      `;

      fragment.append(outline, label);
    });

    state.pinnedLayer.replaceChildren(fragment);
  }

  function togglePin(element) {
    if (state.pinnedElements.has(element)) {
      state.pinnedElements.delete(element);
    } else {
      state.pinnedElements.add(element);
    }

    renderPinnedElements();
    updateSelected();
  }

  function clearPins() {
    state.pinnedElements.clear();
    renderPinnedElements();
    updateSelected();
  }

  // --------------------------------------------------
  // Refresh Overlays
  // --------------------------------------------------

  function refresh() {
    if (!state.enabled) return;

    renderSpacing();
    renderPinnedElements();
    updateSelected();
  }

  function scheduleRefresh() {
    if (state.refreshFrame) {
      cancelAnimationFrame(state.refreshFrame);
    }

    state.refreshFrame = requestAnimationFrame(() => {
      state.refreshFrame = null;
      refresh();
    });
  }

  // --------------------------------------------------
  // Mouse and Keyboard Events
  // --------------------------------------------------

  function onMouseMove(event) {
    if (!state.enabled) return;

    const element = document.elementFromPoint(event.clientX, event.clientY);

    if (!element || state.host.contains(element)) return;

    state.hoveredElement = element;
    updateSelected();
  }

  function onClick(event) {
    if (!state.enabled) return;

    const element = document.elementFromPoint(event.clientX, event.clientY);

    if (!element || state.host.contains(element)) return;

    // Prevent the website's normal click action while pinning.
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    state.hoveredElement = element;
    togglePin(element);
  }

  function onKeyDown(event) {
    if (event.key === "Escape") {
      clearPins();

      state.hoveredElement = null;
      state.selectedLayer.replaceChildren();
    }
  }

  // --------------------------------------------------
  // Enable / Disable
  // --------------------------------------------------

  function enableInspector() {
    createInspector();

    state.enabled = true;
    state.host.style.display = "block";

    document.addEventListener("mousemove", onMouseMove, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKeyDown, true);

    window.addEventListener("scroll", scheduleRefresh, true);
    window.addEventListener("resize", scheduleRefresh);

    refresh();
  }

  function disableInspector() {
    state.enabled = false;

    document.removeEventListener("mousemove", onMouseMove, true);
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("keydown", onKeyDown, true);

    window.removeEventListener("scroll", scheduleRefresh, true);
    window.removeEventListener("resize", scheduleRefresh);

    if (state.host) {
      state.host.style.display = "none";
    }

    state.hoveredElement = null;
    state.pinnedElements.clear();

    if (state.refreshFrame) {
      cancelAnimationFrame(state.refreshFrame);
      state.refreshFrame = null;
    }
  }

  function toggleInspector() {
    if (state.enabled) {
      disableInspector();
    } else {
      enableInspector();
    }

    return state.enabled;
  }

  // --------------------------------------------------
  // Popup Communication
  // --------------------------------------------------

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || !message.action) return;

    if (message.action === "TOGGLE") {
      const enabled = toggleInspector();

      sendResponse({
        enabled,
        options: state.options,
        pinnedCount: state.pinnedElements.size
      });

      return true;
    }

    if (message.action === "GET_STATE") {
      sendResponse({
        enabled: state.enabled,
        options: state.options,
        pinnedCount: state.pinnedElements.size
      });

      return true;
    }

    if (message.action === "SET_OPTIONS") {
      state.options = {
        ...state.options,
        ...(message.options || {})
      };

      if (state.enabled) {
        refresh();
      }

      sendResponse({
        enabled: state.enabled,
        options: state.options,
        pinnedCount: state.pinnedElements.size
      });

      return true;
    }
  });

})();