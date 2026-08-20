(function(){async function e(e,t){let n=await fetch(e,t),r=await n.json().catch(()=>({}));if(!n.ok){let e=typeof r==`object`&&r?r.error??r.message:void 0;throw Error(typeof e==`string`?e:`Request failed`)}return r}async function t(){let t=document.getElementById(`user-widget-root`);if(t)try{let{user:n}=await e(`/api/me`);if(!n)return;let r=n.username.slice(0,2).toUpperCase(),i=!!(n.isAdmin||n.role===`crew_leader`),a=n.isAdmin?`ADMIN`:n.role===`crew_leader`?`CREW LEADER`:`ENUMERATOR`;window.__currentUser=n,t.innerHTML=`
      <div class="user-profile-widget">
        <button class="user-profile-btn" id="user-profile-trigger">
          <span class="user-profile-name">${n.username}</span>
          <div class="user-profile-avatar">${r}</div>
        </button>
        <div class="user-dropdown" id="user-profile-dropdown">
          <div class="user-dropdown-header">
            <span class="user-dropdown-username">${n.username}</span>
            <span class="user-role-pill">${a}</span>
          </div>
          ${i?`<a href="/users" class="user-dropdown-item">Manage Users</a>`:``}
          <a href="/" class="user-dropdown-item">Main Page</a>
          <div class="user-dropdown-divider"></div>
          <a href="#" class="user-dropdown-item" id="logout-btn">Logout</a>
        </div>
      </div>
    `;let o=document.getElementById(`user-profile-trigger`),s=document.getElementById(`user-profile-dropdown`),c=document.getElementById(`logout-btn`);o?.addEventListener(`click`,e=>{e.stopPropagation(),s?.classList.toggle(`show`)}),document.addEventListener(`click`,()=>s?.classList.remove(`show`)),c?.addEventListener(`click`,async e=>{e.preventDefault(),await fetch(`/api/logout`,{method:`POST`}),window.location.assign(`/login`)})}catch{t.innerHTML=``}}t()})();