// profile.js — Resume management, Q&A, and AI settings

// ─── State ──────────────────────────────────────────────────────────

let profileData = {
  name: '', email: '', phone: '', location: '',
  linkedin: '', website: '', summary: '',
  skills: [], experience: [], education: [],
  certifications: [], projects: []
};

let qaList = [];
let providerData = {};

// ─── Helpers ────────────────────────────────────────────────────────

function sendMessage(msg) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (resp) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!resp) return reject(new Error('No response from background'));
      if (!resp.success) return reject(new Error(resp.error));
      resolve(resp.data);
    });
  });
}

function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2500);
}

function setUploadStatus(text, type) {
  const el = document.getElementById('uploadStatus');
  el.textContent = text;
  el.className = 'upload-status ' + type;
}

function showResumeLoaded(fileName) {
  const zone = document.getElementById('uploadZone');
  const name = fileName || 'Resume';
  zone.innerHTML = `
    <div class="icon" style="color: #059669;">&#9989;</div>
    <div class="text" style="color: #059669; font-weight: 600;">${escapeHTML(name)}</div>
    <div class="hint">Resume loaded. Click or drag to upload a different one.</div>
  `;
}

// ─── Tab switching ──────────────────────────────────────────────────

document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById('tab-' + tab.dataset.tab).classList.add('active');
    if (tab.dataset.tab === 'applied') loadAppliedJobs();
    if (tab.dataset.tab === 'stats') renderStats();
  });
});

// ─── Resume upload ──────────────────────────────────────────────────

const uploadZone = document.getElementById('uploadZone');
const fileInput = document.getElementById('fileInput');

uploadZone.addEventListener('click', () => fileInput.click());
uploadZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  uploadZone.classList.add('drag-over');
});
uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('drag-over'));
uploadZone.addEventListener('drop', (e) => {
  e.preventDefault();
  uploadZone.classList.remove('drag-over');
  if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
});
fileInput.addEventListener('change', () => {
  if (fileInput.files.length) handleFile(fileInput.files[0]);
});

async function handleFile(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  if (!['pdf', 'docx'].includes(ext)) {
    setUploadStatus('Please upload a PDF or DOCX file.', 'error');
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

    if (!rawText || rawText.trim().length < 20) {
      setUploadStatus('Could not extract enough text from file.', 'error');
      return;
    }

    setUploadStatus('Parsing resume with AI... This may take a moment.', 'loading');

    const parsed = await sendMessage({ type: 'PARSE_RESUME', rawText });
    profileData = { ...profileData, ...parsed, resumeFileName: file.name };
    populateProfileForm();
    showResumeLoaded(file.name);
    setUploadStatus('Resume parsed successfully! Review and edit below.', 'success');
  } catch (err) {
    setUploadStatus('Error: ' + err.message, 'error');
  }
}

async function extractPDF(file) {
  const arrayBuffer = await file.arrayBuffer();
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'libs/pdf.worker.min.js';
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  let text = '';
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    text += content.items.map(item => item.str).join(' ') + '\n';
  }
  return text;
}

async function extractDOCX(file) {
  const arrayBuffer = await file.arrayBuffer();
  const result = await mammoth.extractRawText({ arrayBuffer });
  return result.value;
}

// ─── Profile form population ────────────────────────────────────────

function populateProfileForm() {
  document.getElementById('pName').value = profileData.name || '';
  document.getElementById('pEmail').value = profileData.email || '';
  document.getElementById('pPhone').value = profileData.phone || '';
  document.getElementById('pLocation').value = profileData.location || '';
  document.getElementById('pLinkedin').value = profileData.linkedin || '';
  document.getElementById('pWebsite').value = profileData.website || '';
  document.getElementById('pSummary').value = profileData.summary || '';

  renderSkills();
  renderCerts();
  renderExperience();
  renderEducation();
  renderProjects();
}

// ─── Skills ─────────────────────────────────────────────────────────

