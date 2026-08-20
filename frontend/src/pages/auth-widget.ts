import { getJson } from "../shared/api.js";

type CurrentUser = { username: string; isAdmin?: boolean; role?: string };

declare global { interface Window { __currentUser?: CurrentUser; } }

export async function initAuthWidget(): Promise<void> {
  const root = document.getElementById("user-widget-root");
  if (!root) return;
  try {
    const { user } = await getJson<{ user?: CurrentUser }>("/api/me");
    if (!user) return;
    const initials = user.username.slice(0, 2).toUpperCase();
    const canManageUsers = Boolean(user.isAdmin || user.role === "crew_leader");
    const roleLabel = user.isAdmin ? "ADMIN" : (user.role === "crew_leader" ? "CREW LEADER" : "ENUMERATOR");
    window.__currentUser = user;
    root.innerHTML = `
      <div class="user-profile-widget">
        <button class="user-profile-btn" id="user-profile-trigger">
          <span class="user-profile-name">${user.username}</span>
          <div class="user-profile-avatar">${initials}</div>
        </button>
        <div class="user-dropdown" id="user-profile-dropdown">
          <div class="user-dropdown-header">
            <span class="user-dropdown-username">${user.username}</span>
            <span class="user-role-pill">${roleLabel}</span>
          </div>
          ${canManageUsers ? '<a href="/users" class="user-dropdown-item">Manage Users</a>' : ""}
          <a href="/" class="user-dropdown-item">Main Page</a>
          <div class="user-dropdown-divider"></div>
          <a href="#" class="user-dropdown-item" id="logout-btn">Logout</a>
        </div>
      </div>
    `;
    const trigger = document.getElementById("user-profile-trigger");
    const dropdown = document.getElementById("user-profile-dropdown");
    const logoutButton = document.getElementById("logout-btn");
    trigger?.addEventListener("click", (event) => { event.stopPropagation(); dropdown?.classList.toggle("show"); });
    document.addEventListener("click", () => dropdown?.classList.remove("show"));
    logoutButton?.addEventListener("click", async (event) => {
      event.preventDefault();
      await fetch("/api/logout", { method: "POST" });
      window.location.assign("/login");
    });
  } catch {
    root.innerHTML = "";
  }
}
