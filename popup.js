const sheetIdInput = document.getElementById('sheetId');
const saveBtn = document.getElementById('saveBtn');
const signInBtn = document.getElementById('signInBtn');
const statusEl = document.getElementById('status');

function showStatus(message, type) {
  statusEl.textContent = message;
  statusEl.className = `status ${type}`;
  setTimeout(() => { statusEl.className = 'status'; }, 4000);
}

// Load saved Sheet ID on open
chrome.runtime.sendMessage({ type: 'GET_SHEET_ID' }, (res) => {
  if (res?.sheetId) sheetIdInput.value = res.sheetId;
});

saveBtn.addEventListener('click', () => {
  const sheetId = sheetIdInput.value.trim();
  if (!sheetId) {
    showStatus('Please enter a Sheet ID.', 'error');
    return;
  }
  chrome.runtime.sendMessage({ type: 'SAVE_SHEET_ID', sheetId }, (res) => {
    if (res?.ok) showStatus('Sheet ID saved!', 'success');
    else showStatus('Failed to save.', 'error');
  });
});

signInBtn.addEventListener('click', () => {
  signInBtn.disabled = true;
  signInBtn.textContent = 'Signing in...';
  chrome.runtime.sendMessage({ type: 'SIGN_IN' }, (res) => {
    signInBtn.disabled = false;
    signInBtn.textContent = 'Sign in with Google';
    if (res?.ok) showStatus('Signed in successfully!', 'success');
    else showStatus(`Sign-in failed: ${res?.error || 'unknown error'}`, 'error');
  });
});
