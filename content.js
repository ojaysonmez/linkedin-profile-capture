const emailRegex = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;

// ── Scraping ──────────────────────────────────────────────────────────────────

function scrapeCurrentRoles() {
  const roles = [];
  const bodyText = document.body.innerText;

  const expStart = bodyText.indexOf('Experience\n');
  if (expStart === -1) return roles;

  const nextSection = bodyText.search(/\n(Education|Skills|Licenses|Volunteer|Publications|Courses|Projects|Honors|Languages|Organizations|Causes)\n/);
  const expText = bodyText.substring(expStart, nextSection > expStart ? nextSection : expStart + 3000);
  const lines = expText.split('\n').map(l => l.trim()).filter(Boolean);
  const dateLine = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|\d{4})\s+\d{0,4}\s*[-–]\s*Present/i;

  for (let i = 0; i < lines.length; i++) {
    if (!dateLine.test(lines[i])) continue;
    const candidates = [];
    for (let back = 1; back <= 5; back++) {
      const line = lines[i - back] || '';
      if (!line) break;
      if (/^·/.test(line) || /^\d/.test(line)) continue;
      candidates.push(line);
      if (candidates.length === 2) break;
    }
    const company = candidates[0] || '';
    const title = candidates[1] || '';
    if (company) {
      const role = title ? `${title} @ ${company}` : company;
      if (!roles.includes(role)) roles.push(role);
    }
  }
  return roles;
}

function scrapePreviousRoles() {
  const roles = [];
  const bodyText = document.body.innerText;

  const expStart = bodyText.indexOf('Experience\n');
  if (expStart === -1) return roles;

  const nextSection = bodyText.search(/\n(Education|Skills|Licenses|Volunteer|Publications|Courses|Projects|Honors|Languages|Organizations|Causes)\n/);
  const expText = bodyText.substring(expStart, nextSection > expStart ? nextSection : expStart + 3000);
  const lines = expText.split('\n').map(l => l.trim()).filter(Boolean);
  const dateLine = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|\d{4})\s+\d{0,4}\s*[-–]/i;

  for (let i = 0; i < lines.length; i++) {
    if (!dateLine.test(lines[i])) continue;
    if (/Present/i.test(lines[i])) continue; // skip current roles
    const candidates = [];
    for (let back = 1; back <= 5; back++) {
      const line = lines[i - back] || '';
      if (!line) break;
      if (/^·/.test(line) || /^\d/.test(line)) continue;
      candidates.push(line);
      if (candidates.length === 2) break;
    }
    const company = candidates[0] || '';
    const title = candidates[1] || '';
    if (company) {
      const role = title ? `${title} @ ${company}` : company;
      if (!roles.includes(role)) roles.push(role);
    }
  }
  return roles;
}

function scrapeProfileMeta() {
  const name = document.title.replace(/\s*\|.*$/, '').trim();
  const profileUrl = window.location.href.replace(/\/overlay\/.*$/, '').replace(/\/$/, '').split('?')[0];
  const degreeMatch = document.body.innerText.match(/·\s*(1st|2nd|3rd\+?)\s*[\n·]/i);
  const degree = degreeMatch ? degreeMatch[1].trim() : '';
  const bodyText = document.body.innerText;
  const nameIdx = bodyText.indexOf(name);
  const afterName = bodyText.substring(nameIdx + name.length).trimStart();
  const headline = afterName.split('\n').map(l => l.trim()).find(l => l.length > 0 && !l.startsWith('·')) || '';
  return { name, headline, profileUrl, degree };
}

