/**
 * @file profile.js
 * @description Manages the full-page Profile tab for the JobMatchAI Chrome extension.
 *
 * Responsibilities:
 *   - Resume upload and text extraction (PDF via pdf.js, DOCX via mammoth)
 *   - AI-powered resume parsing via the background service worker (PARSE_RESUME)
 *   - Editable profile form: contact info, skills, certifications, experience,
 *     education, and projects — all kept in sync with the in-memory `profileData` object
 *   - Multi-slot resume management: up to 3 named resume profiles that can be
 *     switched, renamed, and persisted independently in chrome.storage.local
 *   - Q&A list: a set of pre-filled answers to common job-application questions,
 *     backed by DEFAULT_QA_QUESTIONS; supports category filtering and migration of
 *     stored entries to keep type/options in sync with the current defaults
 *   - AI provider settings: provider dropdown, model selection, API key, temperature
 *   - Applied jobs tracker: loads the saved application log and renders a sortable table
 *   - Stats dashboard: computes aggregate match-score stats and top missing skills
 *     directly from the jm_analysisCache entry in chrome.storage.local
 *   - Hash-based navigation so external pages can deep-link to a specific tab
 *     (e.g. profile.html#settings)
 */

// ─── State variables ─────────────────────────────────────────────────────────

/**
 * In-memory representation of the currently active resume profile.
 * Populated from chrome.storage via GET_PROFILE on init, updated by the form,
 * and flushed to the active slot on every save.
 * @type {{
 *   name: string, email: string, phone: string, location: string,
 *   linkedin: string, website: string, summary: string,
 *   skills: string[], experience: Object[], education: Object[],
 *   certifications: string[], projects: Object[],
 *   resumeFileName?: string
 * }}
 */
let profileData = {
  name: '', email: '', phone: '', location: '',
  linkedin: '', website: '', summary: '',
  skills: [], experience: [], education: [],
  certifications: [], projects: []
};

/**
 * Tracks whether the profile form has unsaved changes.
 * Set to true on any form edit; reset to false after a successful save.
 * @type {boolean}
 */
let profileDirty = false;

/**
 * Timer ID for the debounced autosave. Cleared and reset on every edit
 * so we only save once the user stops typing for 2 seconds.
 * @type {number|null}
 */
let autosaveTimer = null;

/**
 * Marks the profile as dirty, highlights the save button, and schedules
 * an autosave after 2 seconds of inactivity.
 */
function markProfileDirty() {
  profileDirty = true;
  const btn = document.getElementById('saveProfileBtn');
  if (btn) btn.style.background = '#f59e0b';

  // Debounced autosave: reset timer on every change, save after 2s idle
  if (autosaveTimer) clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => autoSaveProfile(), 2000);
}

/**
 * Silently saves the profile without user interaction.
 * Syncs form fields, saves to storage, and updates slot data.
 */
async function autoSaveProfile() {
  if (!profileDirty) return;

  // Sync plain text fields from the form
  profileData.name     = document.getElementById('pName').value.trim();
  profileData.email    = document.getElementById('pEmail').value.trim();
  profileData.phone    = document.getElementById('pPhone').value.trim();
  profileData.location = document.getElementById('pLocation').value.trim();
  profileData.linkedin = document.getElementById('pLinkedin').value.trim();
  profileData.website  = document.getElementById('pWebsite').value.trim();
  profileData.summary  = document.getElementById('pSummary').value.trim();

  try {
    await sendMessage({ type: 'SAVE_PROFILE', profile: profileData });
    profileSlots[activeSlot] = JSON.parse(JSON.stringify(profileData));
    await chrome.storage.local.set({ profileSlots });
    updateSlotButtons();
    markProfileClean();
    const btn = document.getElementById('saveProfileBtn');
    if (btn) {
      btn.textContent = 'Saved';
      setTimeout(() => { btn.textContent = 'Save Profile'; }, 1500);
    }
  } catch (_) {
    // Silent fail — user can still use the manual save button
  }
}

/**
 * Marks the profile as clean and reverts the save button to its default style.
 */
function markProfileClean() {
  profileDirty = false;
  const btn = document.getElementById('saveProfileBtn');
  if (btn) btn.style.background = '';
}

// Warn the user when navigating away with unsaved profile changes
window.addEventListener('beforeunload', (e) => {
  if (profileDirty) { e.preventDefault(); }
});

/**
 * In-memory list of Q&A entries displayed in the Q&A tab.
 * Each entry: { question, answer, category, type, options? }
 * Loaded from storage on init and flushed via SAVE_QA_LIST.
 * @type {Array<{question: string, answer: string, category: string, type: string, options?: string[]}>}
 */
let qaList = [];

/**
 * Registry of available AI providers fetched from the background on init.
 * Keyed by provider ID (e.g. 'anthropic', 'openai').  Used to populate the
 * provider dropdown and drive per-provider model lists / key placeholders.
 * @type {Object.<string, {name: string, models: Object[], defaultModel: string, keyPlaceholder: string, hint: string, free?: boolean}>}
 */
let providerData = {};

// ─── Helper utilities ─────────────────────────────────────────────────────────

/**
 * Wraps chrome.runtime.sendMessage in a Promise so callers can use async/await.
 * Rejects on runtime errors, missing responses, or when the background signals
 * `success: false`.
 *
 * @param {Object} msg - Message object with at minimum a `type` string field.
 * @returns {Promise<*>} Resolves with `resp.data` from the background handler.
 */
function sendMessage(msg) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (resp) => {
      // chrome.runtime.lastError is set when the message could not be delivered
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      // A null/undefined response means the background script did not reply at all
      if (!resp) return reject(new Error('No response from background'));
      // The background signals logical failure via resp.success === false
      if (!resp.success) return reject(new Error(resp.error));
      resolve(resp.data);
    });
  });
}

/**
 * Briefly displays a toast notification at the bottom of the page.
 * The 'show' class triggers a CSS transition; it is removed after 2.5 s.
 *
 * @param {string} msg - Human-readable message to display.
 */
function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2500);
}

/**
 * Updates the status text below the upload zone with a semantic type class
 * ('loading' | 'success' | 'error') so CSS can colour it appropriately.
 *
 * @param {string} text - Status message.
 * @param {string} type - One of 'loading', 'success', or 'error'.
 */
function setUploadStatus(text, type) {
  const el = document.getElementById('uploadStatus');
  el.textContent = text;
  // Replace all existing type classes with the new one
  el.className = 'upload-status ' + type;
}

/**
 * Replaces the upload zone's inner HTML with a "resume loaded" confirmation
 * that shows the file name and a hint to re-upload if desired.
 *
 * @param {string|null} fileName - The resume file name (or profile name) to display.
 */
function showResumeLoaded(fileName) {
  const zone = document.getElementById('uploadZone');
  const name = fileName || 'Resume';
  zone.innerHTML = `
    <div class="icon" style="color: #059669;">&#9989;</div>
    <div class="text" style="color: #059669; font-weight: 600;">${escapeHTML(name)}</div>
    <div class="hint">Resume loaded. Click or drag to upload a different one.</div>
  `;
}

// ─── Tab switching ────────────────────────────────────────────────────────────

/**
 * Attach click listeners to every `.tab` button.
 * Activating a tab deactivates all others and shows the matching `.tab-content`
 * panel.  Lazy-loads data for the 'applied' and 'stats' tabs on first reveal.
 */
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    // Deactivate all tabs and panels
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    tab.classList.add('active');
    // Show the corresponding panel; panel IDs follow the convention "tab-<name>"
    document.getElementById('tab-' + tab.dataset.tab).classList.add('active');
    // Refresh data-heavy tabs every time they become visible
    if (tab.dataset.tab === 'applied') loadAppliedJobs();
    if (tab.dataset.tab === 'stats') renderStats();
  });
});

// ─── Resume upload ────────────────────────────────────────────────────────────

/** DOM references kept at module scope so multiple listeners can share them. */
const uploadZone = document.getElementById('uploadZone');
const fileInput  = document.getElementById('fileInput');

// Clicking anywhere in the drop zone opens the OS file picker
uploadZone.addEventListener('click', () => fileInput.click());

// Drag-over: prevent default to allow the drop event and add visual feedback
uploadZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  uploadZone.classList.add('drag-over');
});

// Drag-leave: remove visual feedback when the dragged item leaves the zone
uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('drag-over'));

// Drop: extract the first dropped file and process it
uploadZone.addEventListener('drop', (e) => {
  e.preventDefault();
  uploadZone.classList.remove('drag-over');
  if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
});

// Standard <input type="file"> change event — also feeds into handleFile
fileInput.addEventListener('change', () => {
  if (fileInput.files.length) handleFile(fileInput.files[0]);
});

/**
 * Validates, extracts text from, and AI-parses an uploaded resume file.
 * Supports PDF (via pdf.js) and DOCX (via mammoth).
 * On success: merges parsed fields into `profileData`, repopulates the form,
 * and updates the upload zone to reflect the loaded file.
 *
 * @param {File} file - The File object supplied by the input or drop event.
 */