function renderSkills() {
  const container = document.getElementById('skillsContainer');
  container.innerHTML = '';
  (profileData.skills || []).forEach((skill, i) => {
    const tag = document.createElement('span');
    tag.className = 'skill-tag';
    tag.innerHTML = `${escapeHTML(skill)} <span class="remove" data-idx="${i}">&times;</span>`;
    container.appendChild(tag);
  });
  container.querySelectorAll('.remove').forEach(btn => {
    btn.addEventListener('click', () => {
      profileData.skills.splice(parseInt(btn.dataset.idx), 1);
      renderSkills();
    });
  });
}

function addSkill() {
  const input = document.getElementById('skillInput');
  const val = input.value.trim();
  if (!val) return;
  if (!profileData.skills) profileData.skills = [];
  if (!profileData.skills.includes(val)) {
    profileData.skills.push(val);
    renderSkills();
  }
  input.value = '';
}

document.getElementById('addSkillBtn').addEventListener('click', addSkill);
document.getElementById('skillInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); addSkill(); }
});

// ─── Certifications ─────────────────────────────────────────────────

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
    });
  });
}

function addCert() {
  const input = document.getElementById('certInput');
  const val = input.value.trim();
  if (!val) return;
  if (!profileData.certifications) profileData.certifications = [];
  if (!profileData.certifications.includes(val)) {
    profileData.certifications.push(val);
    renderCerts();
  }
  input.value = '';
}

document.getElementById('addCertBtn').addEventListener('click', addCert);
document.getElementById('certInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); addCert(); }
});

// ─── Experience ─────────────────────────────────────────────────────

function renderExperience() {
  const list = document.getElementById('experienceList');
  list.innerHTML = '';
  (profileData.experience || []).forEach((exp, i) => {
    list.appendChild(createExperienceEntry(exp, i));
  });
}

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
  div.querySelector('.remove-entry').addEventListener('click', () => {
    profileData.experience.splice(idx, 1);
    renderExperience();
  });
  // Sync edits back to state
  div.querySelectorAll('input, textarea').forEach(input => {
    input.addEventListener('input', () => {
      profileData.experience[idx][input.dataset.field] = input.value;
    });
  });
  return div;
}

document.getElementById('addExpBtn').addEventListener('click', () => {
  if (!profileData.experience) profileData.experience = [];
  profileData.experience.push({ title: '', company: '', dates: '', description: '' });
  renderExperience();
});

// ─── Education ──────────────────────────────────────────────────────

function renderEducation() {
  const list = document.getElementById('educationList');
  list.innerHTML = '';
  (profileData.education || []).forEach((edu, i) => {
    list.appendChild(createEducationEntry(edu, i));
  });
}

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
  });
  div.querySelectorAll('input, textarea').forEach(input => {
    input.addEventListener('input', () => {
      profileData.education[idx][input.dataset.field] = input.value;
    });
  });
  return div;
}

document.getElementById('addEduBtn').addEventListener('click', () => {
  if (!profileData.education) profileData.education = [];
  profileData.education.push({ degree: '', school: '', dates: '', details: '' });
  renderEducation();
});

// ─── Projects ───────────────────────────────────────────────────────

function renderProjects() {
  const list = document.getElementById('projectsList');
  list.innerHTML = '';
  (profileData.projects || []).forEach((proj, i) => {
    list.appendChild(createProjectEntry(proj, i));
  });
}

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
  });
  div.querySelectorAll('input, textarea').forEach(input => {
    input.addEventListener('input', () => {
      const field = input.dataset.field;
      if (field === 'technologies') {
        profileData.projects[idx][field] = input.value.split(',').map(s => s.trim()).filter(Boolean);
      } else {
        profileData.projects[idx][field] = input.value;
      }
    });
  });
  return div;
}

document.getElementById('addProjBtn').addEventListener('click', () => {
  if (!profileData.projects) profileData.projects = [];
  profileData.projects.push({ name: '', description: '', technologies: [] });
  renderProjects();
});

// ─── Save profile ───────────────────────────────────────────────────

