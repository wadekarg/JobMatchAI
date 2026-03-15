/**
 * popup.js
 *
 * Script for the extension popup — the small window that appears when the user
 * clicks the JobMatchAI toolbar icon in Chrome.
 *
 * Responsibilities:
 *   - Displays quick-action buttons: toggle the in-page panel, open the profile
 *     editor, and open the settings page.
 *   - Runs a status check on load to verify the API key and resume are configured,
 *     showing a green/red indicator dot.
 *   - Renders the saved/applied jobs list with match scores, company info, and
 *     links back to each job posting. Allows individual jobs to be deleted.
 *
 * Communication model:
 *   - sendMessage()  → talks to background.js via chrome.runtime.sendMessage
 *   - sendToTab()    → talks to the content script on the active tab via
 *                      chrome.tabs.sendMessage (injects the content script first
 *                      if it hasn't been injected yet)
 */

// ─── Messaging helpers ────────────────────────────────────────────────────────

/**
 * Sends a message to the extension's background service worker (background.js)
 * and returns a Promise that resolves with the response data payload.
 *
 * The background script is expected to reply with the shape:
 *   { success: true,  data: <any> }   on success
 *   { success: false, error: <string> } on failure
 *
 * @param {Object} msg - The message object to send (must have at least a `type` key).
 * @returns {Promise<any>} Resolves with resp.data, or rejects with an Error.
 */
function sendMessage(msg) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (resp) => {
      // chrome.runtime.lastError is set when the background script is unreachable
      // (e.g., service worker not yet started, or extension reloading).
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));

      // A null/undefined response means the background didn't call sendResponse()
      if (!resp) return reject(new Error('No response'));

      // Application-level error returned by the background script
      if (!resp.success) return reject(new Error(resp.error));

      resolve(resp.data);
    });
  });
}

/**
 * Sends a message to the content script running in the currently active tab
 * and returns a Promise that resolves with the content script's response.
 *
 * Unlike sendMessage(), this targets the tab's frame rather than the background
 * worker, so it requires first querying for the active tab ID.
 *
 * @param {Object} msg - The message object to send to the content script.
 * @returns {Promise<any>} Resolves with the content script's response, or rejects.
 */
function sendToTab(msg) {
  return new Promise(async (resolve, reject) => {
    try {
      // Query Chrome for the tab that currently has focus in the active window
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

      // Guard: if there's no active tab (e.g., all tabs are chrome:// pages),
      // reject immediately rather than sending a message with an undefined tab ID.
      if (!tab?.id) return reject(new Error('No active tab'));

      chrome.tabs.sendMessage(tab.id, msg, (resp) => {
        // Propagate any Chrome-level messaging error
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        resolve(resp);
      });
    } catch (e) { reject(e); }
  });
}

// ─── Quick action button handlers ────────────────────────────────────────────
//
// These three buttons appear at the top of the popup and give one-click access
// to the most common extension actions.

/**
 * "Toggle Panel" button — shows or hides the floating JobMatchAI side panel
 * on the current job posting page.
 *
 * If the content script hasn't been injected into the active tab yet (which
 * happens on first use, or after a browser restart), the click handler
 * programmatically injects both the script and its CSS before retrying
 * the toggle message. A small delay is added after injection to allow the
 * content script to initialize before the message arrives.
 *
 * After sending the toggle command, the popup is closed so it doesn't sit
 * open while the user interacts with the panel.
 */
document.getElementById('togglePanelBtn').addEventListener('click', async () => {
  try {
    // Optimistic path: content script is already injected, just toggle the panel
    await sendToTab({ type: 'TOGGLE_PANEL' });
  } catch (_) {
    // Fallback path: content script is not yet running in this tab.
    // Inject the script and stylesheet, then retry the toggle after a short
    // delay to give the content script time to attach its message listener.
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      // Inject the content script JS
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content.js']
      });
      // Inject the companion stylesheet (panel UI styles)
      await chrome.scripting.insertCSS({
        target: { tabId: tab.id },
        files: ['styles.css']
      });
      // Wait 200 ms for the content script to register its message listener,
      // then send the toggle command
      setTimeout(() => sendToTab({ type: 'TOGGLE_PANEL' }), 200);
    }
  }
  // Close the popup regardless of success/failure — keeps the UX clean
  window.close();
});

/**
 * "Profile" button — opens the profile editor page (profile.html) in a new tab.
 * Used to upload a resume, edit Q&A entries, etc.
 */
document.getElementById('profileBtn').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('profile.html') });
  window.close();
});

/**
 * "Settings" button — opens the settings section of the profile page in a new
 * tab by appending the #settings fragment, which profile.html uses to
 * auto-scroll to or activate the settings tab on load.
 */
document.getElementById('settingsBtn').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('profile.html#settings') });
  window.close();
});

// ─── Status indicator ─────────────────────────────────────────────────────────
//
// The popup header contains a small colored dot (#statusDot) and a text label
// (#statusText) that give the user a quick readiness check. The dot turns green
// when both the API key and a resume are present; otherwise it stays red/grey
// and the text explains what's missing.

/**
 * Fetches the current extension settings and profile from the background script
 * and updates the status indicator in the popup header accordingly.
 *
 * Possible status outcomes:
 *   - "API key not set"    — the user hasn't entered an OpenAI API key yet
 *   - "No resume uploaded" — API key present but no resume/profile data
 *   - "Ready — <name>"    — everything is configured; shows the profile name
 *   - "Error: <message>"  — an unexpected error occurred communicating with
 *                           the background script
 *
 * @returns {Promise<void>}
 */
