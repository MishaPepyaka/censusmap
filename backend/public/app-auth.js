(function(){var e=class extends Error{status;payload;constructor(e,t,n){super(e),this.status=t,this.payload=n,this.name=`ApiError`}};async function t(t,n){let r=await fetch(t,n),i=await r.json().catch(()=>({}));if(!r.ok){let t=typeof i==`object`&&i?i.error??i.message:void 0;throw new e(typeof t==`string`?t:`Request failed`,r.status,i)}return i}async function n(){let e=document.getElementById(`user-widget-root`);if(e)try{let{user:n}=await t(`/api/me`);if(!n)return;let r=n.username.slice(0,2).toUpperCase(),i=!!(n.isAdmin||n.role===`crew_leader`),a=n.isAdmin?`ADMIN`:n.role===`crew_leader`?`CREW LEADER`:`ENUMERATOR`;window.__currentUser=n,e.innerHTML=`
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
    `;let o=document.getElementById(`user-profile-trigger`),s=document.getElementById(`user-profile-dropdown`),c=document.getElementById(`logout-btn`);o?.addEventListener(`click`,e=>{e.stopPropagation(),s?.classList.toggle(`show`)}),document.addEventListener(`click`,()=>s?.classList.remove(`show`)),c?.addEventListener(`click`,async e=>{e.preventDefault(),await fetch(`/api/logout`,{method:`POST`}),window.location.assign(`/login`)})}catch{e.innerHTML=``}}n()})();