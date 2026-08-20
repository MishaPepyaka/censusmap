export function initLogin(): void {
  const form = document.getElementById("login-form") as HTMLFormElement | null;
  const status = document.getElementById("login-status");
  const usernameInput = document.getElementById("username") as HTMLInputElement | null;
  const passwordInput = document.getElementById("password") as HTMLInputElement | null;
  form?.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!status) return;
    status.textContent = "Authenticating...";
    status.classList.remove("landing-status-error");
    try {
      const response = await fetch("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: usernameInput?.value || "", password: passwordInput?.value || "" }) });
      const data = await response.json().catch(() => ({})) as { error?: string };
      if (response.ok) window.location.assign("/");
      else { status.textContent = data.error || "Login failed"; status.classList.add("landing-status-error"); }
    } catch { status.textContent = "Connection error"; status.classList.add("landing-status-error"); }
  });
}