async function handleFile(file) {
  // Derive the file extension to decide which extractor to use
  const ext = file.name.split('.').pop().toLowerCase();
  if (!['pdf', 'docx'].includes(ext)) {
    setUploadStatus('Please upload a PDF or DOCX file.', 'error');
    return;
  }

  const MAX_FILE_SIZE = 15 * 1024 * 1024; // 15 MB
  if (file.size > MAX_FILE_SIZE) {
    setUploadStatus('File is too large (max 15 MB). Please upload a smaller file.', 'error');
    return;
  }

  setUploadStatus('Extracting text from ' + file.name + '...', 'loading');

  try {
    let rawText;
    if (ext === 'pdf') {
      rawText = await extractPDF(file);
    } else {
      rawText = await extractDOCX(file);
    }

    // A very short extraction usually means a scanned image PDF with no text layer
    if (!rawText || rawText.trim().length < 20) {
      setUploadStatus('Could not extract enough text from file.', 'error');
      return;
    }

    setUploadStatus('Parsing resume with AI... This may take a moment.', 'loading');

    // Hand off raw text to the background script which calls the configured AI provider
    const parsed = await sendMessage({ type: 'PARSE_RESUME', rawText });
    // Merge parsed fields into existing profileData while preserving any extra keys
    // (e.g. resumeFileName from a previous save) and stamp the new file name
    profileData = { ...profileData, ...parsed, resumeFileName: file.name, resumeFileType: ext };
    populateProfileForm();
    showResumeLoaded(file.name);
    setUploadStatus('Resume parsed successfully! Review and edit below.', 'success');
    markProfileDirty();

    // Store raw DOCX bytes for tailored resume generation (direct DOCX editing)
    if (ext === 'docx') {
      const ab = await file.arrayBuffer();
      const bytes = new Uint8Array(ab);
      // Convert to base64 in chunks to avoid call stack overflow on large files
      let binary = '';
      const chunkSize = 8192;
      for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
      }
      const base64 = btoa(binary);
      await sendMessage({ type: 'SAVE_RAW_RESUME', rawResumeBase64: base64, fileType: ext });
    } else {
      await sendMessage({ type: 'SAVE_RAW_RESUME', rawResumeBase64: null, fileType: ext });
    }

    // Auto-fill Q&A answers from parsed resume data
    prefillQAFromProfile(profileData);
  } catch (err) {
    setUploadStatus('Error: ' + err.message, 'error');
  }
}

/**
 * Extracts plain text from a PDF file using pdf.js.
 * Iterates through every page and concatenates the text items, separated by
 * newlines between pages.
 *
 * @param {File} file - A File object whose content is a valid PDF.
 * @returns {Promise<string>} Concatenated text from all pages.
 */
async function extractPDF(file) {
  const arrayBuffer = await file.arrayBuffer();
  // Point pdf.js at the bundled worker script shipped with the extension
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'libs/pdf.worker.min.js';
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  let text = '';
  // pdf.js pages are 1-indexed
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    // Each item in the content stream has a `str` property; join with spaces
    text += content.items.map(item => item.str).join(' ') + '\n';
  }
  return text;
}

/**
 * Extracts plain text from a DOCX file using the mammoth library.
 *
 * @param {File} file - A File object whose content is a valid DOCX.
 * @returns {Promise<string>} Extracted raw text.
 */
async function extractDOCX(file) {
  const arrayBuffer = await file.arrayBuffer();
  // mammoth.extractRawText strips all formatting and returns plain text
  const result = await mammoth.extractRawText({ arrayBuffer });
  return result.value;
}

// ─── Profile form population ──────────────────────────────────────────────────

/**
 * Writes all fields from the in-memory `profileData` object into the HTML form.
 * Also triggers re-renders of all list sections (skills, certs, experience,
 * education, projects).
 */
function populateProfileForm() {
  document.getElementById('pName').value     = profileData.name     || '';
  document.getElementById('pEmail').value    = profileData.email    || '';
  document.getElementById('pPhone').value    = profileData.phone    || '';
  document.getElementById('pLocation').value = profileData.location || '';
  document.getElementById('pLinkedin').value = profileData.linkedin || '';
  document.getElementById('pWebsite').value  = profileData.website  || '';
  document.getElementById('pSummary').value  = profileData.summary  || '';

  renderSkills();
  renderCerts();
  renderExperience();
  renderEducation();
  renderProjects();
}

// ─── Dirty tracking for personal info fields ─────────────────────────────────
['pName', 'pEmail', 'pPhone', 'pLocation', 'pLinkedin', 'pWebsite', 'pSummary'].forEach(id => {
  document.getElementById(id).addEventListener('input', markProfileDirty);
});

// ─── Skills ───────────────────────────────────────────────────────────────────

/**
 * Clears and re-renders the skills tag list from `profileData.skills`.
 * Each tag contains an inline remove button whose click handler splices the
 * corresponding index from the array and triggers a re-render.
 */
function renderSkills() {
  const container = document.getElementById('skillsContainer');
  container.innerHTML = '';
  (profileData.skills || []).forEach((skill, i) => {
    const tag = document.createElement('span');
    tag.className = 'skill-tag';
    // Embed the array index in a data attribute so the remove handler knows what to splice
    tag.innerHTML = `${escapeHTML(skill)} <span class="remove" data-idx="${i}">&times;</span>`;
    container.appendChild(tag);
  });
  // Wire remove buttons after all tags exist in the DOM
  container.querySelectorAll('.remove').forEach(btn => {
    btn.addEventListener('click', () => {
      profileData.skills.splice(parseInt(btn.dataset.idx), 1);
      renderSkills();
      markProfileDirty();
    });
  });
}

/**
 * Reads the skill input field, deduplicates against the existing list,
 * pushes a new entry, and re-renders the tag list.
 */
function addSkill() {
  const input = document.getElementById('skillInput');
  const val   = input.value.trim();
  if (!val) return;
  // Guard against undefined array in case profileData was freshly created
  if (!profileData.skills) profileData.skills = [];
  if (!profileData.skills.includes(val)) {
    profileData.skills.push(val);
    renderSkills();
    markProfileDirty();
  }
  input.value = '';
}

document.getElementById('addSkillBtn').addEventListener('click', addSkill);
// Allow Enter key in the skill input to trigger the same add action
document.getElementById('skillInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); addSkill(); }
});

// ─── Certifications ───────────────────────────────────────────────────────────

/**
 * Clears and re-renders the certifications tag list from `profileData.certifications`.
 * Follows the same pattern as renderSkills: tags with inline remove buttons.
 */
function renderCerts() {
  const container = document.getElementById('certsContainer');
  container.innerHTML = '';
  (profileData.certifications || []).forEach((cert, i) => {
    const tag = document.createElement('span');
    tag.className = 'skill-tag';
    tag.innerHTML = `${escapeHTML(cert)} <span class="remove" data-idx="${i}">&times;</span>`;
    container.appendChild(tag);
  });
  container.querySelectorAll('.remove').forEach(btn => {
    btn.addEventListener('click', () => {
      profileData.certifications.splice(parseInt(btn.dataset.idx), 1);
      renderCerts();
      markProfileDirty();
    });
  });
}

/**
 * Reads the certification input, deduplicates, and appends to the list.
 */
function addCert() {
  const input = document.getElementById('certInput');
  const val   = input.value.trim();
  if (!val) return;
  if (!profileData.certifications) profileData.certifications = [];
  if (!profileData.certifications.includes(val)) {
    profileData.certifications.push(val);
    renderCerts();
    markProfileDirty();
  }
  input.value = '';
}

document.getElementById('addCertBtn').addEventListener('click', addCert);
document.getElementById('certInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); addCert(); }
});

// ─── Experience ───────────────────────────────────────────────────────────────

/**
 * Clears and re-renders all experience entries from `profileData.experience`.
 */
function renderExperience() {
  const list = document.getElementById('experienceList');
  list.innerHTML = '';
  (profileData.experience || []).forEach((exp, i) => {
    list.appendChild(createExperienceEntry(exp, i));
  });
}

/**
 * Creates a single editable experience card as a DOM element.
 * Input/textarea changes are immediately mirrored back to `profileData.experience[idx]`
 * via the `data-field` attribute, so no additional "collect form" step is needed on save.
 *
 * @param {Object} exp - Experience object: { title, company, dates, description }.
 * @param {number} idx - Array index within profileData.experience (used for removal and live sync).
 * @returns {HTMLDivElement} The fully wired card element.
 */
function createExperienceEntry(exp, idx) {
  const div = document.createElement('div');
  div.className = 'entry';
  div.innerHTML = `
    <div class="entry-header">
      <h4>Experience #${idx + 1}</h4>
      <button class="btn btn-danger btn-sm remove-entry" data-idx="${idx}">Remove</button>
    </div>
    <div class="form-row">
      <div><label>Job Title</label><input type="text" data-field="title" value="${escapeAttr(exp.title || '')}"></div>
      <div><label>Company</label><input type="text" data-field="company" value="${escapeAttr(exp.company || '')}"></div>
    </div>
    <label>Dates</label><input type="text" data-field="dates" value="${escapeAttr(exp.dates || '')}">
    <label>Description</label><textarea data-field="description" rows="3">${escapeHTML(exp.description || '')}</textarea>
  `;
  // Remove button: splice this entry and re-render the entire list (indices shift)
  div.querySelector('.remove-entry').addEventListener('click', () => {
    profileData.experience.splice(idx, 1);
    renderExperience();
    markProfileDirty();
  });
  // Sync edits back to state — each field uses data-field to identify which key to update
  div.querySelectorAll('input, textarea').forEach(input => {
    input.addEventListener('input', () => {
      profileData.experience[idx][input.dataset.field] = input.value;
      markProfileDirty();
    });
  });
  return div;
}