function buildPayload(emails, overlayOpened = false) {
  const { name, headline, profileUrl, degree } = scrapeProfileMeta();
  const roles = scrapeCurrentRoles();
  const titles = roles.map(r => r.includes(' @ ') ? r.split(' @ ')[0] : '').filter(Boolean);
  const companies = roles.map(r => r.includes(' @ ') ? r.split(' @ ')[1] : r).filter(Boolean);
  const prevRoles = scrapePreviousRoles();
  const prevTitles = prevRoles.map(r => r.includes(' @ ') ? r.split(' @ ')[0] : '').filter(Boolean);
  const prevCompanies = prevRoles.map(r => r.includes(' @ ') ? r.split(' @ ')[1] : r).filter(Boolean);
  // null if overlay never opened, '-' if overlay opened but no email, actual email otherwise
  const noEmailValue = (degree && !degree.startsWith('1')) ? 'NC' : '-';
  const emailsToSave = emails.length > 0 ? emails : (overlayOpened ? [noEmailValue] : ['']);
  return { name, headline, profileUrl, degree, emails: emailsToSave, titles, companies, prevTitles, prevCompanies, capturedAt: new Date().toISOString() };
}

function savePayload(payload, silent = false, retries = 4) {
  chrome.runtime.sendMessage({ type: 'PROFILE_CAPTURED', payload }, (res) => {
    if (res?.ok) {
      if (!silent) {
        const msg = payload.emails[0] && payload.emails[0] !== '-'
          ? `Saved — ${payload.emails.join(', ')}`
          : `Saved — ${payload.name} (no email)`;
        showToast(msg, '#1a7a3f');
      }
    } else if (res?.error === 'Save already in progress for this profile' && retries > 0) {
      // Auto-capture and overlay save collided — wait for the lock to clear and retry
      setTimeout(() => savePayload(payload, silent, retries - 1), 800);
    } else if (!silent) {
      showToast(`Save failed: ${res?.error || 'unknown'}`, '#c0392b');
    }
  });
}

// ── Contact info overlay observer ─────────────────────────────────────────────

new MutationObserver((mutations) => {
  for (const mutation of mutations) {
    for (const node of mutation.addedNodes) {
      if (node.nodeType !== Node.ELEMENT_NODE) continue;
      const overlay =
        node.querySelector?.('[data-sdui-screen*="ProfileContactDetailsOverlay"]') ||
        (node.dataset?.sduiScreen?.includes('ProfileContactDetailsOverlay') ? node : null);
      if (!overlay) continue;

      // LinkedIn populates overlay content async after the node is inserted.
      // Retry until email appears or overlay closes.
      let done = false;
      let attempts = 0;

      const doSave = (emails) => {
        done = true;
        const payload = buildPayload(emails, true);
        chrome.storage.local.get(['pendingCommunicated', 'communicatedAt'], (data) => {
          const isRecent = data.communicatedAt && (Date.now() - data.communicatedAt) < 30000;
          if (data.pendingCommunicated && isRecent) {
            payload.communicated = true;
            chrome.storage.local.remove(['pendingCommunicated', 'communicatedAt']);
          }
          savePayload(payload);
        });
        // Banner stays visible until savePayload replaces it with the result
      };

      const extractEmails = () => {
        const found = new Set();
        // 1. Visible text
        (overlay.innerText || '').match(emailRegex)?.forEach(e => found.add(e));
        // 2. mailto: href links (LinkedIn sometimes hides email behind a link)
        overlay.querySelectorAll('a[href^="mailto:"]').forEach(a => {
          const e = a.href.replace(/^mailto:/i, '').split('?')[0].trim();
          if (e && emailRegex.test(e)) found.add(e);
        });
        // 3. data-* attributes and aria labels that may hold the email
        overlay.querySelectorAll('[data-email],[aria-label]').forEach(el => {
          const val = el.dataset.email || el.getAttribute('aria-label') || '';
          (val.match(emailRegex) || []).forEach(e => found.add(e));
        });
        return [...found];
      };

      const tryRead = () => {
        if (done) return;
        attempts++;
        const emails = extractEmails();
        console.log(`[LI-Capture] overlay attempt ${attempts}: found ${emails.length} email(s)`, emails);
        if (emails.length > 0) {
          doSave(emails);
        } else if (!document.body.contains(overlay)) {
          doSave([]);
        } else if (attempts >= 10) {
          // 5s max wait — log what the overlay contained so we can debug
          console.warn('[LI-Capture] No email found after 10 attempts. Overlay text:', overlay.innerText?.slice(0, 500));
          doSave([]);
        } else {
          setTimeout(tryRead, 500);
        }
      };

      showToast('Reading contact info…', '#555');
      tryRead();
    }
  }
}).observe(document.body, { childList: true, subtree: true });