document.getElementById('saveProfileBtn').addEventListener('click', async () => {
  // Sync text fields
  profileData.name = document.getElementById('pName').value.trim();
  profileData.email = document.getElementById('pEmail').value.trim();
  profileData.phone = document.getElementById('pPhone').value.trim();
  profileData.location = document.getElementById('pLocation').value.trim();
  profileData.linkedin = document.getElementById('pLinkedin').value.trim();
  profileData.website = document.getElementById('pWebsite').value.trim();
  profileData.summary = document.getElementById('pSummary').value.trim();

  try {
    await sendMessage({ type: 'SAVE_PROFILE', profile: profileData });
    // Also save into the active slot
    profileSlots[activeSlot] = JSON.parse(JSON.stringify(profileData));
    await chrome.storage.local.set({ profileSlots });
    updateSlotButtons();
    showToast('Profile saved!');
  } catch (err) {
    showToast('Error saving: ' + err.message);
  }
});

// ─── Q&A management ─────────────────────────────────────────────────

function renderQA() {
  const list = document.getElementById('qaList');
  list.innerHTML = '';

  // Show filter if we have categorized questions
  const hasCategorized = qaList.some(q => q.category);
  const filterEl = document.getElementById('qaCategoryFilter');
  if (filterEl) filterEl.style.display = hasCategorized ? 'block' : 'none';

  // Hide load button if we already have many questions
  const loadBtn = document.getElementById('loadDefaultQABtn');
  if (loadBtn && qaList.length >= 10) loadBtn.style.display = 'none';

  const categoryLabels = {
    'personal': 'Personal',
    'work-auth': 'Work Auth',
    'availability': 'Availability',
    'salary': 'Salary',
    'background': 'Background',
    'relocation': 'Relocation',
    'referral': 'Referral',
    'demographics': 'Demographics',
    'general': 'General',
    'custom': 'Custom'
  };

  let visibleCount = 0;
  qaList.forEach((qa, i) => {
    const cat = qa.category || 'custom';
    if (activeQAFilter !== 'all' && cat !== activeQAFilter) return;
    visibleCount++;

    const qType = qa.type || 'text';
    const isCustom = !qa.category || qa.category === 'custom';
    const isCompact = (qType === 'short' || qType === 'dropdown') && !isCustom;

    const div = document.createElement('div');
    div.className = 'qa-entry' + (isCompact ? ' qa-compact' : '');

    const badge = qa.category
      ? `<span class="qa-category-badge qa-cat-${cat}">${categoryLabels[cat] || cat}</span>`
      : '';

    if (isCustom) {
      // Custom entries: editable question + textarea answer
      div.innerHTML = `
        <div class="qa-compact-header">
          <label>Q&A #${i + 1}${badge}</label>
          <button class="btn btn-danger btn-sm remove-qa" data-idx="${i}">&times;</button>
        </div>
        <input type="text" data-field="question" value="${escapeAttr(qa.question || '')}" placeholder="Enter your question...">
        <textarea data-field="answer" rows="2" placeholder="Your answer...">${escapeHTML(qa.answer || '')}</textarea>
      `;
    } else if (qType === 'dropdown') {
      // Dropdown: question as label, select for answer
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
      // Short text: question as label, single line input
      div.innerHTML = `
        <div class="qa-compact-header">
          <label>${escapeHTML(qa.question)}${badge}</label>
          <button class="btn btn-danger btn-sm remove-qa" data-idx="${i}">&times;</button>
        </div>
        <input type="text" data-field="answer" value="${escapeAttr(qa.answer || '')}" placeholder="Enter...">
      `;
    } else {
      // Textarea (type='text'): question as label, multi-line input
      div.innerHTML = `
        <div class="qa-compact-header">
          <label>${escapeHTML(qa.question)}${badge}</label>
          <button class="btn btn-danger btn-sm remove-qa" data-idx="${i}">&times;</button>
        </div>
        <textarea data-field="answer" rows="2" placeholder="Your answer...">${escapeHTML(qa.answer || '')}</textarea>
      `;
    }

    div.querySelector('.remove-qa').addEventListener('click', () => {
      qaList.splice(i, 1);
      renderQA();
    });
    div.querySelectorAll('input, textarea, select').forEach(el => {
      const evt = el.tagName === 'SELECT' ? 'change' : 'input';
      el.addEventListener(evt, () => {
        qaList[i][el.dataset.field] = el.value;
      });
    });
    list.appendChild(div);
  });

  if (visibleCount === 0 && activeQAFilter !== 'all') {
    list.innerHTML = '<p style="text-align:center;color:#94a3b8;padding:20px;">No questions in this category.</p>';
  }
}

