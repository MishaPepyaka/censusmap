(async function initLanding() {
  const form = document.getElementById("lookup-form");
  const input = document.getElementById("lookup-input");
  const status = document.getElementById("lookup-status");
  const list = document.getElementById("region-list");

  function setStatus(message, isError = false) {
    if (!status) return;
    status.textContent = message || "";
    status.classList.toggle("landing-status-error", Boolean(isError));
  }

  async function getJson(url, options) {
    const response = await fetch(url, options);
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || payload.message || "Request failed");
    }
    return payload;
  }

  function renderRegionList(regions) {
    if (!list) return;
    if (!Array.isArray(regions) || regions.length === 0) {
      list.innerHTML = '<div class="landing-list-empty">No CLD folders found yet.</div>';
      return;
    }
    list.innerHTML = regions
      .map((region) => {
        const ssidText = Array.isArray(region.ssids) && region.ssids.length > 0
          ? `SSID: ${region.ssids.join(", ")}`
          : "No SSID metadata yet";
        return [
          `<a class="landing-region-link" href="/${region.cld}">`,
          `<span class="landing-region-code">${region.cld}</span>`,
          `<span class="landing-region-label">${region.label || `CLD ${region.cld}`}</span>`,
          `<span class="landing-region-meta">${ssidText}</span>`,
          `</a>`
        ].join("");
      })
      .join("");
  }

  async function submitLookup(rawValue) {
    const value = String(rawValue || "").trim();
    if (!value) {
      setStatus("Enter a CLD number or SSID.", true);
      return;
    }
    setStatus("Resolving...");
    try {
      const result = await getJson(`/api/lookup?q=${encodeURIComponent(value)}`);
      window.location.assign(`/${result.cld}`);
    } catch (error) {
      setStatus(error.message, true);
    }
  }

  form?.addEventListener("submit", async (event) => {
    event.preventDefault();
    await submitLookup(input?.value || "");
  });

  try {
    const data = await getJson("/api/regions");
    renderRegionList(data.regions || []);
  } catch (error) {
    renderRegionList([]);
    setStatus(`Region list failed: ${error.message}`, true);
  }
})();
