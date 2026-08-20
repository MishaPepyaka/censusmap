const SHARE_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15V3m0 0 4 4m-4-4-4 4M5 10.5v7.75A1.75 1.75 0 0 0 6.75 20h10.5A1.75 1.75 0 0 0 19 18.25V10.5"/></svg>`;

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function getGoogleMapsLink(lat: number, lng: number): string {
  return `https://www.google.com/maps?q=${lat.toFixed(6)},${lng.toFixed(6)}`;
}

export function getAppleMapsLink(lat: number, lng: number): string {
  return `https://maps.apple.com/?ll=${lat.toFixed(6)},${lng.toFixed(6)}&q=${lat.toFixed(6)},${lng.toFixed(6)}`;
}

export function buildMapActionButtons(lat: number, lng: number, shareTitle: string, inline = false, shareUrl = window.location.href): string {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return "";
  const googleUrl = getGoogleMapsLink(lat, lng);
  const appleUrl = getAppleMapsLink(lat, lng);
  return [
    `<div class="dw-popup-actions${inline ? " dw-popup-actions-inline" : ""}">`,
    `<button type="button" class="dw-action-btn dw-action-icon dw-action-share" data-title="${escapeHtml(shareTitle)}" data-share-url="${escapeHtml(shareUrl)}" aria-label="Copy page link" title="Copy page link">${SHARE_ICON}</button>`,
    `<a class="dw-action-btn dw-action-icon dw-action-google" href="${escapeHtml(googleUrl)}" target="_blank" rel="noreferrer" aria-label="Open in Google Maps" title="Open in Google Maps"><img src="/map-action-icons/google-maps.png" alt=""></a>`,
    `<a class="dw-action-btn dw-action-icon dw-action-apple" href="${escapeHtml(appleUrl)}" target="_blank" rel="noreferrer" aria-label="Open in Apple Maps" title="Open in Apple Maps"><img src="/map-action-icons/apple-maps.png" alt=""></a>`,
    "</div>"
  ].join("");
}

async function copyShareLink(shareButton: HTMLElement): Promise<void> {
  const url = new URL(shareButton.getAttribute("data-share-url") || window.location.href, window.location.origin).href;
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
    const popup = shareButton.closest(".dw-popup") || shareButton.parentElement;
    let copyStatus = popup?.querySelector<HTMLElement>(".dw-popup-share-status");
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
    shareButton.classList.add("is-copied");
    shareButton.title = "Link copied";
    window.setTimeout(() => {
      if (copyStatus) copyStatus.hidden = true;
      shareButton.classList.remove("is-copied");
      shareButton.title = "Copy page link";
    }, 1200);
  } catch {
    window.prompt("Copy link:", url);
  }
}

export function installMapActionHandlers(): void {
  if (document.documentElement.dataset.mapActionsInstalled === "true") return;
  document.documentElement.dataset.mapActionsInstalled = "true";
  document.addEventListener("click", (event) => {
    const shareButton = event.target instanceof Element ? event.target.closest<HTMLElement>(".dw-action-share") : null;
    if (!shareButton) return;
    event.preventDefault();
    void copyShareLink(shareButton);
  });
}