// ─── Default US job application questions ───────────────────────────

const US_STATES = [
  'AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI','ID','IL','IN',
  'IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH',
  'NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT',
  'VT','VA','WA','WV','WI','WY'
];

const DEFAULT_QA_QUESTIONS = [
  // ── Personal / Address ──
  { question: 'First Name', answer: '', category: 'personal', type: 'short' },
  { question: 'Last Name', answer: '', category: 'personal', type: 'short' },
  { question: 'Email Address', answer: '', category: 'personal', type: 'short' },
  { question: 'Phone Number', answer: '', category: 'personal', type: 'short' },
  { question: 'Street Address', answer: '', category: 'personal', type: 'short' },
  { question: 'Street Address Line 2 (Apt, Suite, Unit)', answer: '', category: 'personal', type: 'short' },
  { question: 'City', answer: '', category: 'personal', type: 'short' },
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
  { question: 'Gender', answer: '', category: 'demographics', type: 'short' },
  { question: 'Gender identity', answer: '', category: 'demographics', type: 'short' },
  { question: 'Sexual orientation', answer: '', category: 'demographics', type: 'short' },
  { question: 'Pronouns', answer: '', category: 'demographics', type: 'short' },
  { question: 'Race / Ethnicity', answer: '', category: 'demographics', type: 'short' },
  { question: 'Are you Hispanic or Latino?', answer: '', category: 'demographics', type: 'dropdown', options: ['', 'Yes', 'No', 'Decline to self-identify'] },
  { question: 'Veteran status', answer: '', category: 'demographics', type: 'short' },
  { question: 'Disability status', answer: '', category: 'demographics', type: 'short' },

  // ── General ──
  { question: 'Highest level of education completed', answer: '', category: 'general', type: 'dropdown', options: ['', 'Less than High School', 'High School Diploma / GED', 'Some College (no degree)', "Associate's Degree", "Bachelor's Degree (BA/BS)", "Master's Degree (MA/MS/MBA)", 'Doctorate (PhD/EdD)', 'Professional Degree (JD/MD/DDS)', 'Prefer not to say'] },
  { question: 'Relevant certifications or professional licenses', answer: '', category: 'general', type: 'short' },
  { question: 'Security clearance', answer: '', category: 'general', type: 'dropdown', options: ['', 'None', 'Confidential', 'Secret', 'Top Secret', 'TS/SCI', 'Eligible but do not currently hold', 'Not applicable'] },
  { question: 'Able to perform essential functions of the job with or without accommodation?', answer: '', category: 'general', type: 'dropdown', options: ['', 'Yes', 'No'] },
  { question: 'Is there anything else you would like us to know?', answer: '', category: 'general', type: 'text' },
];

let activeQAFilter = 'all';

document.getElementById('loadDefaultQABtn').addEventListener('click', () => {
  // Only add questions that don't already exist (by question text)
  const existingQuestions = new Set(qaList.map(q => q.question.toLowerCase().trim()));
  let added = 0;
  for (const dq of DEFAULT_QA_QUESTIONS) {
    if (!existingQuestions.has(dq.question.toLowerCase().trim())) {
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
  // Show category filter
  document.getElementById('qaCategoryFilter').style.display = 'block';
  // Hide the load button section
  document.getElementById('loadDefaultQABtn').style.display = 'none';
});

// Category filter buttons
document.querySelectorAll('.qa-filter-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.qa-filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    activeQAFilter = btn.dataset.cat;
    renderQA();
  });
});

document.getElementById('addQABtn').addEventListener('click', () => {
  qaList.push({ question: '', answer: '', category: 'custom' });
  renderQA();
});

document.getElementById('saveQABtn').addEventListener('click', async () => {
  try {
    await sendMessage({ type: 'SAVE_QA_LIST', qaList });
    showToast('Q&A answers saved!');
  } catch (err) {
    showToast('Error: ' + err.message);
  }
});

// ─── AI Settings ────────────────────────────────────────────────────

const sTemp = document.getElementById('sTemp');
const tempValue = document.getElementById('tempValue');
sTemp.addEventListener('input', () => {
  tempValue.textContent = sTemp.value;
});