// ── Messaging ─────────────────────────────────────────────────────────────────

if (window.location.href.includes('/messaging/')) {
  const profileUrlMap = new Map(); // name -> profileUrl, loaded from sheet at scan start
  let scanList = null;

  function setDotColor(li, hasProfile) {
    const dot = li.querySelector('.li-capture-pitched');
    if (dot) dot.style.background = hasProfile ? '#0a66c2' : 'orange';
  }

  function markPitched(li, hasProfile) {
    const existing = li.querySelector('.li-capture-pitched');
    if (existing) { existing.style.background = hasProfile ? '#0a66c2' : 'orange'; return; }
    li.style.position = 'relative';
    const dot = document.createElement('div');
    dot.className = 'li-capture-pitched';
    Object.assign(dot.style, {
      position: 'absolute', bottom: '6px', right: '8px',
      width: '14px', height: '14px', borderRadius: '50%',
      background: hasProfile ? '#0a66c2' : 'orange',
      border: '2px solid #fff', zIndex: '99999', pointerEvents: 'none',
    });
    li.appendChild(dot);
  }

  function updateDotForName(name) {
    if (!scanList) return;
    const hasProfile = !!(profileUrlMap.get(name));
    scanList.querySelectorAll('li.msg-conversation-listitem').forEach(li => {
      const nameEl = li.querySelector('h3.msg-conversation-listitem__participant-names span.truncate');
      if (nameEl && nameEl.textContent.trim() === name) setDotColor(li, hasProfile);
    });
  }

  // Click handler: communicated flag + capture name from sidebar card OR thread H2
  document.addEventListener('click', (e) => {
    const link = e.target.closest('a[href*="/in/"]');
    if (link) chrome.storage.local.set({ pendingCommunicated: true, communicatedAt: Date.now() });

    // Sidebar conversation card click
    const li = e.target.closest('li.msg-conversation-listitem');
    if (li) {
      const nameEl = li.querySelector('h3.msg-conversation-listitem__participant-names span.truncate');
      const name = nameEl ? nameEl.textContent.trim() : '';
      if (name) chrome.storage.local.set({ pendingMessagingName: name });
    }

    // Thread header H2 click — optimistically turn dot blue; profile page will save the real URL
    const h2 = e.target.closest('h2.msg-entity-lockup__entity-title');
    if (h2) {
      const name = h2.textContent.trim();
      if (!name) return;
      chrome.storage.local.set({ pendingMessagingName: name });
      // Immediate visual feedback — profile page will write the resolved URL to the sheet
      profileUrlMap.set(name, 'pending');
      updateDotForName(name);
    }
  }, true);

  // (URL changes handled below — profile page saves the resolved URL to the sheet)

  // Scan conversation list
  function startContactScan(list) {
    scanList = list;
    // Persistent cache keyed by name — loaded from Messages sheet on start
    // { snippet, pitched } — pitched is sticky (never goes 1→0)
    const messagingCache = new Map();

    const pitchPrefixes = (self.LI_CAPTURE_CONFIG && self.LI_CAPTURE_CONFIG.pitchPrefixes) || [];

    function harvest() {
      list.querySelectorAll('li.msg-conversation-listitem:not(.msg-conversation-card--occluded)').forEach(li => {
        const el = li.querySelector('h3.msg-conversation-listitem__participant-names span.truncate');
        if (!el) return;
        const name = el.textContent.trim();
        if (!name) return;

        const snippetEl = li.querySelector('p.msg-conversation-card__message-snippet');
        const snippet = snippetEl ? snippetEl.textContent.trim().replace(/\s+/g, ' ') : '';

        const cached = messagingCache.get(name);
        // Pitched is sticky — once set to true, never cleared even if snippet changes
        const currentlyPitched = pitchPrefixes.some(p => snippet.startsWith(p));
        const pitched = currentlyPitched || (cached?.pitched || false);

        // Always re-evaluate dot — snippet may have changed since last seen
        const existingDot = li.querySelector('.li-capture-pitched');
        if (pitched) {
          markPitched(li, !!(profileUrlMap.get(name)));
        } else if (existingDot) {
          existingDot.remove();
        }

        // Skip if snippet unchanged (thread not updated since last capture)
        if (cached && cached.snippet === snippet) return;

        // New thread or snippet changed — update cache optimistically to block duplicates
        messagingCache.set(name, { snippet, pitched });

        console.log(`[LI-Capture] ${cached ? 'UPDATED' : 'NEW'} | ${name} | Pitched: ${pitched ? 'Yes' : 'No'} | ${snippet.slice(0, 80)}`);
        chrome.runtime.sendMessage({ type: 'SAVE_MESSAGING_CONTACT', payload: { name, snippet, pitched } }, () => {});
      });
    }

    // Load profile URLs AND Messages cache before starting scan
    chrome.runtime.sendMessage({ type: 'GET_MESSAGING_CONTACTS' }, (res) => {
      if (res?.contacts) {
        res.contacts.forEach(({ name, profileUrl }) => { if (name) profileUrlMap.set(name, profileUrl); });
      }
      chrome.runtime.sendMessage({ type: 'GET_MESSAGES_CACHE' }, (cacheRes) => {
        if (cacheRes?.messages) {
          cacheRes.messages.forEach(({ name, snippet, pitched }) => {
            if (name) messagingCache.set(name, { snippet, pitched });
          });
        }
        const mo = new MutationObserver(harvest);
        mo.observe(list, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
        harvest();
      });
    });
  }

  const waitForList = setInterval(() => {
    const list = document.querySelector('ul.msg-conversations-container__conversations-list');
    if (list) { clearInterval(waitForList); startContactScan(list); }
  }, 500);
}

// ── Auto-capture on profile visit ─────────────────────────────────────────────

let lastAutoUrl = '';
let autoCaptureTimer = null;

function tryAutoCapture() {
  const url = window.location.href.replace(/\/overlay\/.*$/, '').replace(/\/$/, '').split('?')[0];
  if (!url.includes('/in/') || url === lastAutoUrl) return;
  lastAutoUrl = url;

  if (autoCaptureTimer) clearTimeout(autoCaptureTimer);

  autoCaptureTimer = setTimeout(() => {
    autoCaptureTimer = null;

    chrome.storage.local.get(['autoCapture', 'pendingCommunicated', 'communicatedAt'], (data) => {
      const isRecent = data.communicatedAt && (Date.now() - data.communicatedAt) < 30000;
      const wasCommunicated = data.pendingCommunicated && isRecent;

      if (wasCommunicated) {
        chrome.storage.local.remove(['pendingCommunicated', 'communicatedAt']);
      }

      // Always update communicated status regardless of auto-capture toggle
      if (wasCommunicated) {
        const payload = buildPayload([], false);
        if (payload.name && payload.name !== 'LinkedIn') {
          payload.communicated = true;
          savePayload(payload, true);
          return;
        }
      }

      // Auto-capture (save full profile) only if toggle is ON
      if (!data.autoCapture) return;
      const payload = buildPayload([], false);
      if (!payload.name || payload.name === 'LinkedIn') return;
      savePayload(payload, true);
    });
  }, 2000);
}


function checkPendingMessagingName() {
  const url = window.location.href.replace(/\/overlay\/.*$/, '').replace(/\/$/, '').split('?')[0];
  if (!url.includes('/in/')) return;
  // Skip ACoAAA tracking URLs — wait for the redirect to the real /in/username URL
  if (/\/in\/ACo/i.test(url)) return;
  chrome.storage.local.get('pendingMessagingName', ({ pendingMessagingName }) => {
    if (!pendingMessagingName) return;
    chrome.storage.local.remove('pendingMessagingName');
    chrome.runtime.sendMessage({
      type: 'UPDATE_MESSAGING_PROFILE_URL',
      payload: { name: pendingMessagingName, profileUrl: url }
    }, () => {});
  });
}

// Detect LinkedIn SPA navigation via URL changes
let currentUrl = window.location.href;
new MutationObserver(() => {
  if (window.location.href !== currentUrl) {
    currentUrl = window.location.href;
    tryAutoCapture();
    checkPendingMessagingName();
  }
}).observe(document.body, { childList: true, subtree: true });

// Also run on initial page load
tryAutoCapture();
checkPendingMessagingName();

// ── Toggle UI ─────────────────────────────────────────────────────────────────

function createToggle() {
  if (document.getElementById('li-capture-toggle-wrap')) return;

  const wrap = document.createElement('div');
  wrap.id = 'li-capture-toggle-wrap';
  Object.assign(wrap.style, {
    position: 'fixed',
    bottom: '72px',
    right: '20px',
    zIndex: '99999',
    background: '#fff',
    border: '1px solid #d0d0d0',
    borderRadius: '12px',
    padding: '10px 14px',
    boxShadow: '0 4px 16px rgba(0,0,0,0.15)',
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    fontSize: '13px',
    color: '#1a1a1a',
    cursor: 'default',
    userSelect: 'none',
    minWidth: '160px',
  });

  const label = document.createElement('span');
  label.textContent = 'Auto Capture';
  label.style.fontWeight = '600';

  const toggleTrack = document.createElement('div');
  toggleTrack.id = 'li-toggle-track';
  Object.assign(toggleTrack.style, {
    width: '40px',
    height: '22px',
    borderRadius: '11px',
    background: '#ccc',
    position: 'relative',
    cursor: 'pointer',
    transition: 'background 0.2s',
    flexShrink: '0',
  });

  const toggleThumb = document.createElement('div');
  Object.assign(toggleThumb.style, {
    width: '18px',
    height: '18px',
    borderRadius: '50%',
    background: '#fff',
    position: 'absolute',
    top: '2px',
    left: '2px',
    transition: 'left 0.2s',
    boxShadow: '0 1px 4px rgba(0,0,0,0.2)',
  });
  toggleTrack.appendChild(toggleThumb);

  const status = document.createElement('span');
  status.id = 'li-toggle-status';
  status.style.fontSize = '11px';
  status.style.color = '#888';

  function setToggleState(on) {
    toggleTrack.style.background = on ? '#0a66c2' : '#ccc';
    toggleThumb.style.left = on ? '20px' : '2px';
    status.textContent = on ? 'ON' : 'OFF';
    status.style.color = on ? '#0a66c2' : '#888';
    chrome.storage.local.set({ autoCapture: on });
  }

  // Load saved state
  chrome.storage.local.get('autoCapture', ({ autoCapture }) => {
    setToggleState(!!autoCapture);
  });

  toggleTrack.addEventListener('click', () => {
    chrome.storage.local.get('autoCapture', ({ autoCapture }) => {
      setToggleState(!autoCapture);
    });
  });

  wrap.appendChild(label);
  wrap.appendChild(toggleTrack);
  wrap.appendChild(status);
  document.body.appendChild(wrap);
}

// Wait for body to be ready then inject toggle
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', createToggle);
} else {
  createToggle();
}

// ── Toast ─────────────────────────────────────────────────────────────────────

function showToast(message, color = '#0a66c2') {
  let toast = document.getElementById('li-capture-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'li-capture-toast';
    Object.assign(toast.style, {
      position: 'fixed',
      top: '16px',
      left: '16px',
      color: '#fff',
      padding: '16px 28px',
      borderRadius: '12px',
      fontSize: '16px',
      fontWeight: '700',
      zIndex: '2147483647',
      boxShadow: '0 8px 28px rgba(0,0,0,0.5)',
      maxWidth: '400px',
      lineHeight: '1.4',
    });
    document.body.appendChild(toast);
  }

  toast.innerText = message;
  toast.style.background = color;
  toast.style.opacity = '1';
}