// Add a blank experience entry when the user clicks the button
document.getElementById('addExpBtn').addEventListener('click', () => {
  if (!profileData.experience) profileData.experience = [];
  profileData.experience.push({ title: '', company: '', dates: '', description: '' });
  renderExperience();
  markProfileDirty();
});

// ─── Education ────────────────────────────────────────────────────────────────

/**
 * Clears and re-renders all education entries from `profileData.education`.
 */
function renderEducation() {
  const list = document.getElementById('educationList');
  list.innerHTML = '';
  (profileData.education || []).forEach((edu, i) => {
    list.appendChild(createEducationEntry(edu, i));
  });
}

/**
 * Creates a single editable education card.
 * Live-syncs changes back to `profileData.education[idx]` via data-field attributes.
 *
 * @param {Object} edu - Education object: { degree, school, dates, details }.
 * @param {number} idx - Array index within profileData.education.
 * @returns {HTMLDivElement} Fully wired card element.
 */
function createEducationEntry(edu, idx) {
  const div = document.createElement('div');
  div.className = 'entry';
  div.innerHTML = `
    <div class="entry-header">
      <h4>Education #${idx + 1}</h4>
      <button class="btn btn-danger btn-sm remove-entry" data-idx="${idx}">Remove</button>
    </div>
    <div class="form-row">
      <div><label>Degree</label><input type="text" data-field="degree" value="${escapeAttr(edu.degree || '')}"></div>
      <div><label>School</label><input type="text" data-field="school" value="${escapeAttr(edu.school || '')}"></div>
    </div>
    <label>Dates</label><input type="text" data-field="dates" value="${escapeAttr(edu.dates || '')}">
    <label>Details</label><textarea data-field="details" rows="2">${escapeHTML(edu.details || '')}</textarea>
  `;
  div.querySelector('.remove-entry').addEventListener('click', () => {
    profileData.education.splice(idx, 1);
    renderEducation();
    markProfileDirty();
  });
  div.querySelectorAll('input, textarea').forEach(input => {
    input.addEventListener('input', () => {
      profileData.education[idx][input.dataset.field] = input.value;
      markProfileDirty();
    });
  });
  return div;
}

document.getElementById('addEduBtn').addEventListener('click', () => {
  if (!profileData.education) profileData.education = [];
  profileData.education.push({ degree: '', school: '', dates: '', details: '' });
  renderEducation();
  markProfileDirty();
});

// ─── Projects ─────────────────────────────────────────────────────────────────

/**
 * Clears and re-renders all project entries from `profileData.projects`.
 */
function renderProjects() {
  const list = document.getElementById('projectsList');
  list.innerHTML = '';
  (profileData.projects || []).forEach((proj, i) => {
    list.appendChild(createProjectEntry(proj, i));
  });
}

/**
 * Creates a single editable project card.
 * The 'technologies' field is stored as an array but displayed as a
 * comma-separated string; the input handler splits it back on save.
 *
 * @param {Object} proj - Project object: { name, description, technologies: string[] }.
 * @param {number} idx  - Array index within profileData.projects.
 * @returns {HTMLDivElement} Fully wired card element.
 */
function createProjectEntry(proj, idx) {
  const div = document.createElement('div');
  div.className = 'entry';
  div.innerHTML = `
    <div class="entry-header">
      <h4>Project #${idx + 1}</h4>
      <button class="btn btn-danger btn-sm remove-entry" data-idx="${idx}">Remove</button>
    </div>
    <label>Project Name</label>
    <input type="text" data-field="name" value="${escapeAttr(proj.name || '')}">
    <label>Description</label>
    <textarea data-field="description" rows="2">${escapeHTML(proj.description || '')}</textarea>
    <label>Technologies (comma-separated)</label>
    <input type="text" data-field="technologies" value="${escapeAttr((proj.technologies || []).join(', '))}">
  `;
  div.querySelector('.remove-entry').addEventListener('click', () => {
    profileData.projects.splice(idx, 1);
    renderProjects();
    markProfileDirty();
  });
  div.querySelectorAll('input, textarea').forEach(input => {
    input.addEventListener('input', () => {
      const field = input.dataset.field;
      if (field === 'technologies') {
        // Convert the comma-separated display string back to an array, stripping blanks
        profileData.projects[idx][field] = input.value.split(',').map(s => s.trim()).filter(Boolean);
      } else {
        profileData.projects[idx][field] = input.value;
      }
      markProfileDirty();
    });
  });
  return div;
}

document.getElementById('addProjBtn').addEventListener('click', () => {
  if (!profileData.projects) profileData.projects = [];
  profileData.projects.push({ name: '', description: '', technologies: [] });
  renderProjects();
  markProfileDirty();
});

// ─── Save profile ─────────────────────────────────────────────────────────────

/**
 * Save-profile button handler.
 * 1. Reads the plain-text fields from the form into `profileData` (list fields
 *    are already kept in sync by their individual input listeners).
 * 2. Persists via the background (SAVE_PROFILE message).
 * 3. Deep-copies the updated profile into the active slot and writes
 *    profileSlots back to chrome.storage.local so slot state stays consistent.
 */
document.getElementById('saveProfileBtn').addEventListener('click', async () => {
  // Sync the plain text fields that are not live-updated by sub-component listeners
  profileData.name     = document.getElementById('pName').value.trim();
  profileData.email    = document.getElementById('pEmail').value.trim();
  profileData.phone    = document.getElementById('pPhone').value.trim();
  profileData.location = document.getElementById('pLocation').value.trim();
  profileData.linkedin = document.getElementById('pLinkedin').value.trim();
  profileData.website  = document.getElementById('pWebsite').value.trim();
  profileData.summary  = document.getElementById('pSummary').value.trim();

  // ── Basic validation (only if fields are filled in) ──
  if (profileData.email && (!/[@]/.test(profileData.email) || !/[.]/.test(profileData.email))) {
    showToast('Please enter a valid email address');
    return;
  }
  if (profileData.phone && (profileData.phone.replace(/\D/g, '').length < 10)) {
    showToast('Please enter a valid phone number');
    return;
  }

  try {
    await sendMessage({ type: 'SAVE_PROFILE', profile: profileData });
    // Deep-copy into the active slot so the slot array always reflects the latest save
    profileSlots[activeSlot] = JSON.parse(JSON.stringify(profileData));
    await chrome.storage.local.set({ profileSlots });
    updateSlotButtons();
    markProfileClean();
    showToast('Profile saved!');
  } catch (err) {
    showToast('Error saving: ' + err.message);
  }
});

// ─── Q&A rendering ────────────────────────────────────────────────────────────

/**
 * Clears and re-renders the entire Q&A list from the `qaList` array.
 *
 * Rendering rules per entry type:
 *   - 'custom' (no category or category === 'custom'): editable question label +
 *     textarea answer — the user owns both fields.
 *   - 'dropdown': fixed question label + <select> populated from entry.options.
 *   - 'short': fixed question label + single-line <input>.
 *   - 'text' (fallback): fixed question label + multi-line <textarea>.
 *
 * Compact display (qa-compact class) is applied to 'short' and 'dropdown' entries
 * that belong to a built-in category, keeping the list visually dense.
 *
 * Applies the active category filter (`activeQAFilter`) to hide irrelevant entries.
 */
