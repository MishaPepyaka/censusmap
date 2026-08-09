(function initMapActions() {
  const SHARE_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15V3m0 0 4 4m-4-4-4 4M5 10.5v7.75A1.75 1.75 0 0 0 6.75 20h10.5A1.75 1.75 0 0 0 19 18.25V10.5"/></svg>`;

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function getGoogleMapsLink(lat, lng) {
    return `https://www.google.com/maps?q=${lat.toFixed(6)},${lng.toFixed(6)}`;
  }

  function getAppleMapsLink(lat, lng) {
    return `https://maps.apple.com/?ll=${lat.toFixed(6)},${lng.toFixed(6)}&q=${lat.toFixed(6)},${lng.toFixed(6)}`;
  }

  function buildMapActionButtons(lat, lng, shareTitle, inline = false, shareUrl = window.location.href) {
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return "";
    const googleUrl = getGoogleMapsLink(lat, lng);
    const appleUrl = getAppleMapsLink(lat, lng);
    return [
      `<div class="dw-popup-actions${inline ? " dw-popup-actions-inline" : ""}">`,
      `<button type="button" class="dw-action-btn dw-action-icon dw-action-share" data-title="${escapeHtml(shareTitle)}" data-share-url="${escapeHtml(shareUrl)}" aria-label="Copy page link" title="Copy page link">${SHARE_ICON}</button>`,
      `<a class="dw-action-btn dw-action-icon dw-action-google" href="${escapeHtml(googleUrl)}" target="_blank" rel="noreferrer" aria-label="Open in Google Maps" title="Open in Google Maps"><img src="/map-action-icons/google-maps.png" alt=""></a>`,
      `<a class="dw-action-btn dw-action-icon dw-action-apple" href="${escapeHtml(appleUrl)}" target="_blank" rel="noreferrer" aria-label="Open in Apple Maps" title="Open in Apple Maps"><img src="/map-action-icons/apple-maps.png" alt=""></a>`,
      `</div>`
    ].join("");
  }

  async function copyShareLink(shareBtn) {
    const url = new URL(shareBtn.getAttribute("data-share-url") || window.location.href, window.location.origin).href;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
      } else {
        const fallback = document.createElement("textarea");
        fallback.value = url;
        fallback.setAttribute("readonly", "");
        fallback.style.position = "fixed";
        fallback.style.opacity = "0";
        document.body.append(fallback);
        fallback.select();
        const copied = document.execCommand("copy");
        fallback.remove();
        if (!copied) throw new Error("Clipboard unavailable");
      }
      const popup = shareBtn.closest(".dw-popup") || shareBtn.parentElement;
      let copyStatus = popup?.querySelector(".dw-popup-share-status");
      if (!copyStatus && popup) {
        copyStatus = document.createElement("div");
        copyStatus.className = "dw-popup-share-status";
        copyStatus.setAttribute("role", "status");
        copyStatus.setAttribute("aria-live", "polite");
        popup.append(copyStatus);
      }
      if (copyStatus) {
        copyStatus.textContent = "✓ Link copied";
        copyStatus.hidden = false;
      }
      shareBtn.classList.add("is-copied");
      shareBtn.title = "Link copied";
      window.setTimeout(() => {
        if (copyStatus) copyStatus.hidden = true;
        shareBtn.classList.remove("is-copied");
        shareBtn.title = "Copy page link";
      }, 1200);
    } catch {
      window.prompt("Copy link:", url);
    }
  }

  function installMapActionHandlers() {
    if (document.documentElement.dataset.mapActionsInstalled === "true") return;
    document.documentElement.dataset.mapActionsInstalled = "true";
    document.addEventListener("click", (event) => {
      const shareBtn = event.target?.closest?.(".dw-action-share");
      if (!shareBtn) return;
      event.preventDefault();
      void copyShareLink(shareBtn);
    });
  }

  installMapActionHandlers();
  window.CensusMapActions = {
    getGoogleMapsLink,
    getAppleMapsLink,
    buildMapActionButtons
  };
})();
