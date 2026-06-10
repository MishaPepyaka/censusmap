(async function initAuthWidget() {
  const root = document.getElementById('user-widget-root');
  if (!root) return;

  async function getJson(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error('Not logged in');
    return res.json();
  }

  try {
    const { user } = await getJson('/api/me');
    if (!user) return;

    const initials = user.username.slice(0, 2).toUpperCase();
    const canManageUsers = Boolean(user.isAdmin || user.role === 'crew_leader');
    const roleLabel = user.isAdmin ? 'ADMIN' : (user.role === 'crew_leader' ? 'CREW LEADER' : 'ENUMERATOR');
    window.__currentUser = user;
    
    root.innerHTML = `
      <div class="user-profile-widget">
        <button class="user-profile-btn" id="user-profile-trigger">
          <span class="user-profile-name">${user.username}</span>
          <div class="user-profile-avatar">${initials}</div>
        </button>
        <div class="user-dropdown" id="user-profile-dropdown">
          <div class="user-dropdown-item" style="font-weight: 700; color: #f8fafc; border-bottom: 1px solid rgba(148,163,184,0.1); border-radius: 0; padding-bottom: 12px; margin-bottom: 4px;">
            ${user.username} <span style="font-size: 10px; background: #3b82f6; padding: 2px 5px; border-radius: 4px; margin-left: 5px;">${roleLabel}</span>
          </div>
          ${canManageUsers ? '<a href="/users" class="user-dropdown-item">Manage Users</a>' : ''}
          <a href="/" class="user-dropdown-item">Main Page</a>
          <div class="user-dropdown-divider"></div>
          <a href="#" class="user-dropdown-item" id="logout-btn">Logout</a>
        </div>
      </div>
    `;

    const trigger = document.getElementById('user-profile-trigger');
    const dropdown = document.getElementById('user-profile-dropdown');
    const logoutBtn = document.getElementById('logout-btn');

    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      dropdown.classList.toggle('show');
    });

    document.addEventListener('click', () => {
      dropdown.classList.remove('show');
    });

    logoutBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      await fetch('/api/logout', { method: 'POST' });
      window.location.assign('/login');
    });

  } catch (err) {
    // Not logged in or error, usually handled by redirect but we hide widget
    root.innerHTML = '';
  }
})();