function renderQA() {
  const list = document.getElementById('qaList');
  list.innerHTML = '';

  // Show current count near the Q&A section header
  const countEl = document.getElementById('qaCount');
  if (countEl) countEl.textContent = `${qaList.length} / 200`;

  // Only show the category filter toolbar if at least one entry has a category
  const hasCategorized = qaList.some(q => q.category);
  const filterEl = document.getElementById('qaCategoryFilter');
  if (filterEl) filterEl.style.display = hasCategorized ? 'block' : 'none';

  // Once the list is large enough the "Load common questions" button is no longer useful
  const loadBtn = document.getElementById('loadDefaultQABtn');
  if (loadBtn && qaList.length >= 10) loadBtn.style.display = 'none';

  // Human-readable labels for each category slug used in badge rendering
  const categoryLabels = {
    'personal':     'Personal',
    'work-auth':    'Work Auth',
    'availability': 'Availability',
    'salary':       'Salary',
    'background':   'Background',
    'relocation':   'Relocation',
    'referral':     'Referral',
    'demographics': 'Demographics',
    'general':      'General',
    'custom':       'Custom'
  };

  let visibleCount = 0;
  qaList.forEach((qa, i) => {
    // Treat entries without a category as 'custom' for filter matching
    const cat = qa.category || 'custom';
    // Skip entries that don't match the active filter (unless filter is 'all')
    if (activeQAFilter !== 'all' && cat !== activeQAFilter) return;
    visibleCount++;

    const qType = qa.type || 'text';
    // An entry is "custom" if it has no category or its category is literally 'custom'
    const isCustom  = !qa.category || qa.category === 'custom';
    // Compact layout is used for brief built-in questions to reduce vertical space
    const isCompact = (qType === 'short' || qType === 'dropdown') && !isCustom;

    const div = document.createElement('div');
    div.className = 'qa-entry' + (isCompact ? ' qa-compact' : '');

    // Build the coloured category badge HTML (empty string if no category)
    const badge = qa.category
      ? `<span class="qa-category-badge qa-cat-${cat}">${categoryLabels[cat] || cat}</span>`
      : '';

    if (isCustom) {
      // Custom entries: both the question text and the answer are user-editable
      div.innerHTML = `
        <div class="qa-compact-header">
          <label>Q&A #${i + 1}${badge}</label>
          <button class="btn btn-danger btn-sm remove-qa" data-idx="${i}">&times;</button>
        </div>
        <input type="text" data-field="question" value="${escapeAttr(qa.question || '')}" placeholder="Enter your question...">
        <textarea data-field="answer" rows="2" placeholder="Your answer...">${escapeHTML(qa.answer || '')}</textarea>
      `;
    } else if (qType === 'dropdown') {
      // Dropdown: question is fixed, answer is chosen from a <select>
      const optionsHTML = (qa.options || []).map(opt =>
        `<option value="${escapeAttr(opt)}"${qa.answer === opt ? ' selected' : ''}>${escapeHTML(opt || '-- Select --')}</option>`
      ).join('');
      div.innerHTML = `
        <div class="qa-compact-header">
          <label>${escapeHTML(qa.question)}${badge}</label>
          <button class="btn btn-danger btn-sm remove-qa" data-idx="${i}">&times;</button>
        </div>
        <select data-field="answer">${optionsHTML}</select>
      `;
    } else if (qType === 'short') {
      // Short text: single-line input for brief answers (name, salary, dates, etc.)
      div.innerHTML = `
        <div class="qa-compact-header">
          <label>${escapeHTML(qa.question)}${badge}</label>
          <button class="btn btn-danger btn-sm remove-qa" data-idx="${i}">&times;</button>
        </div>
        <input type="text" data-field="answer" value="${escapeAttr(qa.answer || '')}" placeholder="Enter...">
      `;
    } else {
      // Textarea (type === 'text'): multi-line input for longer free-text answers
      div.innerHTML = `
        <div class="qa-compact-header">
          <label>${escapeHTML(qa.question)}${badge}</label>
          <button class="btn btn-danger btn-sm remove-qa" data-idx="${i}">&times;</button>
        </div>
        <textarea data-field="answer" rows="2" placeholder="Your answer...">${escapeHTML(qa.answer || '')}</textarea>
      `;
    }

    // Remove: splice from qaList and re-render (all indices above i shift down by 1)
    div.querySelector('.remove-qa').addEventListener('click', () => {
      qaList.splice(i, 1);
      renderQA();
    });

    // Live-sync: mirror every field change back to qaList[i] immediately
    // SELECTs fire 'change'; inputs and textareas fire 'input'
    div.querySelectorAll('input, textarea, select').forEach(el => {
      const evt = el.tagName === 'SELECT' ? 'change' : 'input';
      el.addEventListener(evt, () => {
        qaList[i][el.dataset.field] = el.value;
      });
    });

    list.appendChild(div);
  });

  // Friendly empty-state message when a filter yields no results
  if (visibleCount === 0 && activeQAFilter !== 'all') {
    list.innerHTML = '<p style="text-align:center;color:#94a3b8;padding:20px;">No questions in this category.</p>';
  }
}

// ─── DEFAULT_QA_QUESTIONS categories ─────────────────────────────────────────
// The US states list is used by the 'State / Province' dropdown option set.

/**
 * Abbreviated two-letter codes for all US states and DC.
 * Used as the option values for the "State / Province" dropdown question.
 * @type {string[]}
 */
/**
 * Auto-fills Q&A answers from parsed resume profile data.
 * Only fills answers that are currently empty — never overwrites user edits.
 * Maps profile fields to matching Q&A questions by question text.
 *
 * @param {Object} profile - The parsed resume profile object.
 */
function prefillQAFromProfile(profile) {
  if (!profile || qaList.length === 0) return;

  // Split full name into first/last
  const nameParts = (profile.name || '').trim().split(/\s+/);
  const firstName = nameParts[0] || '';
  const lastName = nameParts.length > 1 ? nameParts.slice(1).join(' ') : '';

  // Parse location: try "City, State ZIP" or "City, State" patterns
  const loc = (profile.location || '').trim();
  let city = '', state = '', zip = '';
  const locMatch = loc.match(/^([^,]+),?\s*([A-Z]{2})?\s*(\d{5})?/i);
  if (locMatch) {
    city = (locMatch[1] || '').trim();
    state = (locMatch[2] || '').toUpperCase();
    zip = locMatch[3] || '';
  } else {
    city = loc; // fallback: use full location as city
  }

  // Get current job title and company from most recent experience
  let currentTitle = '', currentCompany = '';
  if (Array.isArray(profile.experience) && profile.experience.length > 0) {
    currentTitle = profile.experience[0].title || '';
    currentCompany = profile.experience[0].company || '';
  }

  // Get highest education level
  let educationLevel = '';
  if (Array.isArray(profile.education) && profile.education.length > 0) {
    const deg = (profile.education[0].degree || '').toLowerCase();
    if (deg.includes('doctor') || deg.includes('phd') || deg.includes('edd')) educationLevel = 'Doctorate (PhD/EdD)';
    else if (deg.includes('master') || deg.includes('mba') || deg.includes('m.s') || deg.includes('m.a')) educationLevel = "Master's Degree (MA/MS/MBA)";
    else if (deg.includes('bachelor') || deg.includes('b.s') || deg.includes('b.a') || deg.includes('b.e')) educationLevel = "Bachelor's Degree (BA/BS)";
    else if (deg.includes('associate')) educationLevel = "Associate's Degree";
  }

  // Get certifications as comma-separated string
  const certs = (profile.certifications || []).join(', ');

  // Map of Q&A question text (lowercased) → value to fill
  const mappings = {
    'first name': firstName,
    'last name': lastName,
    'email address': profile.email || '',
    'phone number': profile.phone || '',
    'city': city,
    'zip / postal code': zip,
    'current job title': currentTitle,
    'current employer / company': currentCompany,
    'linkedin profile url': profile.linkedin || '',
    'portfolio / personal website url': profile.website || '',
    'github profile url': profile.github || '',
    'relevant certifications or professional licenses': certs,
  };

  // Add state mapping only if we found a valid state abbreviation
  if (state) mappings['state / province'] = state;
  // Add education level only if we identified it
  if (educationLevel) mappings['highest level of education completed'] = educationLevel;

  let filled = 0;
  qaList.forEach(qa => {
    const key = qa.question.toLowerCase().trim();
    if (mappings[key] && !qa.answer) {
      qa.answer = mappings[key];
      filled++;
    }
  });

  if (filled > 0) {
    renderQA();
    showToast(`Auto-filled ${filled} Q&A answers from your resume.`);
  }
}

const US_STATES = [
  'AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI','ID','IL','IN',
  'IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH',
  'NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT',
  'VT','VA','WA','WV','WI','WY'
];

/**
 * Canonical set of Q&A entries representing the most common questions asked on
 * US job applications.  Grouped into labelled categories:
 *
 *   personal      — name, address, contact details, current employer
 *   work-auth     — legal right to work, visa sponsorship, age gate
 *   availability  — start date, notice period, employment type, overtime
 *   salary        — desired salary / hourly rate
 *   background    — background check, drug test, prior employment, non-compete,
 *                   driver's licence
 *   relocation    — willingness to relocate, relocation assistance, work
 *                   arrangement preference, travel percentage
 *   referral      — source of the job lead, employee referral, social/portfolio links
 *   demographics  — voluntary EEO / diversity fields (all "Prefer not to say" friendly)
 *   general       — education level, certifications, clearance, accommodation,
 *                   open-ended cover note
 *
 * Each entry shape: { question, answer, category, type, options? }
 *   type: 'short'    — single-line text input
 *         'dropdown' — <select> with the provided options array
 *         'text'     — multi-line textarea
 *
 * The `answer` field is intentionally empty here; it gets filled in by the user
 * (or pre-populated from profileData during future enhancements).
 *
 * @type {Array<{question: string, answer: string, category: string, type: string, options?: string[]}>}
 */