async function checkStatus() {
  const dot  = document.getElementById('statusDot');
  const text = document.getElementById('statusText');

  try {
    // Fetch both settings and profile in sequence (settings must exist for API key check)
    const settings = await sendMessage({ type: 'GET_SETTINGS' });
    const profile  = await sendMessage({ type: 'GET_PROFILE'  });

    // Check 1: API key is required for all AI-powered features
    if (!settings?.apiKey) {
      text.textContent = 'API key not set';
      return;
    }

    // Check 2: A resume/profile must be uploaded before the extension can analyze jobs
    if (!profile) {
      text.textContent = 'No resume uploaded';
      return;
    }

    // Both prerequisites satisfied — show the green "ready" state
    dot.classList.add('connected');
    text.textContent = `Ready — ${profile.name || 'Profile loaded'}`;
  } catch (err) {
    // Surface any background communication error to the user
    text.textContent = 'Error: ' + err.message;
  }
}

// ─── Jobs list rendering ──────────────────────────────────────────────────────
//
// The lower portion of the popup displays a compact list of saved/applied jobs
// retrieved from the background script. Each entry shows:
//   - A color-coded match score badge (green ≥70, amber ≥45, red <45)
//   - The job title and "Company · Date" metadata line
//   - A delete (×) button
//   - Clicking the info area opens the original job URL in a new tab

/**
 * Loads saved jobs from the background script and renders them into the
 * #jobsList container. Shows #emptyState if there are no saved jobs.
 *
 * Each job card is built as a DOM element (not via innerHTML on the container)
 * to keep XSS-safe escaping straightforward — only the inner job card HTML
 * uses innerHTML, and it calls escapeHTML() on all user-supplied strings.
 *
 * @returns {Promise<void>}
 */
async function loadJobs() {
  const list  = document.getElementById('jobsList');
  const empty = document.getElementById('emptyState');

  try {
    // Ask the background script for the full list of saved/applied jobs
    const jobs = await sendMessage({ type: 'GET_SAVED_JOBS' });

    // If there are no jobs yet, reveal the empty-state placeholder and bail
    if (!jobs || jobs.length === 0) {
      empty.style.display = 'block';
      return;
    }

    // Jobs exist — hide the empty state and clear any previous render
    empty.style.display = 'none';
    list.innerHTML = '';

    jobs.forEach(job => {
      // Create the job card container element
      const item = document.createElement('div');
      item.className = 'job-item';

      // Determine the CSS class for the score badge based on thresholds:
      //   ≥70  → green  (strong match)
      //   ≥45  → amber  (moderate match)
      //   <45  → red    (poor match)
      const scoreClass = job.score >= 70 ? 'score-green'
                       : job.score >= 45 ? 'score-amber'
                       : 'score-red';

      // Build the inner HTML for this job card.
      // escapeHTML() is called on all user-controlled strings (title, company)
      // to prevent XSS via maliciously crafted job posting data.
      // job.date and job.id are not escaped here as they come from the extension's
      // own storage and are expected to be safe primitives.
      item.innerHTML = `
        <div class="job-score ${scoreClass}">${job.score}</div>
        <div class="job-info">
          <div class="job-title">${escapeHTML(job.title)}</div>
          <div class="job-meta">${escapeHTML(job.company)} &middot; ${job.date}</div>
        </div>
        <button class="job-delete" data-id="${job.id}" title="Delete">&times;</button>
      `;

      // ── Click on job info → open original job posting in a new tab ─────────
      item.querySelector('.job-info').addEventListener('click', () => {
        if (job.url) chrome.tabs.create({ url: job.url });
      });

      // ── Click on delete button → remove this job from storage and re-render ─
      item.querySelector('.job-delete').addEventListener('click', async (e) => {
        // Stop the click from bubbling up to the .job-info handler above,
        // which would otherwise also try to open the job URL.
        e.stopPropagation();

        // Ask the background script to delete this job by its ID
        await sendMessage({ type: 'DELETE_JOB', jobId: job.id });

        // Re-render the entire list to reflect the deletion
        loadJobs();
      });

      list.appendChild(item);
    });
  } catch (err) {
    // Silently swallow errors — the jobs list failing to load should not
    // break the rest of the popup UI (status check, quick action buttons).
  }
}

// ─── XSS-safe HTML escaping ───────────────────────────────────────────────────

/**
 * Escapes a string for safe insertion into innerHTML by leveraging the browser's
 * built-in text node escaping. Creates a temporary div, sets its textContent
 * (which the browser escapes), and reads back the escaped innerHTML.
 *
 * Handles null/undefined gracefully by treating them as empty strings.
 *
 * @param {string|null|undefined} str - The string to escape.
 * @returns {string} The HTML-escaped string (e.g., "<" → "&lt;").
 */
function escapeHTML(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

// ─── Hash-based routing (stub) ────────────────────────────────────────────────
//
// This block is intentionally a no-op in the popup context. The #settings hash
// is handled by profile.html itself (which reads window.location.hash on load
// to activate the correct tab). The check is left here as a comment placeholder
// in case popup-level routing is needed in the future.

if (window.location.hash === '#settings') {
  // Intentionally empty: hash routing for the settings section is handled
  // by profile.html, not by the popup. This branch is never reached in normal
  // popup usage because the popup always opens at its own URL without a hash.
}

// ─── Initialization ───────────────────────────────────────────────────────────
//
// Run both async initializers in parallel when the popup DOM is ready.
// checkStatus() and loadJobs() are independent, so there is no need to await
// one before starting the other.

checkStatus();
loadJobs();
