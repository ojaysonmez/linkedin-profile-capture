const SHEET_ID_KEY = 'sheetId';
const savingInProgress = new Set();         // keyed by profileUrl
const messagingSavingInProgress = new Set(); // keyed by name

// Inject content script into any already-open LinkedIn tabs on install/update
chrome.runtime.onInstalled.addListener(async () => {
  const tabs = await chrome.tabs.query({ url: '*://*.linkedin.com/in/*' });
  for (const tab of tabs) {
    chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content.js']
    }).catch(() => {});
  }
});

// ── Auth ──────────────────────────────────────────────────────────────────────

async function getAuthToken(interactive = false) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, (token) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(token);
    });
  });
}

// ── Google Sheets helpers ─────────────────────────────────────────────────────

// Cache sheet title per spreadsheet ID within this service-worker lifetime
const sheetTitleCache = {};
// Cache whether headers have been written — avoids an extra API call on every save
const headersEnsured = new Set();

async function getProfileSheetTitle(spreadsheetId, token) {
  if (sheetTitleCache[spreadsheetId]) return sheetTitleCache[spreadsheetId];
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets.properties`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const meta = await res.json();
  const title = meta.sheets?.[0]?.properties?.title || 'Sheet1';
  sheetTitleCache[spreadsheetId] = title;
  return title;
}

async function ensureSheetHeaders(sheetId, token) {
  if (headersEnsured.has(sheetId)) return; // already confirmed this session
  const sheet = await getProfileSheetTitle(sheetId, token);
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(sheet)}!A1`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const data = await res.json();
  if (data.values && data.values.length > 0) {
    headersEnsured.add(sheetId);
    return;
  }
  // C-G (indices 2-6) are reserved for user — leave blank in header
  await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(sheet)}!A1:R1?valueInputOption=RAW`,
    {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        values: [['Profile URL', 'Captured At', 'Email(s)', '', '', '', '', '', '', 'Name', 'Headline', 'Connection', 'Current Titles', 'Current Companies', 'Previous Titles', 'Previous Companies', 'Last Message', 'Pitched', 'Msg Name-Date']]
      })
    }
  );
  headersEnsured.add(sheetId);
}

async function upsertRow(sheetId, token, payload) {
  const { name, headline, emails, titles, companies, prevTitles, prevCompanies, profileUrl, degree, capturedAt } = payload;
  const sheet = await getProfileSheetTitle(sheetId, token);

  // Read full row A:S to preserve user cols D-I (indices 3-8) and messaging cols Q-S (indices 16-18)
  const readRes = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(sheet)}!A:S`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const rows = (await readRes.json()).values || [];
  // A=Profile URL (0), B=Captured At (1), C=Email (2), D-I=user cols (3-8), J=Name (9),
  // K=Headline (10), L=Connection (11), M=Current Titles (12), N=Current Companies (13),
  // O=Prev Titles (14), P=Prev Companies (15), Q=Last Message (16), R=Pitched (17), S=Msg Name-Date (18)
  const existingRowIndex = rows.findIndex((r, i) => i > 0 && r[0] === profileUrl);

  const existingEmail = existingRowIndex !== -1 ? (rows[existingRowIndex][2] || '') : '';
  const emailValue = emails.join(', ') || existingEmail;

  if (existingRowIndex !== -1) {
    const existing = rows[existingRowIndex];
    const row = [
      profileUrl, capturedAt,
      emailValue,
      existing[3] || '', existing[4] || '', existing[5] || '', existing[6] || '', existing[7] || '', existing[8] || '', // preserve D-I
      name, headline || '', degree || '',
      titles.join(', '), companies.join(', '),
      (prevTitles || []).join(', '), (prevCompanies || []).join(', '),
      existing[16] || '', existing[17] || '', existing[18] || '', // preserve Q-S messaging
    ];
    const sheetRow = existingRowIndex + 1;
    const updateRes = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(sheet)}!A${sheetRow}:S${sheetRow}?valueInputOption=USER_ENTERED`,
      {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: [row] })
      }
    );
    if (!updateRes.ok) {
      const err = await updateRes.json();
      throw new Error(err.error?.message || 'Sheets update error');
    }
  } else {
    // New row — D-I left empty for user, Q-S messaging left empty
    const row = [profileUrl, capturedAt, emailValue, '', '', '', '', '', '', name, headline || '', degree || '', titles.join(', '), companies.join(', '), (prevTitles || []).join(', '), (prevCompanies || []).join(', '), '', '', ''];
    const appendRes = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(sheet)}!A1:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: [row] })
      }
    );
    if (!appendRes.ok) {
      const err = await appendRes.json();
      throw new Error(err.error?.message || 'Sheets append error');
    }
  }
}

// ── Messages sheet (persistent thread cache: A=Name, B=Last Message, C=Pitched) ──

async function ensureMessagesTab(sheetId, token) {
  const metaRes = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}?fields=sheets.properties.title`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const meta = await metaRes.json();
  const exists = (meta.sheets || []).some(s => s.properties.title === 'Messages');
  if (exists) return;
  // Create tab and write header in one go
  await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}:batchUpdate`,
    { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ requests: [{ addSheet: { properties: { title: 'Messages' } } }] }) }
  );
  await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/Messages!A1:D1?valueInputOption=RAW`,
    { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: [['Name', 'Last Message', 'Pitched', 'Last Updated']] }) }
  );
}