const DEFAULT_QA_QUESTIONS = [
  // ── Personal / Address ──
  { question: 'First Name', answer: '', category: 'personal', type: 'short' },
  { question: 'Last Name', answer: '', category: 'personal', type: 'short' },
  { question: 'Email Address', answer: '', category: 'personal', type: 'short' },
  { question: 'Phone Number', answer: '', category: 'personal', type: 'short' },
  { question: 'Street Address', answer: '', category: 'personal', type: 'short' },
  { question: 'Street Address Line 2 (Apt, Suite, Unit)', answer: '', category: 'personal', type: 'short' },
  { question: 'City', answer: '', category: 'personal', type: 'short' },
  // State dropdown: blank sentinel + all 50 states + DC + Other
  { question: 'State / Province', answer: '', category: 'personal', type: 'dropdown', options: [''].concat(US_STATES, ['Other']) },
  { question: 'ZIP / Postal Code', answer: '', category: 'personal', type: 'short' },
  { question: 'Country', answer: '', category: 'personal', type: 'dropdown', options: ['', 'United States', 'Canada', 'United Kingdom', 'India', 'Australia', 'Germany', 'France', 'Mexico', 'Brazil', 'Other'] },
  { question: 'Current Job Title', answer: '', category: 'personal', type: 'short' },
  { question: 'Current Employer / Company', answer: '', category: 'personal', type: 'short' },

  // ── Work Authorization ──
  { question: 'Are you legally authorized to work in the United States?', answer: '', category: 'work-auth', type: 'dropdown', options: ['', 'Yes', 'No'] },
  { question: 'Will you now or in the future require sponsorship for employment visa status (e.g., H-1B)?', answer: '', category: 'work-auth', type: 'dropdown', options: ['', 'Yes', 'No'] },
  { question: 'Are you at least 18 years of age?', answer: '', category: 'work-auth', type: 'dropdown', options: ['', 'Yes', 'No'] },
  { question: 'Work authorization status', answer: '', category: 'work-auth', type: 'dropdown', options: ['', 'U.S. Citizen', 'Green Card Holder', 'H-1B Visa', 'EAD / OPT', 'TN Visa', 'L-1 Visa', 'Other'] },

  // ── Availability ──
  { question: 'Earliest available start date', answer: '', category: 'availability', type: 'short' },
  { question: 'Notice period for current employer', answer: '', category: 'availability', type: 'dropdown', options: ['', 'Immediately available', '1 week', '2 weeks', '3 weeks', '1 month', 'More than 1 month'] },
  { question: 'Desired employment type', answer: '', category: 'availability', type: 'dropdown', options: ['', 'Full-time', 'Part-time', 'Contract', 'Internship', 'Any'] },
  { question: 'Available to work overtime/weekends if needed?', answer: '', category: 'availability', type: 'dropdown', options: ['', 'Yes', 'No'] },

  // ── Salary ──
  { question: 'Desired annual salary (USD)', answer: '', category: 'salary', type: 'short' },
  { question: 'Desired hourly rate (if applicable)', answer: '', category: 'salary', type: 'short' },

  // ── Background ──
  { question: 'Willing to undergo a background check?', answer: '', category: 'background', type: 'dropdown', options: ['', 'Yes', 'No'] },
  { question: 'Willing to undergo a drug test?', answer: '', category: 'background', type: 'dropdown', options: ['', 'Yes', 'No'] },
  { question: 'Previously employed by or applied to this company?', answer: '', category: 'background', type: 'dropdown', options: ['', 'Yes', 'No'] },
  { question: 'Subject to a non-compete agreement?', answer: '', category: 'background', type: 'dropdown', options: ['', 'Yes', 'No'] },
  { question: 'Do you have a valid driver\'s license?', answer: '', category: 'background', type: 'dropdown', options: ['', 'Yes', 'No'] },

  // ── Relocation & Commute ──
  { question: 'Willing to relocate?', answer: '', category: 'relocation', type: 'dropdown', options: ['', 'Yes', 'No', 'Open to discussion'] },
  { question: 'Require relocation assistance?', answer: '', category: 'relocation', type: 'dropdown', options: ['', 'Yes', 'No'] },
  { question: 'Preferred work arrangement', answer: '', category: 'relocation', type: 'dropdown', options: ['', 'On-site', 'Hybrid', 'Remote', 'Flexible / Any'] },
  { question: 'Willingness to travel', answer: '', category: 'relocation', type: 'dropdown', options: ['', 'No travel', 'Up to 25%', 'Up to 50%', 'Up to 75%', '100% / Full-time travel'] },

  // ── Referral & Links ──
  { question: 'How did you hear about this position?', answer: '', category: 'referral', type: 'dropdown', options: ['', 'Company Website', 'LinkedIn', 'Indeed', 'Glassdoor', 'Employee Referral', 'Recruiter / Staffing Agency', 'University / Career Fair', 'Google Search', 'Social Media', 'Job Board (other)', 'Other'] },
  { question: 'Referred by a current employee? Name:', answer: '', category: 'referral', type: 'short' },
  { question: 'LinkedIn Profile URL', answer: '', category: 'referral', type: 'short' },
  { question: 'Portfolio / Personal Website URL', answer: '', category: 'referral', type: 'short' },
  { question: 'GitHub Profile URL', answer: '', category: 'referral', type: 'short' },

  // ── Demographics / EEO (Voluntary) ──
  // Clean question names — no examples that could confuse the AI
  { question: 'Gender', answer: '', category: 'demographics', type: 'dropdown', options: ['', 'Male', 'Female', 'Non-binary', 'Other', 'Prefer not to say'] },
  { question: 'Gender identity', answer: '', category: 'demographics', type: 'dropdown', options: ['', 'Man', 'Woman', 'Non-binary', 'Genderqueer / Genderfluid', 'Agender', 'Two-Spirit', 'Other', 'Prefer not to say'] },
  { question: 'Sexual orientation', answer: '', category: 'demographics', type: 'dropdown', options: ['', 'Straight / Heterosexual', 'Gay or Lesbian', 'Bisexual', 'Pansexual', 'Asexual', 'Queer', 'Other', 'Prefer not to say'] },
  { question: 'Pronouns', answer: '', category: 'demographics', type: 'dropdown', options: ['', 'He/Him', 'She/Her', 'They/Them', 'He/They', 'She/They', 'Other', 'Prefer not to say'] },
  { question: 'Race / Ethnicity', answer: '', category: 'demographics', type: 'dropdown', options: ['', 'American Indian or Alaska Native', 'Asian', 'Black or African American', 'Hispanic or Latino', 'Native Hawaiian or Pacific Islander', 'White', 'Two or more races', 'Other', 'Prefer not to say'] },
  { question: 'Are you Hispanic or Latino?', answer: '', category: 'demographics', type: 'dropdown', options: ['', 'Yes', 'No', 'Decline to self-identify'] },
  { question: 'Veteran status', answer: '', category: 'demographics', type: 'dropdown', options: ['', 'I am not a protected veteran', 'I identify as one or more of the classifications of a protected veteran', 'I am a disabled veteran', 'Decline to self-identify'] },
  { question: 'Disability status', answer: '', category: 'demographics', type: 'dropdown', options: ['', 'Yes, I have a disability (or previously had a disability)', 'No, I do not have a disability', 'I do not want to answer'] },

  // ── General ──
  { question: 'Highest level of education completed', answer: '', category: 'general', type: 'dropdown', options: ['', 'Less than High School', 'High School Diploma / GED', 'Some College (no degree)', "Associate's Degree", "Bachelor's Degree (BA/BS)", "Master's Degree (MA/MS/MBA)", 'Doctorate (PhD/EdD)', 'Professional Degree (JD/MD/DDS)', 'Prefer not to say'] },
  { question: 'Relevant certifications or professional licenses', answer: '', category: 'general', type: 'short' },
  { question: 'Security clearance', answer: '', category: 'general', type: 'dropdown', options: ['', 'None', 'Confidential', 'Secret', 'Top Secret', 'TS/SCI', 'Eligible but do not currently hold', 'Not applicable'] },
  { question: 'Able to perform essential functions of the job with or without accommodation?', answer: '', category: 'general', type: 'dropdown', options: ['', 'Yes', 'No'] },
  { question: 'Is there anything else you would like us to know?', answer: '', category: 'general', type: 'text' },
];

/**
 * The currently active Q&A category filter.
 * 'all' shows every entry; any other value is a category slug matched against
 * each entry's `category` field during renderQA().
 * @type {string}
 */
let activeQAFilter = 'all';

/**
 * "Load Common Questions" button handler.
 * Deduplicates against the current qaList (by lowercased question text) so
 * running the button multiple times is safe.  After loading, shows the
 * category filter toolbar and hides the button itself.
 */
document.getElementById('loadDefaultQABtn').addEventListener('click', () => {
  // Build a set of already-present question strings to avoid duplicates
  const existingQuestions = new Set(qaList.map(q => q.question.toLowerCase().trim()));
  let added = 0;
  for (const dq of DEFAULT_QA_QUESTIONS) {
    if (!existingQuestions.has(dq.question.toLowerCase().trim())) {
      // Spread to avoid sharing option array references with the DEFAULT constant
      qaList.push({ ...dq });
      added++;
    }
  }
  if (added === 0) {
    showToast('All common questions already loaded.');
  } else {
    showToast(`Added ${added} common questions. Fill in your answers and save.`);
  }
  renderQA();
  // Reveal the category filter now that we have categorised entries
  document.getElementById('qaCategoryFilter').style.display = 'block';
  // The button is no longer needed once the defaults are loaded
  document.getElementById('loadDefaultQABtn').style.display = 'none';
});

/**
 * Category filter button handler.
 * Marks the clicked button as active, updates `activeQAFilter`, and re-renders.
 */
document.querySelectorAll('.qa-filter-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    // Deactivate all filter buttons, then activate the clicked one
    document.querySelectorAll('.qa-filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    activeQAFilter = btn.dataset.cat;
    renderQA();
  });
});

/**
 * "Add Custom Q&A" button handler.
 * Appends a blank custom entry (category = 'custom') to the list and re-renders.
 */
document.getElementById('addQABtn').addEventListener('click', () => {
  if (qaList.length >= 200) {
    showToast('Q&A list is limited to 200 entries. Please remove some before adding new ones.');
    return;
  }
  qaList.push({ question: '', answer: '', category: 'custom' });
  renderQA();
});

/**
 * "Save Q&A" button handler.
 * Persists the current qaList via the background service worker.
 */
document.getElementById('saveQABtn').addEventListener('click', async () => {
  try {
    await sendMessage({ type: 'SAVE_QA_LIST', qaList });
    showToast('Q&A answers saved!');
  } catch (err) {
    showToast('Error: ' + err.message);
  }
});

