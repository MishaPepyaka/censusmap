(async function initLanding() {
  const { getJson } = window.CensusMapApi;
  const form = document.getElementById("lookup-form");
  const input = document.getElementById("lookup-input");
  const status = document.getElementById("lookup-status");

  function setStatus(message, isError = false) {
    if (!status) return;
    status.textContent = message || "";
    status.classList.toggle("landing-status-error", Boolean(isError));
  }

  async function submitLookup(rawValue) {
    const value = String(rawValue || "").trim();
    if (!value) {
      setStatus("Enter a CLD number.", true);
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
})();
