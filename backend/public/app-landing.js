(async function initLanding() {
  const form = document.getElementById("lookup-form");
  const input = document.getElementById("lookup-input");
  const status = document.getElementById("lookup-status");

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
async function checkAdmin() {
  try {
    const data = await getJson('/api/config');
    document.getElementById('admin-link-container').style.display = 'flex';
    document.getElementById('admin-link-container').style.justifyContent = 'center';
    if (!data.auth?.isAdmin) {
      // Hide manage users if not admin, but keep container for logout
      document.querySelector('a[href="/users"]').style.display = 'none';
      document.querySelector('span[style*="color: #334155"]').style.display = 'none';
    }
  } catch {
    // Ignore config load error.
  }
}

document.getElementById('logout-link')?.addEventListener('click', async (e) => {
  e.preventDefault();
  await fetch('/api/logout', { method: 'POST' });
  window.location.assign('/login');
});

form?.addEventListener("submit", async (event) => {
...
    event.preventDefault();
    await submitLookup(input?.value || "");
  });

  await checkAdmin();
})();
