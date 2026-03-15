// popup.js — Quick actions + job tracker

function sendMessage(msg) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (resp) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!resp) return reject(new Error('No response'));
      if (!resp.success) return reject(new Error(resp.error));
      resolve(resp.data);
    });
  });
}

function sendToTab(msg) {
  return new Promise(async (resolve, reject) => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) return reject(new Error('No active tab'));
      chrome.tabs.sendMessage(tab.id, msg, (resp) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        resolve(resp);
      });
    } catch (e) { reject(e); }
  });
}

// ─── Quick actions ──────────────────────────────────────────────

document.getElementById('togglePanelBtn').addEventListener('click', async () => {
  try {
    await sendToTab({ type: 'TOGGLE_PANEL' });
  } catch (_) {
    // Content script might not be injected; inject and retry
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content.js']
      });
      await chrome.scripting.insertCSS({
        target: { tabId: tab.id },
        files: ['styles.css']
      });
      setTimeout(() => sendToTab({ type: 'TOGGLE_PANEL' }), 200);
    }
  }
  window.close();
});

document.getElementById('profileBtn').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('profile.html') });
  window.close();
});

document.getElementById('settingsBtn').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('profile.html#settings') });
  window.close();
});

// ─── Status check ───────────────────────────────────────────────

async function checkStatus() {
  const dot = document.getElementById('statusDot');
  const text = document.getElementById('statusText');

  try {
    const settings = await sendMessage({ type: 'GET_SETTINGS' });
    const profile = await sendMessage({ type: 'GET_PROFILE' });

    if (!settings?.apiKey) {
      text.textContent = 'API key not set';
      return;
    }

    if (!profile) {
      text.textContent = 'No resume uploaded';
      return;
    }

    dot.classList.add('connected');
    text.textContent = `Ready — ${profile.name || 'Profile loaded'}`;
  } catch (err) {
    text.textContent = 'Error: ' + err.message;
  }
}

// ─── Job tracker ────────────────────────────────────────────────

async function loadJobs() {
  const list = document.getElementById('jobsList');
  const empty = document.getElementById('emptyState');

  try {
    const jobs = await sendMessage({ type: 'GET_SAVED_JOBS' });

    if (!jobs || jobs.length === 0) {
      empty.style.display = 'block';
      return;
    }

    empty.style.display = 'none';
    list.innerHTML = '';

    jobs.forEach(job => {
      const item = document.createElement('div');
      item.className = 'job-item';

      const scoreClass = job.score >= 70 ? 'score-green' : job.score >= 45 ? 'score-amber' : 'score-red';

      item.innerHTML = `
        <div class="job-score ${scoreClass}">${job.score}</div>
        <div class="job-info">
          <div class="job-title">${escapeHTML(job.title)}</div>
          <div class="job-meta">${escapeHTML(job.company)} &middot; ${job.date}</div>
        </div>
        <button class="job-delete" data-id="${job.id}" title="Delete">&times;</button>
      `;

      // Click to open URL
      item.querySelector('.job-info').addEventListener('click', () => {
        if (job.url) chrome.tabs.create({ url: job.url });
      });

      // Delete
      item.querySelector('.job-delete').addEventListener('click', async (e) => {
        e.stopPropagation();
        await sendMessage({ type: 'DELETE_JOB', jobId: job.id });
        loadJobs();
      });

      list.appendChild(item);
    });
  } catch (err) {
  }
}

function escapeHTML(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

// ─── Handle hash for settings redirect ──────────────────────────

if (window.location.hash === '#settings') {
  // This is for the profile page, not popup
}

// ─── Init ───────────────────────────────────────────────────────

checkStatus();
loadJobs();