// ─── Provider UI ────────────────────────────────────────────────────

function populateProviderDropdown(providers) {
  const select = document.getElementById('sProvider');
  select.innerHTML = '';
  for (const [id, config] of Object.entries(providers)) {
    const option = document.createElement('option');
    option.value = id;
    option.textContent = config.name + (config.free ? ' \u2014 Free tier' : '');
    select.appendChild(option);
  }
}

function updateProviderUI(providerId) {
  const config = providerData[providerId];
  if (!config) return;

  // Update model dropdown
  const modelSelect = document.getElementById('sModel');
  const currentModel = modelSelect.value;
  modelSelect.innerHTML = '';
  (config.models || []).forEach(m => {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.name;
    modelSelect.appendChild(opt);
  });
  // Preserve current selection if valid for new provider, else use default
  if (config.models.some(m => m.id === currentModel)) {
    modelSelect.value = currentModel;
  } else {
    modelSelect.value = config.defaultModel || config.models[0]?.id || '';
  }

  // Update API key placeholder
  document.getElementById('sApiKey').placeholder = config.keyPlaceholder || 'Enter API key...';

  // Update hint
  const hintEl = document.getElementById('providerHint');
  if (hintEl) {
    hintEl.textContent = config.hint || '';
  }
}

document.getElementById('sProvider').addEventListener('change', (e) => {
  updateProviderUI(e.target.value);
});

document.getElementById('toggleKeyBtn').addEventListener('click', () => {
  const input = document.getElementById('sApiKey');
  const btn = document.getElementById('toggleKeyBtn');
  if (input.type === 'password') {
    input.type = 'text';
    btn.textContent = 'Hide';
  } else {
    input.type = 'password';
    btn.textContent = 'Show';
  }
});

document.getElementById('testConnBtn').addEventListener('click', async () => {
  const resultEl = document.getElementById('testResult');
  resultEl.className = 'test-result';
  resultEl.style.display = 'none';

  // Save settings first
  await saveSettings();

  try {
    resultEl.textContent = 'Testing connection...';
    resultEl.className = 'test-result loading';
    resultEl.style.display = 'block';

    const data = await sendMessage({ type: 'TEST_CONNECTION' });
    resultEl.textContent = 'Connection successful!';
    resultEl.className = 'test-result success';
  } catch (err) {
    resultEl.textContent = 'Connection failed: ' + err.message;
    resultEl.className = 'test-result error';
  }
});

document.getElementById('saveSettingsBtn').addEventListener('click', async () => {
  await saveSettings();
  showToast('Settings saved!');
});

async function saveSettings() {
  const settings = {
    provider: document.getElementById('sProvider').value,
    apiKey: document.getElementById('sApiKey').value.trim(),
    model: document.getElementById('sModel').value,
    temperature: parseFloat(document.getElementById('sTemp').value)
  };
  await sendMessage({ type: 'SAVE_SETTINGS', settings });
}

// ─── Load saved data on init ────────────────────────────────────────

async function init() {
  try {
    const [profile, qa, settings, providers] = await Promise.all([
      sendMessage({ type: 'GET_PROFILE' }),
      sendMessage({ type: 'GET_QA_LIST' }),
      sendMessage({ type: 'GET_SETTINGS' }),
      sendMessage({ type: 'GET_PROVIDERS' })
    ]);

    // Populate provider dropdown from registry (single source of truth)
    if (providers) {
      providerData = providers;
      populateProviderDropdown(providers);
    }

    if (profile) {
      profileData = profile;
      populateProfileForm();
      // Show that a resume is already loaded
      const displayName = profile.resumeFileName || profile.name || 'Resume';
      showResumeLoaded(displayName);
    }

    if (qa && qa.length) {
      qaList = qa;
      renderQA();
    }

    if (settings) {
      document.getElementById('sProvider').value = settings.provider || 'anthropic';
      updateProviderUI(settings.provider || 'anthropic');
      document.getElementById('sApiKey').value = settings.apiKey || '';
      document.getElementById('sModel').value = settings.model || 'claude-sonnet-4-20250514';
      document.getElementById('sTemp').value = settings.temperature ?? 0.3;
      tempValue.textContent = settings.temperature ?? 0.3;
    }

    // Pre-load applied jobs
    loadAppliedJobs();
    // Load profile slot state
    await loadProfileSlots();
  } catch (err) {
    console.error('Init error:', err);
  }
}

