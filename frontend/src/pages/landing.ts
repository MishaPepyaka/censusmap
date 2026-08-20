import { getJson } from "../shared/api.js";

type LookupResponse = { cld: string };

export function initLanding(): void {
  const form = document.getElementById("lookup-form") as HTMLFormElement | null;
  const input = document.getElementById("lookup-input") as HTMLInputElement | null;
  const status = document.getElementById("lookup-status");

  function setStatus(message: string, isError = false): void {
    if (!status) return;
    status.textContent = message || "";
    status.classList.toggle("landing-status-error", isError);
  }

  async function submitLookup(rawValue: string): Promise<void> {
    const value = String(rawValue || "").trim();
    if (!value) { setStatus("Enter a CLD number.", true); return; }
    setStatus("Resolving...");
    try {
      const result = await getJson<LookupResponse>(`/api/lookup?q=${encodeURIComponent(value)}`);
      window.location.assign(`/${result.cld}`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Lookup failed", true);
    }
  }

  form?.addEventListener("submit", (event) => {
    event.preventDefault();
    void submitLookup(input?.value || "");
  });
}