async function upsertMessagesSheet(sheetId, token, { name, snippet, pitched }) {
  await ensureMessagesTab(sheetId, token);
  const pitchedVal = pitched ? '1' : '0';
  const now = new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });

  // Read A:C to get name (match key) and existing pitched (sticky logic); D not needed in memory
  const readRes = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/Messages!A:C`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const rows = (await readRes.json()).values || [];
  const existingIdx = rows.findIndex((r, i) => i > 0 && r[0] === name);

  if (existingIdx !== -1) {
    const sheetRow = existingIdx + 1;
    // Pitched is sticky — never goes 1→0
    const existingPitched = rows[existingIdx][2] || '0';
    const finalPitched = existingPitched === '1' ? '1' : pitchedVal;
    const res = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/Messages!B${sheetRow}:D${sheetRow}?valueInputOption=RAW`,
      { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: [[snippet, finalPitched, now]] }) }
    );
    if (!res.ok) { const e = await res.json(); throw new Error(e.error?.message || 'Messages update failed'); }
  } else {
    const res = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/Messages!A1:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
      { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: [[name, snippet, pitchedVal, now]] }) }
    );
    if (!res.ok) { const e = await res.json(); throw new Error(e.error?.message || 'Messages append failed'); }
  }
}

// ── Messaging columns in profile sheet (Q=Last Message, R=Pitched, S=Msg Name-Date) ──

async function upsertMessagingColumns(sheetId, token, { name, snippet, pitched }) {
  const sheet = await getProfileSheetTitle(sheetId, token);
  const date = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const nameDate = `${name} - ${date}`;
  const pitchedVal = pitched ? '1' : '0';

  // Name is col J (index 9) — read A:J to match by name
  const readRes = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(sheet)}!A:J`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const rows = (await readRes.json()).values || [];
  const existingIdx = rows.findIndex((r, i) => i > 0 && r[9] === name);

  if (existingIdx !== -1) {
    const sheetRow = existingIdx + 1;
    // Q=Last Message, R=Pitched, S=Msg Name-Date
    await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(sheet)}!Q${sheetRow}:S${sheetRow}?valueInputOption=USER_ENTERED`,
      {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: [[snippet, pitchedVal, nameDate]] })
      }
    );
  } else {
    // No profile row yet — J=name, Q/R/S=messaging, rest empty (19 cols A:S)
    const row = ['', '', '', '', '', '', '', '', '', name, '', '', '', '', '', '', snippet, pitchedVal, nameDate];
    await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(sheet)}!A1:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: [row] })
      }
    );
  }
}