// ─── Utilities ──────────────────────────────────────────────────────

function escapeHTML(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function escapeAttr(str) {
  return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ─── Applied Jobs ────────────────────────────────────────────────────

async function loadAppliedJobs() {
  try {
    const jobs = await sendMessage({ type: 'GET_APPLIED_JOBS' });
    renderAppliedJobs(jobs || []);
  } catch (err) {
    console.error('Error loading applied jobs:', err);
  }
}

function renderAppliedJobs(jobs) {
  const container = document.getElementById('appliedJobsList');
  const countEl = document.getElementById('appliedCount');

  if (!jobs.length) {
    container.innerHTML = '<div class="applied-empty">No applied jobs yet. Use the side panel on a job posting to mark jobs as applied.</div>';
    countEl.textContent = '';
    return;
  }

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
    const scoreClass = job.score >= 70 ? 'green' : job.score >= 45 ? 'amber' : 'red';
    const title = escapeHTML(job.title || 'Unknown');
    const company = escapeHTML(job.company || '');
    const location = escapeHTML(job.location || '-');
    const salary = escapeHTML(job.salary || '-');
    const date = escapeHTML(job.date || '');
    const url = escapeAttr(job.url || '#');

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

  // Wire delete buttons
  container.querySelectorAll('.delete-applied').forEach(btn => {
    btn.addEventListener('click', async () => {
      try {
        await sendMessage({ type: 'DELETE_APPLIED_JOB', jobId: btn.dataset.id });
        showToast('Job removed.');
        loadAppliedJobs();
      } catch (err) {
        showToast('Error: ' + err.message);
      }
    });
  });
}

// ─── Profile slot management ─────────────────────────────────────────

let activeSlot = 0;
let profileSlots = [null, null, null];
let slotNames = ['Resume 1', 'Resume 2', 'Resume 3'];

function syncCurrentProfileFromForm() {
  profileData.name = document.getElementById('pName').value.trim();
  profileData.email = document.getElementById('pEmail').value.trim();
  profileData.phone = document.getElementById('pPhone').value.trim();
  profileData.location = document.getElementById('pLocation').value.trim();
  profileData.linkedin = document.getElementById('pLinkedin').value.trim();
  profileData.website = document.getElementById('pWebsite').value.trim();
  profileData.summary = document.getElementById('pSummary').value.trim();
}

function updateSlotButtons() {
  document.querySelectorAll('.profile-slot-btn').forEach(btn => {
    const slot = parseInt(btn.dataset.slot);
    btn.classList.toggle('active', slot === activeSlot);
    btn.classList.toggle('has-data', !!profileSlots[slot]);
    btn.textContent = slotNames[slot] || `Resume ${slot + 1}`;
  });
  document.getElementById('slotNameInput').value = slotNames[activeSlot] || '';
}

async function loadProfileSlots() {
  try {
    const result = await chrome.storage.local.get(['profileSlots', 'activeProfileSlot', 'slotNames']);
    profileSlots = result.profileSlots || [null, null, null];
    activeSlot = result.activeProfileSlot || 0;
    slotNames = result.slotNames || ['Resume 1', 'Resume 2', 'Resume 3'];
    updateSlotButtons();
  } catch (e) { /* ignore */ }
}

document.querySelectorAll('.profile-slot-btn').forEach(btn => {
  btn.addEventListener('click', async () => {
    const newSlot = parseInt(btn.dataset.slot);
    if (newSlot === activeSlot) return;

    // Save current slot data before switching
    syncCurrentProfileFromForm();
    profileSlots[activeSlot] = JSON.parse(JSON.stringify(profileData));
    activeSlot = newSlot;

    const newProfile = profileSlots[activeSlot];
    if (newProfile) {
      profileData = JSON.parse(JSON.stringify(newProfile));
      populateProfileForm();
      const displayName = profileData.resumeFileName || profileData.name || 'Resume';
      showResumeLoaded(displayName);
    } else {
      profileData = { name: '', email: '', phone: '', location: '', linkedin: '', website: '',
        summary: '', skills: [], experience: [], education: [], certifications: [], projects: [] };
      populateProfileForm();
      document.getElementById('uploadZone').innerHTML = `
        <div class="icon">&#128196;</div>
        <div class="text">Drag & drop your resume or click to browse</div>
        <div class="hint">Supports PDF and DOCX</div>`;
    }

    await chrome.storage.local.set({
      profileSlots,
      activeProfileSlot: activeSlot,
      profile: profileSlots[activeSlot] || null
    });
    updateSlotButtons();
    showToast(`Switched to ${slotNames[activeSlot]}.`);
  });
});

document.getElementById('saveSlotNameBtn').addEventListener('click', async () => {
  const name = document.getElementById('slotNameInput').value.trim();
  if (!name) return;
  slotNames[activeSlot] = name;
  await chrome.storage.local.set({ slotNames });
  updateSlotButtons();
  showToast('Profile renamed.');
});

// ─── Stats dashboard ─────────────────────────────────────────────────

async function renderStats() {
  const container = document.getElementById('statsContent');
  if (!container) return;
  container.innerHTML = '<p style="color:#94a3b8;text-align:center;padding:20px;">Loading…</p>';
  try {
    const result = await chrome.storage.local.get(['jm_analysisCache', 'appliedJobs']);
    const cache = result.jm_analysisCache || {};
    const applied = result.appliedJobs || [];
    const analyses = Object.values(cache);

    const scores = analyses.map(a => a.analysis?.matchScore).filter(s => typeof s === 'number');
    const avgScore = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null;
    const scoreColor = avgScore === null ? '#94a3b8' : avgScore >= 70 ? '#059669' : avgScore >= 45 ? '#d97706' : '#dc2626';

    const skillCounts = {};
    analyses.forEach(a => {
      (a.analysis?.missingSkills || []).forEach(s => {
        skillCounts[s] = (skillCounts[s] || 0) + 1;
      });
    });
    const topMissing = Object.entries(skillCounts).sort((a, b) => b[1] - a[1]).slice(0, 8);

    if (analyses.length === 0) {
      container.innerHTML = '<p style="color:#94a3b8;text-align:center;padding:30px 0;">No jobs analyzed yet. Visit a job posting and click Analyze Job in the side panel.</p>';
      return;
    }

    const green = scores.filter(s => s >= 70).length;
    const amber = scores.filter(s => s >= 45 && s < 70).length;
    const red = scores.filter(s => s < 45).length;

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
          <div class="stat-value" style="color:${scoreColor}">${avgScore !== null ? avgScore + '%' : '—'}</div>
          <div class="stat-label">Avg Match Score</div>
        </div>
      </div>`;

    if (scores.length > 0) {
      html += `
        <div class="stat-section-title">Score Distribution</div>
        <div class="score-dist">
          <div class="score-dist-bar" style="background:#d1fae5;color:#059669">${green}<small>Strong ≥70</small></div>
          <div class="score-dist-bar" style="background:#fef3c7;color:#92400e">${amber}<small>Good 45–69</small></div>
          <div class="score-dist-bar" style="background:#fee2e2;color:#dc2626">${red}<small>Low &lt;45</small></div>
        </div>`;
    }

    if (topMissing.length > 0) {
      const maxCount = topMissing[0][1];
      html += `<div class="stat-section-title">Skills to Add to Your Resume</div>
        <p style="font-size:12px;color:#94a3b8;margin-bottom:12px;">Appears as missing across your analyzed jobs.</p>`;
      topMissing.forEach(([skill, count]) => {
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

// ─── Handle hash navigation (e.g. profile.html#settings) ────────────

function handleHash() {
  const hash = window.location.hash.replace('#', '');
  const validTabs = ['profile', 'qa', 'applied', 'stats', 'settings'];
  if (validTabs.includes(hash)) {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    document.querySelector('[data-tab="' + hash + '"]').classList.add('active');
    document.getElementById('tab-' + hash).classList.add('active');
    if (hash === 'applied') loadAppliedJobs();
    if (hash === 'stats') renderStats();
  }
}

// ─── Start ──────────────────────────────────────────────────────────

init();
handleHash();
window.addEventListener('hashchange', handleHash);