// ─── AI settings ──────────────────────────────────────────────────────────────

/** Temperature slider — updates the adjacent numeric label in real time. */
const sTemp      = document.getElementById('sTemp');
const tempValue  = document.getElementById('tempValue');
sTemp.addEventListener('input', () => {
  tempValue.textContent = sTemp.value;
});

// ─── Provider UI ──────────────────────────────────────────────────────────────

/**
 * Populates the provider <select> from the registry object returned by
 * GET_PROVIDERS.  Free-tier providers get a visual label appended to their name.
 *
 * @param {Object.<string, {name: string, free?: boolean}>} providers - Provider registry.
 */
function populateProviderDropdown(providers) {
  const select = document.getElementById('sProvider');
  select.innerHTML = '';
  for (const [id, config] of Object.entries(providers)) {
    const option = document.createElement('option');
    option.value = id;
    // U+2014 em-dash used as separator before "Free tier" label
    option.textContent = config.name + (config.free ? ' \u2014 Free tier' : '');
    select.appendChild(option);
  }
}

/**
 * Updates the model dropdown, API key placeholder, and provider hint text
 * whenever the selected provider changes.
 * Attempts to preserve the previously selected model ID if it exists in the new
 * provider's model list; falls back to the provider's default or first model.
 *
 * @param {string} providerId - The provider ID key from the registry.
 */
function updateProviderUI(providerId) {
  const config = providerData[providerId];
  if (!config) return;

  // Rebuild the model dropdown for the new provider
  const modelSelect  = document.getElementById('sModel');
  const currentModel = modelSelect.value; // save before clearing
  modelSelect.innerHTML = '';
  (config.models || []).forEach(m => {
    const opt = document.createElement('option');
    opt.value       = m.id;
    opt.textContent = m.name;
    modelSelect.appendChild(opt);
  });
  // Preserve current selection if valid for new provider, else use default
  if (config.models.some(m => m.id === currentModel)) {
    modelSelect.value = currentModel;
  } else {
    // Optional chaining handles providers with an empty models array gracefully
    modelSelect.value = config.defaultModel || config.models[0]?.id || '';
  }

  // Update the API key input placeholder to show the expected key format
  document.getElementById('sApiKey').placeholder = config.keyPlaceholder || 'Enter API key...';

  // Update the informational hint below the provider dropdown with a clickable link
  const hintEl = document.getElementById('providerHint');
  if (hintEl) {
    if (config.keyUrl) {
      const freeBadge = config.free ? ' — Free tier' : '';
      hintEl.innerHTML = `<a href="${config.keyUrl}" target="_blank" rel="noopener" style="color:#3b82f6;text-decoration:none;">Get your API key here &rarr;</a>${freeBadge}`;
    } else {
      hintEl.textContent = config.hint || '';
    }
  }
}

/** Refresh the model list and UI hints whenever the provider selection changes. */
document.getElementById('sProvider').addEventListener('change', (e) => {
  updateProviderUI(e.target.value);
});

/**
 * Toggle API key field visibility between password-masked and plain text.
 * Button label changes between 'Show' and 'Hide' accordingly.
 */
document.getElementById('toggleKeyBtn').addEventListener('click', () => {
  const input = document.getElementById('sApiKey');
  const btn   = document.getElementById('toggleKeyBtn');
  if (input.type === 'password') {
    input.type    = 'text';
    btn.textContent = 'Hide';
  } else {
    input.type    = 'password';
    btn.textContent = 'Show';
  }
});

/**
 * "Test Connection" button handler.
 * Saves settings first (so the background uses the latest values), then sends a
 * TEST_CONNECTION message and displays the result inline.
 */
document.getElementById('testConnBtn').addEventListener('click', async () => {
  const resultEl = document.getElementById('testResult');
  // Reset to hidden/neutral state before the new attempt
  resultEl.className    = 'test-result';
  resultEl.style.display = 'none';

  // Always save before testing so the background has the current key/model
  await saveSettings();

  try {
    resultEl.textContent   = 'Testing connection...';
    resultEl.className     = 'test-result loading';
    resultEl.style.display = 'block';

    const data = await sendMessage({ type: 'TEST_CONNECTION' });
    resultEl.textContent = 'Connection successful!';
    resultEl.className   = 'test-result success';
  } catch (err) {
    resultEl.textContent = 'Connection failed: ' + err.message;
    resultEl.className   = 'test-result error';
  }
});

/** "Save Settings" button — delegates to saveSettings() then shows a toast. */
document.getElementById('saveSettingsBtn').addEventListener('click', async () => {
  await saveSettings();
  showToast('Settings saved!');
});

/**
 * Collects the current values from the settings form and persists them via the
 * background service worker (SAVE_SETTINGS message).
 * Called both from the save button and pre-emptively before a connection test.
 */
async function saveSettings() {
  const settings = {
    provider:    document.getElementById('sProvider').value,
    apiKey:      document.getElementById('sApiKey').value.trim(),
    model:       document.getElementById('sModel').value,
    temperature: parseFloat(document.getElementById('sTemp').value)
  };
  await sendMessage({ type: 'SAVE_SETTINGS', settings });
}

// ─── Q&A migration ────────────────────────────────────────────────────────────

/**
 * Upgrades stored Q&A entries so that their `type` and `options` fields match
 * the current DEFAULT_QA_QUESTIONS definitions.
 *
 * This is needed when defaults are updated after a user has already saved their
 * answers — for example, when a question's type is changed from 'text' to
 * 'dropdown' or new options are added to an existing dropdown.
 *
 * Migration rules (per stored entry):
 *   1. Look up the entry by its exact question text in the defaults map.
 *   2. If no match, leave the entry unchanged (it is user-custom).
 *   3. If the stored type differs from the default type, OR the stored entry is
 *      a dropdown but is missing its options array, copy `type` and `options`
 *      from the default.  The user's answer is always preserved.
 *   4. If anything changed, silently re-save the full list to storage so the
 *      migration is only applied once.
 *
 * @param {Array} stored - The raw qaList loaded from chrome.storage.
 * @returns {Array} The (possibly updated) list; safe to assign directly to `qaList`.
 */
function migrateQAList(stored) {
  // Index the defaults by question text for O(1) lookup
  const defaultsByQuestion = {};
  DEFAULT_QA_QUESTIONS.forEach(d => { defaultsByQuestion[d.question] = d; });

  let changed = false;
  const migrated = stored.map(item => {
    const def = defaultsByQuestion[item.question];
    // User-custom entry (no matching default) — pass through unchanged
    if (!def) return item;
    // Migrate if type changed or if options are missing on a dropdown entry
    if (item.type !== def.type || (def.type === 'dropdown' && !item.options)) {
      changed = true;
      // Spread to preserve the user's answer while overwriting structural fields
      return { ...item, type: def.type, options: def.options };
    }
    return item;
  });

  // Persist the migrated list if anything changed, so future loads are already clean
  if (changed) {
    sendMessage({ type: 'SAVE_QA_LIST', qaList: migrated }).catch(() => {});
  }
  return migrated;
}

// ─── Initialisation ───────────────────────────────────────────────────────────

/**
 * Bootstraps the profile page by fetching all persisted data in parallel, then
 * populating every section of the UI.
 *
 * Load order (all four fetches run concurrently via Promise.all):
 *   1. GET_PROFILE   → profileData + form population
 *   2. GET_QA_LIST   → qaList (migrated) + Q&A render
 *   3. GET_SETTINGS  → provider/model/key/temperature form
 *   4. GET_PROVIDERS → provider dropdown (must come before settings apply)
 *
 * After the parallel fetches, also fires loadAppliedJobs() and loadProfileSlots()
 * sequentially (they can start immediately but do not block the UI).
 */
async function init() {
  try {
    // Fan out all four background requests simultaneously for fastest page load
    const [profile, qa, settings, providers] = await Promise.all([
      sendMessage({ type: 'GET_PROFILE'   }),
      sendMessage({ type: 'GET_QA_LIST'   }),
      sendMessage({ type: 'GET_SETTINGS'  }),
      sendMessage({ type: 'GET_PROVIDERS' })
    ]);

    // Populate provider dropdown from the registry (single source of truth for providers)
    if (providers) {
      providerData = providers;
      populateProviderDropdown(providers);
    }

    if (profile) {
      profileData = profile;
      populateProfileForm();
      // Show the name / file name in the upload zone so users know a resume is loaded
      const displayName = profile.resumeFileName || profile.name || 'Resume';
      showResumeLoaded(displayName);
    }

    if (qa && qa.length) {
      // Run migration before displaying — fixes any stale type/options from old saves
      qaList = migrateQAList(qa);
      renderQA();
    }

    if (settings) {
      // Apply stored settings to the form; fall back to sensible defaults if missing
      document.getElementById('sProvider').value = settings.provider || 'anthropic';
      // updateProviderUI must run after the provider is set so the model list is correct
      updateProviderUI(settings.provider || 'anthropic');
      document.getElementById('sApiKey').value  = settings.apiKey || '';
      document.getElementById('sModel').value   = settings.model  || 'claude-sonnet-4-20250514';
      // Nullish coalescing: treat null/undefined as 0.3, but allow stored 0
      document.getElementById('sTemp').value    = settings.temperature ?? 0.3;
      tempValue.textContent                      = settings.temperature ?? 0.3;
    }

    // Pre-load applied jobs so the Applied tab is ready before the user clicks it
    loadAppliedJobs();
    // Load multi-slot state (activeSlot, profileSlots, slotNames) from local storage
    await loadProfileSlots();
  } catch (err) {
    // Silently swallow init errors — the UI degrades gracefully to empty state
  }
}