// ── Single unified message handler ───────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const { type } = message;

  if (type === 'PROFILE_CAPTURED') {
    (async () => {
      try {
        const { sheetId } = await chrome.storage.local.get(SHEET_ID_KEY);
        if (!sheetId) {
          sendResponse({ ok: false, error: 'No sheet ID configured' });
          return;
        }
        const { profileUrl } = message.payload;
        if (savingInProgress.has(profileUrl)) {
          sendResponse({ ok: false, error: 'Save already in progress for this profile' });
          return;
        }
        savingInProgress.add(profileUrl);
        try {
          const token = await getAuthToken(false);
          await ensureSheetHeaders(sheetId, token);
          await upsertRow(sheetId, token, message.payload);
          sendResponse({ ok: true });
        } finally {
          savingInProgress.delete(profileUrl);
        }
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }

  if (type === 'SAVE_SHEET_ID') {
    chrome.storage.local.set({ sheetId: message.sheetId }, () => {
      sendResponse({ ok: true });
    });
    return true;
  }

  if (type === 'GET_SHEET_ID') {
    chrome.storage.local.get(SHEET_ID_KEY, (data) => {
      sendResponse({ sheetId: data.sheetId || '' });
    });
    return true;
  }

  if (type === 'SAVE_MESSAGING_CONTACT') {
    (async () => {
      const { name } = message.payload;
      if (messagingSavingInProgress.has(name)) { sendResponse({ ok: false, error: 'duplicate' }); return; }
      messagingSavingInProgress.add(name);
      try {
        const { sheetId } = await chrome.storage.local.get(SHEET_ID_KEY);
        if (!sheetId) { sendResponse({ ok: false, error: 'No sheet ID' }); return; }
        const token = await getAuthToken(false);
        // Run both writes independently — don't let one failure suppress the other
        const [msgResult, profResult] = await Promise.allSettled([
          upsertMessagesSheet(sheetId, token, message.payload),
          upsertMessagingColumns(sheetId, token, message.payload),
        ]);
        if (msgResult.status === 'rejected') console.error('[LI-Capture] Messages sheet write failed:', msgResult.reason);
        if (profResult.status === 'rejected') console.error('[LI-Capture] Profiles sheet write failed:', profResult.reason);
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      } finally {
        messagingSavingInProgress.delete(name);
      }
    })();
    return true;
  }

  if (type === 'GET_MESSAGES_CACHE') {
    (async () => {
      try {
        const { sheetId } = await chrome.storage.local.get(SHEET_ID_KEY);
        if (!sheetId) { sendResponse({ ok: true, messages: [] }); return; }
        const token = await getAuthToken(false);
        const readRes = await fetch(
          `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/Messages!A:C`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        const rows = (await readRes.json()).values || [];
        // A=Name, B=Last Message, C=Pitched
        const messages = rows.slice(1).map(r => ({
          name: r[0] || '',
          snippet: r[1] || '',
          pitched: r[2] === '1',
        })).filter(m => m.name);
        sendResponse({ ok: true, messages });
      } catch (err) {
        sendResponse({ ok: true, messages: [], error: err.message });
      }
    })();
    return true;
  }

  if (type === 'GET_MESSAGING_CONTACTS') {
    (async () => {
      try {
        const { sheetId } = await chrome.storage.local.get(SHEET_ID_KEY);
        if (!sheetId) { sendResponse({ ok: false, contacts: [] }); return; }
        const token = await getAuthToken(false);
        const sheet = await getProfileSheetTitle(sheetId, token);
        // A=Profile URL (index 0), J=Name (index 9)
        const readRes = await fetch(
          `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(sheet)}!A:J`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        const rows = (await readRes.json()).values || [];
        const contacts = rows.slice(1).map(r => ({ name: r[9] || '', profileUrl: r[0] || '' }));
        sendResponse({ ok: true, contacts });
      } catch (err) {
        sendResponse({ ok: false, contacts: [], error: err.message });
      }
    })();
    return true;
  }

  if (type === 'UPDATE_MESSAGING_PROFILE_URL') {
    (async () => {
      try {
        const { sheetId } = await chrome.storage.local.get(SHEET_ID_KEY);
        if (!sheetId) { sendResponse({ ok: false }); return; }
        const token = await getAuthToken(false);
        const sheet = await getProfileSheetTitle(sheetId, token);
        // Name is col J (index 9), profileUrl goes into col A (index 0)
        const readRes = await fetch(
          `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(sheet)}!A:J`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        const rows = (await readRes.json()).values || [];
        const existingIdx = rows.findIndex((r, i) => i > 0 && r[9] === message.payload.name);
        if (existingIdx !== -1) {
          const sheetRow = existingIdx + 1;
          await fetch(
            `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(sheet)}!A${sheetRow}?valueInputOption=RAW`,
            {
              method: 'PUT',
              headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ values: [[message.payload.profileUrl]] })
            }
          );
        }
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }

  if (type === 'SIGN_IN') {
    getAuthToken(true)
      .then(() => sendResponse({ ok: true }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }
});
