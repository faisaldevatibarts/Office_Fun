(() => {
  const root = document.documentElement;
  root.classList.add("bw-extension-mode");
  // Hide common image/background-image elements while preserving their layout space.
  const styleId = "bw-extension-dynamic-style";
  let style = document.getElementById(styleId);
  if (!style) {
    style = document.createElement("style");
    style.id = styleId;
    style.textContent = `
      html.bw-extension-mode [style*="background-image"],
      html.bw-extension-mode [style*="background: url"],
      html.bw-extension-mode [style*="background:url"] {
        background-image: none !important;
      }
    `;
    document.documentElement.appendChild(style);
  }
})();