// ─── HTML escaping utilities ──────────────────────────────────────────────────

/**
 * Escapes a string for safe insertion as HTML text content.
 * Uses the browser's own serialiser to avoid hand-rolled regex escaping.
 *
 * @param {string} str - Raw string that may contain HTML special characters.
 * @returns {string} HTML-safe string.
 */
function escapeHTML(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

/**
 * Escapes a string for safe insertion into an HTML attribute value (double-quoted).
 * Handles the four characters that can break out of a quoted attribute context.
 *
 * @param {string} str - Raw attribute value string.
 * @returns {string} Attribute-safe string.
 */
function escapeAttr(str) {
  return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ─── Applied jobs tracker ─────────────────────────────────────────────────────

/**
 * Fetches the applied-jobs list from the background and passes it to renderAppliedJobs.
 * Errors are silently swallowed — the section simply stays empty.
 */
async function loadAppliedJobs() {
  try {
    const jobs = await sendMessage({ type: 'GET_APPLIED_JOBS' });
    renderAppliedJobs(jobs || []);
  } catch (err) {
    // Silently fail — the applied jobs section will show the empty state
  }
}

/**
 * Renders the applied-jobs tracker as an HTML table.
 * Shows an empty-state message when the list is empty.
 * Each row has a Delete button that immediately removes the job from storage
 * and refreshes the table.
 *
 * Score badges are coloured by threshold:
 *   >= 70 → green (strong match)
 *   45-69 → amber (good match)
 *   <  45 → red   (weak match)
 *
 * @param {Array<{id: string, title: string, company: string, location: string,
 *                salary: string, date: string, url: string, score: number}>} jobs
 */
function renderAppliedJobs(jobs) {
  const container = document.getElementById('appliedJobsList');
  const countEl   = document.getElementById('appliedCount');

  if (!jobs.length) {
    container.innerHTML = '<div class="applied-empty">No applied jobs yet. Use the side panel on a job posting to mark jobs as applied.</div>';
    countEl.textContent = '';
    return;
  }

  // Pluralise "job" / "jobs" based on count
  countEl.textContent = jobs.length + ' job' + (jobs.length === 1 ? '' : 's') + ' applied';

  let html = `<table class="applied-table">
    <thead>
      <tr>
        <th>Score</th>
        <th>Title</th>
        <th>Company</th>
        <th>Location</th>
        <th>Salary</th>
        <th>Date</th>
        <th></th>
      </tr>
    </thead>
    <tbody>`;

  for (const job of jobs) {
    // Colour-code the score badge based on the match quality thresholds
    const scoreClass = job.score >= 70 ? 'green' : job.score >= 45 ? 'amber' : 'red';
    const title    = escapeHTML(job.title    || 'Unknown');
    const company  = escapeHTML(job.company  || '');
    const location = escapeHTML(job.location || '-');
    const salary   = escapeHTML(job.salary   || '-');
    const date     = escapeHTML(job.date     || '');
    const url      = escapeAttr(job.url      || '#');

    html += `<tr>
      <td><span class="score-badge score-badge-${scoreClass}">${job.score || 0}</span></td>
      <td><a href="${url}" target="_blank" rel="noopener">${title}</a></td>
      <td>${company}</td>
      <td>${location}</td>
      <td>${salary}</td>
      <td>${date}</td>
      <td><button class="btn btn-danger btn-sm delete-applied" data-id="${escapeAttr(job.id)}">Delete</button></td>
    </tr>`;
  }

  html += '</tbody></table>';
  container.innerHTML = html;

  // Wire delete buttons after the HTML is in the DOM
  container.querySelectorAll('.delete-applied').forEach(btn => {
    btn.addEventListener('click', async () => {
      try {
        await sendMessage({ type: 'DELETE_APPLIED_JOB', jobId: btn.dataset.id });
        showToast('Job removed.');
        // Reload the full list so the deleted row is gone and the count is correct
        loadAppliedJobs();
      } catch (err) {
        showToast('Error: ' + err.message);
      }
    });
  });
}

// ─── Profile slot management ──────────────────────────────────────────────────
// Three named resume slots allow the user to maintain separate profiles for
// different types of job (e.g. engineering, management, consulting).
// The active slot's data is kept in sync with `profileData`; switching slots
// saves the current profile via a deep-copy, then loads the target slot's data.

/**
 * Index of the currently active resume slot (0, 1, or 2).
 * @type {number}
 */
let activeSlot = 0;

/**
 * Array of up to three saved profile snapshots.  null means the slot is empty.
 * Persisted as 'profileSlots' in chrome.storage.local.
 * @type {(Object|null)[]}
 */
let profileSlots = [null, null, null];

/**
 * Display names for the three slots.  Persisted as 'slotNames' in
 * chrome.storage.local and editable via the slot name input.
 * @type {string[]}
 */
let slotNames = ['Resume 1', 'Resume 2', 'Resume 3'];

/**
 * Reads the plain-text header fields from the DOM form back into `profileData`.
 * Called before snapshot-copying the active slot, so the snapshot captures any
 * unsaved edits the user may have typed since the last explicit save.
 */
function syncCurrentProfileFromForm() {
  profileData.name     = document.getElementById('pName').value.trim();
  profileData.email    = document.getElementById('pEmail').value.trim();
  profileData.phone    = document.getElementById('pPhone').value.trim();
  profileData.location = document.getElementById('pLocation').value.trim();
  profileData.linkedin = document.getElementById('pLinkedin').value.trim();
  profileData.website  = document.getElementById('pWebsite').value.trim();
  profileData.summary  = document.getElementById('pSummary').value.trim();
}

/**
 * Refreshes the visual state of all slot buttons to reflect:
 *   - Which slot is active (bold/highlighted via 'active' class)
 *   - Which slots contain data ('has-data' class adds a visual indicator)
 *   - The current human-readable name for each slot
 * Also updates the slot name input to show the active slot's name for editing.
 */
function updateSlotButtons() {
  document.querySelectorAll('.profile-slot-btn').forEach(btn => {
    const slot = parseInt(btn.dataset.slot);
    // Toggle 'active' class — only the current activeSlot should be active
    btn.classList.toggle('active', slot === activeSlot);
    // Toggle 'has-data' if the slot has a non-null profile snapshot
    btn.classList.toggle('has-data', !!profileSlots[slot]);
    // Use the custom name or fall back to "Resume N" (1-based for readability)
    btn.textContent = slotNames[slot] || `Resume ${slot + 1}`;
  });
  // Populate the rename input with the active slot's current name
  document.getElementById('slotNameInput').value = slotNames[activeSlot] || '';
}

/**
 * Loads the multi-slot state from chrome.storage.local and refreshes the UI.
 * Called during init.  Silently ignores storage errors (extension context loss,
 * incognito mode, etc.).
 */
async function loadProfileSlots() {
  try {
    const result = await chrome.storage.local.get(['profileSlots', 'activeProfileSlot', 'slotNames']);
    profileSlots = result.profileSlots || [null, null, null];
    activeSlot   = result.activeProfileSlot || 0;
    slotNames    = result.slotNames || ['Resume 1', 'Resume 2', 'Resume 3'];
    updateSlotButtons();
  } catch (e) { /* ignore */ }
}

/**
 * Slot button click handler.
 * Switching slots involves three steps:
 *   1. Snapshot the current profile (with any unsaved form edits) into the old slot.
 *   2. Load the new slot's profile (or blank it if the slot is empty).
 *   3. Persist the updated slots + active index to chrome.storage.local so the
 *      background service worker also sees the newly active profile.
 */
document.querySelectorAll('.profile-slot-btn').forEach(btn => {
  btn.addEventListener('click', async () => {
    const newSlot = parseInt(btn.dataset.slot);
    // No-op if the user clicks the already-active slot
    if (newSlot === activeSlot) return;

    // Step 1: Capture any form edits and snapshot the current profile
    syncCurrentProfileFromForm();
    // Deep-copy via JSON round-trip to break object references
    profileSlots[activeSlot] = JSON.parse(JSON.stringify(profileData));
    activeSlot = newSlot;

    const newProfile = profileSlots[activeSlot];
    if (newProfile) {
      // Step 2a: Slot has data — deep-copy it into profileData and repopulate the form
      profileData = JSON.parse(JSON.stringify(newProfile));
      populateProfileForm();
      // Show the resume filename or name in the upload zone
      const displayName = profileData.resumeFileName || profileData.name || 'Resume';
      showResumeLoaded(displayName);
    } else {
      // Step 2b: Slot is empty — reset profileData and restore the default upload zone
      profileData = {
        name: '', email: '', phone: '', location: '', linkedin: '', website: '',
        summary: '', skills: [], experience: [], education: [], certifications: [], projects: []
      };
      populateProfileForm();
      // Restore the original drag-and-drop prompt in the upload zone
      document.getElementById('uploadZone').innerHTML = `
        <div class="icon">&#128196;</div>
        <div class="text">Drag & drop your resume or click to browse</div>
        <div class="hint">Supports PDF and DOCX</div>`;
    }

    // Step 3: Persist both the slots array and the active slot index.
    // Also write 'profile' so the background service worker picks up the new active profile.
    await chrome.storage.local.set({
      profileSlots,
      activeProfileSlot: activeSlot,
      profile: profileSlots[activeSlot] || null  // null signals an empty slot to the background
    });
    updateSlotButtons();
    showToast(`Switched to ${slotNames[activeSlot]}.`);
  });
});

/**
 * "Save Name" button handler for the slot rename input.
 * Updates the slotNames array, persists it, and refreshes the slot buttons.
 */
document.getElementById('saveSlotNameBtn').addEventListener('click', async () => {
  const name = document.getElementById('slotNameInput').value.trim();
  if (!name) return;
  slotNames[activeSlot] = name;
  await chrome.storage.local.set({ slotNames });
  updateSlotButtons();
  showToast('Profile renamed.');
});

// ─── Stats dashboard ──────────────────────────────────────────────────────────

/**
 * Computes and renders the stats dashboard by reading directly from
 * chrome.storage.local — specifically two keys:
 *
 *   jm_analysisCache  — Object keyed by URL, each value containing
 *                       { analysis: { matchScore, missingSkills, ... } }
 *   appliedJobs       — Array of applied-job records (used only for the count)
 *
 * Derived metrics:
 *   - Total jobs analyzed  (count of cache entries)
 *   - Total jobs applied   (length of appliedJobs array)
 *   - Average match score  (mean of all numeric matchScore values in cache)
 *   - Score distribution   (green >= 70, amber 45-69, red < 45)
 *   - Top missing skills   (aggregated across all cached analyses, top 8 by frequency)
 *
 * The skill frequency bars are rendered relative to the most-frequent missing
 * skill (which gets a 100% width bar; all others are proportional).
 */
async function renderStats() {
  const container = document.getElementById('statsContent');
  if (!container) return;
  container.innerHTML = '<p style="color:#94a3b8;text-align:center;padding:20px;">Loading\u2026</p>';
  try {
    // Read both storage keys in a single call for efficiency
    const result    = await chrome.storage.local.get(['jm_analysisCache', 'appliedJobs']);
    const cache     = result.jm_analysisCache || {};
    const applied   = result.appliedJobs || [];
    // Flatten the cache object into an array of analysis records
    const analyses  = Object.values(cache);

    // Extract all numeric matchScore values (skip entries where score is undefined)
    const scores    = analyses.map(a => a.analysis?.matchScore).filter(s => typeof s === 'number');
    // Arithmetic mean, rounded to the nearest integer
    const avgScore  = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null;
    // Color the average score using the same green/amber/red thresholds as the badge
    const scoreColor = avgScore === null ? '#94a3b8' : avgScore >= 70 ? '#059669' : avgScore >= 45 ? '#d97706' : '#dc2626';

    // Aggregate missing skills across all analyses into a frequency map
    const skillCounts = {};
    analyses.forEach(a => {
      (a.analysis?.missingSkills || []).forEach(s => {
        skillCounts[s] = (skillCounts[s] || 0) + 1;
      });
    });
    // Sort descending by frequency and take the top 8 for the chart
    const topMissing = Object.entries(skillCounts).sort((a, b) => b[1] - a[1]).slice(0, 8);

    if (analyses.length === 0) {
      container.innerHTML = '<p style="color:#94a3b8;text-align:center;padding:30px 0;">No jobs analyzed yet. Visit a job posting and click Analyze Job in the side panel.</p>';
      return;
    }

    // Count how many scores fall into each tier
    const green = scores.filter(s => s >= 70).length;
    const amber = scores.filter(s => s >= 45 && s < 70).length;
    const red   = scores.filter(s => s < 45).length;

    let html = `
      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-value">${analyses.length}</div>
          <div class="stat-label">Jobs Analyzed</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">${applied.length}</div>
          <div class="stat-label">Jobs Applied</div>
        </div>
        <div class="stat-card">
          <div class="stat-value" style="color:${scoreColor}">${avgScore !== null ? avgScore + '%' : '\u2014'}</div>
          <div class="stat-label">Avg Match Score</div>
        </div>
      </div>`;

    if (scores.length > 0) {
      html += `
        <div class="stat-section-title">Score Distribution</div>
        <div class="score-dist">
          <div class="score-dist-bar" style="background:#d1fae5;color:#059669">${green}<small>Strong \u226570</small></div>
          <div class="score-dist-bar" style="background:#fef3c7;color:#92400e">${amber}<small>Good 45\u201369</small></div>
          <div class="score-dist-bar" style="background:#fee2e2;color:#dc2626">${red}<small>Low &lt;45</small></div>
        </div>`;
    }

    if (topMissing.length > 0) {
      // The most-frequent skill defines the 100% width; all others are proportional
      const maxCount = topMissing[0][1];
      html += `<div class="stat-section-title">Skills to Add to Your Resume</div>
        <p style="font-size:12px;color:#94a3b8;margin-bottom:12px;">Appears as missing across your analyzed jobs.</p>`;
      topMissing.forEach(([skill, count]) => {
        // Percentage relative to the highest-count skill for proportional bar widths
        const pct = Math.round((count / maxCount) * 100);
        html += `
          <div class="skill-freq-bar">
            <div class="skill-freq-name">${escapeHTML(skill)}</div>
            <div class="skill-freq-track"><div class="skill-freq-fill" style="width:${pct}%"></div></div>
            <div class="skill-freq-count">${count}x</div>
          </div>`;
      });
    }

    container.innerHTML = html;
  } catch (err) {
    container.innerHTML = `<p style="color:#dc2626;">Error loading stats: ${escapeHTML(err.message)}</p>`;
  }
}

// ─── Hash navigation ──────────────────────────────────────────────────────────

/**
 * Reads the URL fragment (e.g. "#settings") and activates the matching tab.
 * Allows external pages (popup, options, notifications) to deep-link directly
 * into a specific section of the profile page.
 * Only acts on known tab names; unknown hashes are silently ignored.
 */
function handleHash() {
  const hash      = window.location.hash.replace('#', '');
  const validTabs = ['profile', 'qa', 'applied', 'stats', 'settings'];
  if (validTabs.includes(hash)) {
    // Deactivate all tabs and panels first
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    // Activate the target tab button and its content panel
    document.querySelector('[data-tab="' + hash + '"]').classList.add('active');
    document.getElementById('tab-' + hash).classList.add('active');
    // Lazy-load data for tabs that fetch it on demand
    if (hash === 'applied') loadAppliedJobs();
    if (hash === 'stats')   renderStats();
  }
}

// ─── Theme management ─────────────────────────────────────────────────────────

const THEME_ORDER_PROFILE = ['blue', 'dark', 'warm'];
const THEME_HEADER_COLORS = { blue: '#3b82f6', dark: '#1e3a5f', warm: '#d97706' };
const THEME_ICONS_PROFILE = { blue: '\u2600\uFE0F', dark: '\uD83C\uDF19', warm: '\uD83C\uDF3B' };

/**
 * Applies the given theme to the profile page body.
 * @param {string} theme - 'blue', 'dark', or 'warm'
 */
function applyProfileTheme(theme) {
  document.body.classList.remove('theme-dark', 'theme-warm');
  if (theme === 'dark') document.body.classList.add('theme-dark');
  if (theme === 'warm') document.body.classList.add('theme-warm');
  // Update the theme button indicator
  const btn = document.getElementById('profileThemeToggle');
  if (btn) {
    const nextIdx = (THEME_ORDER_PROFILE.indexOf(theme) + 1) % THEME_ORDER_PROFILE.length;
    const nextTheme = THEME_ORDER_PROFILE[nextIdx];
    btn.textContent = THEME_ICONS_PROFILE[theme] || THEME_ICONS_PROFILE.blue;
    const nextName = nextTheme === 'blue' ? 'Ocean Blue' : nextTheme === 'dark' ? 'Dark Mode' : 'Warm Amber';
    btn.title = `Switch to ${nextName}`;
  }
}

/**
 * Loads the saved theme from storage and applies it to the profile page.
 */
async function loadProfileTheme() {
  try {
    const result = await chrome.storage.local.get('jm_theme');
    const theme = result.jm_theme || 'blue';
    if (THEME_ORDER_PROFILE.includes(theme)) {
      applyProfileTheme(theme);
    }
  } catch (e) { /* ignore */ }
}

/**
 * Cycles to the next theme, saves it, and applies it.
 */
let _profileCurrentTheme = 'blue';
document.getElementById('profileThemeToggle').addEventListener('click', async () => {
  const result = await chrome.storage.local.get('jm_theme');
  _profileCurrentTheme = result.jm_theme || 'blue';
  const idx = THEME_ORDER_PROFILE.indexOf(_profileCurrentTheme);
  const nextTheme = THEME_ORDER_PROFILE[(idx + 1) % THEME_ORDER_PROFILE.length];
  _profileCurrentTheme = nextTheme;
  try {
    await chrome.storage.local.set({ jm_theme: nextTheme });
  } catch (e) { /* ignore */ }
  applyProfileTheme(nextTheme);
});

// Load theme immediately on page load
loadProfileTheme();

// ─── Entry point ─────────────────────────────────────────────────────────────

// Kick off data loading and form population
init();

// Handle any fragment present in the initial URL (e.g. arriving via a link)
handleHash();

// Re-run handleHash whenever the fragment changes without a full page navigation
window.addEventListener('hashchange', handleHash);
