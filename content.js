// content.js — Side panel UI + JD extraction + autofill
// Injected into every page by manifest.json content_scripts

(function() {
  'use strict';

  // Prevent double injection
  if (window.__jobmatchAILoaded) return;
  window.__jobmatchAILoaded = true;

  // ─── State ──────────────────────────────────────────────────────

  let panelOpen = false;
  let currentAnalysis = null;
  let panelRoot = null;
  let shadowRoot = null;
  const analysisCache = {}; // keyed by URL

  // ─── Shadow DOM panel creation ──────────────────────────────────

  function createPanel() {
    const host = document.createElement('div');
    host.id = 'jobmatch-ai-panel-host';
    document.body.appendChild(host);

    shadowRoot = host.attachShadow({ mode: 'closed' });
    panelRoot = host;

    const style = document.createElement('style');
    style.textContent = getPanelCSS();
    shadowRoot.appendChild(style);

    const panel = document.createElement('div');
    panel.id = 'jm-panel';
    panel.innerHTML = getPanelHTML();
    shadowRoot.appendChild(panel);

    // Wire up event listeners inside shadow DOM
    wireEvents(panel);

    return host;
  }

  function getPanelCSS() {
    return `
      * { margin: 0; padding: 0; box-sizing: border-box; }

      #jm-panel {
        position: fixed;
        top: 0;
        right: 0;
        width: 380px;
        height: 100vh;
        background: #f8f9fb;
        box-shadow: -4px 0 20px rgba(0,0,0,0.15);
        display: flex;
        flex-direction: column;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        font-size: 14px;
        color: #1a1a2e;
        overflow: hidden;
        transform: translateX(100%);
        transition: transform 0.3s ease;
      }

      #jm-panel.open { transform: translateX(0); }

      .jm-header {
        background: linear-gradient(135deg, #667eea, #764ba2);
        color: white;
        padding: 16px 20px;
        display: flex;
        justify-content: space-between;
        align-items: center;
        flex-shrink: 0;
      }

      .jm-header h2 { font-size: 16px; font-weight: 600; }
      .jm-header .jm-subtitle { font-size: 11px; opacity: 0.8; }

      .jm-close {
        background: rgba(255,255,255,0.2);
        border: none;
        color: white;
        width: 28px;
        height: 28px;
        border-radius: 6px;
        cursor: pointer;
        font-size: 18px;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: background 0.2s;
      }
      .jm-close:hover { background: rgba(255,255,255,0.35); }

      .jm-nav {
        display: flex;
        background: white;
        border-bottom: 1px solid #e2e8f0;
        flex-shrink: 0;
      }

      .jm-nav-btn {
        flex: 1;
        padding: 9px 0;
        border: none;
        background: none;
        font-size: 12px;
        font-weight: 500;
        color: #64748b;
        cursor: pointer;
        transition: color 0.2s, background 0.2s;
        font-family: inherit;
        text-align: center;
      }

      .jm-nav-btn:hover {
        color: #667eea;
        background: #f0f2ff;
      }

      .jm-body {
        flex: 1;
        overflow-y: auto;
        padding: 20px;
      }

      .jm-actions {
        display: flex;
        flex-direction: column;
        gap: 10px;
        margin-bottom: 20px;
      }

      .jm-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
        padding: 12px 16px;
        border: none;
        border-radius: 10px;
        font-size: 14px;
        font-weight: 500;
        cursor: pointer;
        transition: all 0.2s;
        font-family: inherit;
      }

      .jm-btn-primary {
        background: #667eea;
        color: white;
      }
      .jm-btn-primary:hover { background: #5a6fd6; }

      .jm-btn-secondary {
        background: #e2e8f0;
        color: #475569;
      }
      .jm-btn-secondary:hover { background: #cbd5e1; }

      .jm-btn-success {
        background: #d1fae5;
        color: #059669;
      }
      .jm-btn-success:hover { background: #a7f3d0; }

      .jm-btn-applied {
        background: #7c3aed;
        color: white;
      }
      .jm-btn-applied:hover { background: #6d28d9; }

      .jm-btn-applied-done {
        background: #d8b4fe;
        color: #581c87;
        cursor: default;
      }

      .jm-btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      /* Status bar */
      .jm-status {
        padding: 10px 14px;
        border-radius: 8px;
        font-size: 13px;
        margin-bottom: 16px;
        display: none;
      }
      .jm-status.info { display: block; background: #e0e7ff; color: #4338ca; }
      .jm-status.error { display: block; background: #fee2e2; color: #dc2626; }
      .jm-status.success { display: block; background: #d1fae5; color: #059669; }

      /* Loading spinner */
      .jm-spinner {
        display: inline-block;
        width: 16px;
        height: 16px;
        border: 2px solid rgba(255,255,255,0.3);
        border-top-color: white;
        border-radius: 50%;
        animation: jm-spin 0.6s linear infinite;
      }
      @keyframes jm-spin { to { transform: rotate(360deg); } }

      /* Score display */
      .jm-score-section {
        text-align: center;
        margin-bottom: 20px;
        display: none;
      }

      .jm-score-circle {
        width: 100px;
        height: 100px;
        border-radius: 50%;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        font-size: 32px;
        font-weight: 700;
        color: white;
        margin-bottom: 8px;
      }

      .jm-score-label { font-size: 13px; color: #64748b; }

      .score-green { background: linear-gradient(135deg, #10b981, #059669); }
      .score-amber { background: linear-gradient(135deg, #f59e0b, #d97706); }
      .score-red { background: linear-gradient(135deg, #ef4444, #dc2626); }

      /* Skills tags */
      .jm-section {
        margin-bottom: 16px;
        display: none;
      }

      .jm-section h3 {
        font-size: 13px;
        font-weight: 600;
        color: #475569;
        margin-bottom: 8px;
        text-transform: uppercase;
        letter-spacing: 0.5px;
      }

      .jm-tags {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }

      .jm-tag {
        padding: 4px 10px;
        border-radius: 20px;
        font-size: 12px;
        font-weight: 500;
      }

      .jm-tag-match { background: #d1fae5; color: #059669; }
      .jm-tag-missing { background: #fee2e2; color: #dc2626; }
      .jm-tag-keyword { background: #e0e7ff; color: #4338ca; }

      /* Recommendations */
      .jm-recs {
        list-style: none;
        padding: 0;
      }

      .jm-recs li {
        padding: 8px 0;
        border-bottom: 1px solid #e2e8f0;
        font-size: 13px;
        line-height: 1.5;
        color: #334155;
      }
      .jm-recs li:last-child { border-bottom: none; }

      .jm-recs li::before {
        content: '\\2192 ';
        color: #667eea;
        font-weight: 600;
      }

      /* Insights */
      .jm-insight-block {
        background: white;
        border-radius: 8px;
        padding: 12px;
        margin-bottom: 8px;
        border: 1px solid #e2e8f0;
      }

      .jm-insight-block h4 {
        font-size: 12px;
        font-weight: 600;
        color: #667eea;
        margin-bottom: 4px;
        text-transform: uppercase;
      }

      .jm-insight-block p {
        font-size: 13px;
        color: #475569;
        line-height: 1.5;
      }

      /* Job info */
      .jm-job-info {
        background: white;
        border-radius: 8px;
        padding: 12px;
        margin-bottom: 16px;
        border: 1px solid #e2e8f0;
        display: none;
      }

      .jm-job-info .jm-job-title {
        font-weight: 600;
        font-size: 14px;
        color: #1e293b;
      }

      .jm-job-info .jm-job-company {
        font-size: 13px;
        color: #64748b;
      }

      .jm-job-meta {
        display: flex;
        gap: 12px;
        margin-top: 6px;
        flex-wrap: wrap;
      }

      .jm-job-meta span {
        font-size: 12px;
        color: #64748b;
        display: inline-flex;
        align-items: center;
        gap: 4px;
      }

      /* Toggle button (outside panel) */
      .jm-toggle {
        position: fixed;
        right: 16px;
        bottom: 24px;
        width: 48px;
        height: 48px;
        border-radius: 50%;
        background: linear-gradient(135deg, #667eea, #764ba2);
        color: white;
        border: none;
        cursor: pointer;
        box-shadow: 0 4px 12px rgba(102,126,234,0.4);
        font-size: 20px;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: all 0.2s;
        z-index: 2147483646;
      }
      .jm-toggle:hover {
        transform: scale(1.1);
        box-shadow: 0 6px 16px rgba(102,126,234,0.5);
      }
    `;
  }

  function getPanelHTML() {
    return `
      <div class="jm-header">
        <div>
          <h2>JobMatch AI</h2>
          <div class="jm-subtitle">Resume & Job Analyzer</div>
        </div>
        <button class="jm-close" id="jmClose">&times;</button>
      </div>
      <div class="jm-nav">
        <button class="jm-nav-btn" data-nav="profile">Profile</button>
        <button class="jm-nav-btn" data-nav="qa">Q&A</button>
        <button class="jm-nav-btn" data-nav="settings">Settings</button>
      </div>
      <div class="jm-body">
        <div class="jm-status" id="jmStatus"></div>

        <div class="jm-job-info" id="jmJobInfo">
          <div class="jm-job-title" id="jmJobTitle"></div>
          <div class="jm-job-company" id="jmJobCompany"></div>
          <div class="jm-job-meta">
            <span id="jmJobLocation" style="display:none">&#128205; <span id="jmJobLocationText"></span></span>
            <span id="jmJobSalary" style="display:none">&#128176; <span id="jmJobSalaryText"></span></span>
          </div>
        </div>

        <div class="jm-actions">
          <button class="jm-btn jm-btn-primary" id="jmAnalyze">Analyze Job</button>
          <button class="jm-btn jm-btn-secondary" id="jmAutofill">AutoFill Application</button>
          <button class="jm-btn jm-btn-success" id="jmSaveJob" style="display:none">Save Job</button>
          <button class="jm-btn jm-btn-applied" id="jmMarkApplied" style="display:none">Mark as Applied</button>
        </div>

        <div class="jm-score-section" id="jmScoreSection">
          <div class="jm-score-circle" id="jmScoreCircle">--</div>
          <div class="jm-score-label">Match Score</div>
        </div>

        <div class="jm-section" id="jmMatchingSection">
          <h3>Matching Skills</h3>
          <div class="jm-tags" id="jmMatchingSkills"></div>
        </div>

        <div class="jm-section" id="jmMissingSection">
          <h3>Missing Skills</h3>
          <div class="jm-tags" id="jmMissingSkills"></div>
        </div>

        <div class="jm-section" id="jmRecsSection">
          <h3>Recommendations</h3>
          <ul class="jm-recs" id="jmRecs"></ul>
        </div>

        <div class="jm-section" id="jmInsightsSection">
          <h3>Insights</h3>
          <div id="jmInsights"></div>
        </div>

        <div class="jm-section" id="jmKeywordsSection">
          <h3>ATS Keywords</h3>
          <div class="jm-tags" id="jmKeywords"></div>
        </div>
      </div>
    `;
  }

  function wireEvents(panel) {
    panel.querySelector('#jmClose').addEventListener('click', togglePanel);
    panel.querySelector('#jmAnalyze').addEventListener('click', () => {
      const btn = shadowRoot.getElementById('jmAnalyze');
      // If button says "Re-Analyze", force refresh; otherwise use cache
      const forceRefresh = btn.textContent.trim() === 'Re-Analyze';
      analyzeJob(forceRefresh);
    });
    panel.querySelector('#jmAutofill').addEventListener('click', autofillForm);
    panel.querySelector('#jmSaveJob').addEventListener('click', saveJob);

    panel.querySelector('#jmMarkApplied').addEventListener('click', markApplied);

    // Nav buttons → open profile page at the right tab
    panel.querySelectorAll('.jm-nav-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const tab = btn.dataset.nav;
        chrome.runtime.sendMessage({ type: 'OPEN_PROFILE_TAB', hash: tab });
      });
    });
  }

  // ─── Toggle button (always visible) ────────────────────────────

  function createToggleButton() {
    const btn = document.createElement('button');
    btn.className = 'jm-toggle';
    btn.id = 'jobmatch-ai-toggle';
    btn.innerHTML = '&#9733;'; // star
    btn.title = 'JobMatch AI';
    btn.addEventListener('click', togglePanel);

    // Attach to shadow root for isolation
    const host = document.createElement('div');
    host.id = 'jobmatch-ai-toggle-host';
    const shadow = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = getPanelCSS();
    shadow.appendChild(style);
    shadow.appendChild(btn);
    document.body.appendChild(host);
  }

  // ─── Panel toggle ─────────────────────────────────────────────

  function togglePanel() {
    panelOpen = !panelOpen;
    if (!panelRoot) createPanel();

    const panel = shadowRoot.getElementById('jm-panel');
    const toggleHost = document.getElementById('jobmatch-ai-toggle-host');
    if (panelOpen) {
      panelRoot.classList.add('open');
      panel.classList.add('open');
      if (toggleHost) toggleHost.style.display = 'none';
    } else {
      panel.classList.remove('open');
      panelRoot.classList.remove('open');
      if (toggleHost) toggleHost.style.display = '';
    }
  }

  // ─── Status helpers ───────────────────────────────────────────

  function setStatus(text, type) {
    const el = shadowRoot.getElementById('jmStatus');
    el.textContent = text;
    el.className = 'jm-status ' + type;
  }

  function clearStatus() {
    const el = shadowRoot.getElementById('jmStatus');
    el.className = 'jm-status';
    el.style.display = 'none';
  }

  // ─── Job description extraction ───────────────────────────────

  function extractJobDescription() {
    // ATS-specific selectors
    const selectors = [
      // Greenhouse
      '#content .job-post-content',
      '#content #gh_jid',
      '.job__description',
      // Lever
      '.posting-page .content',
      '.section-wrapper.page-full-width',
      // Workday
      '[data-automation-id="jobPostingDescription"]',
      '.job-description',
      // LinkedIn
      '.jobs-description__content',
      '.description__text',
      '.jobs-box__html-content',
      // Indeed
      '#jobDescriptionText',
      '.jobsearch-jobDescriptionText',
      // Generic
      '[class*="job-description"]',
      '[class*="jobDescription"]',
      '[id*="job-description"]',
      '[id*="jobDescription"]',
      '[class*="posting-description"]',
      'article[class*="job"]',
      '.job-details',
      '.job-content',
    ];

    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.innerText.trim().length > 100) {
        return el.innerText.trim();
      }
    }

    // Fallback: try to find the largest text block on page
    const blocks = document.querySelectorAll('main, article, [role="main"], .content, #content');
    let bestBlock = null;
    let bestLen = 0;
    for (const block of blocks) {
      const text = block.innerText.trim();
      if (text.length > bestLen) {
        bestLen = text.length;
        bestBlock = text;
      }
    }

    if (bestBlock && bestLen > 200) return bestBlock;

    // Last resort: body text
    return document.body.innerText.substring(0, 10000);
  }

  function extractJobTitle() {
    const selectors = [
      'h1.job-title', 'h1.posting-headline', '.job-title h1',
      'h1[class*="title"]', '.jobs-unified-top-card__job-title',
      'h1', '.posting-headline h2',
      'h2.job-title', '[data-automation-id="jobTitle"]'
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.innerText.trim().length > 2 && el.innerText.trim().length < 200) {
        return el.innerText.trim();
      }
    }
    return document.title.split('|')[0].split('-')[0].trim();
  }

  function extractCompany() {
    const selectors = [
      '.company-name', '[class*="company"]', '.posting-categories .location',
      '.jobs-unified-top-card__company-name',
      '[data-automation-id="company"]'
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.innerText.trim().length > 1 && el.innerText.trim().length < 100) {
        return el.innerText.trim();
      }
    }
    return '';
  }

  function extractLocation() {
    const selectors = [
      // LinkedIn
      '.jobs-unified-top-card__bullet',
      '.job-details-jobs-unified-top-card__primary-description-container .tvm__text',
      // Indeed
      '[data-testid="job-location"], .jobsearch-JobInfoHeader-subtitle > div:last-child',
      // Glassdoor
      '[data-test="emp-location"]',
      // Greenhouse
      '.location', '.job-post-location',
      // Lever
      '.posting-categories .sort-by-team.posting-category:nth-child(2)',
      '.posting-categories .location',
      // Workday
      '[data-automation-id="locations"]',
      // Generic
      '[class*="location"]', '[class*="job-location"]',
      '[data-field="location"]', '[itemprop="jobLocation"]'
    ];
    for (const sel of selectors) {
      try {
        const el = document.querySelector(sel);
        if (el) {
          const text = el.innerText.trim();
          if (text.length > 1 && text.length < 150) return text;
        }
      } catch (e) { /* skip invalid selectors */ }
    }
    return '';
  }

  function extractSalary() {
    // Site-specific selectors
    const selectors = [
      // LinkedIn
      '.salary-main-rail__data-body',
      '.jobs-unified-top-card__job-insight--highlight span',
      // Indeed
      '#salaryInfoAndJobType', '.jobsearch-JobMetadataHeader-item',
      '[data-testid="attribute_snippet_testid"]',
      // Glassdoor
      '[data-test="detailSalary"]',
      // Greenhouse / Lever / Workday
      '[data-automation-id="salary"]',
      // Generic
      '[class*="salary"]', '[class*="compensation"]', '[class*="pay-range"]',
      '[data-field="salary"]'
    ];
    for (const sel of selectors) {
      try {
        const el = document.querySelector(sel);
        if (el) {
          const text = el.innerText.trim();
          if (text.length > 1 && text.length < 200 && /\d/.test(text)) return text;
        }
      } catch (e) { /* skip */ }
    }
    // Regex fallback: search JD text for salary patterns
    const jdText = (document.querySelector('.jobs-description__content') ||
                    document.querySelector('#jobDescriptionText') ||
                    document.querySelector('[class*="job-description"]') ||
                    document.body).innerText || '';
    const patterns = [
      /\$[\d,]+(?:\.\d{2})?\s*[-–to]+\s*\$[\d,]+(?:\.\d{2})?(?:\s*\/?\s*(?:year|yr|annually|hour|hr|month|mo))?/i,
      /\$[\d,]+(?:\.\d{2})?\s*(?:\/?\s*(?:year|yr|annually|hour|hr|month|mo))/i,
      /\d{2,3}k\s*[-–to]+\s*\d{2,3}k(?:\s*(?:\/?\s*(?:year|yr|annually))?)/i,
      /(?:salary|compensation|pay)[:\s]*\$[\d,]+(?:\s*[-–to]+\s*\$[\d,]+)?/i
    ];
    for (const pat of patterns) {
      const match = jdText.match(pat);
      if (match) return match[0].trim();
    }
    return '';
  }

  // ─── Analyze job ──────────────────────────────────────────────

  async function analyzeJob(forceRefresh) {
    const btn = shadowRoot.getElementById('jmAnalyze');
    const pageUrl = window.location.href;

    // Check cache first (unless force re-analyze)
    if (!forceRefresh && analysisCache[pageUrl]) {
      const cached = analysisCache[pageUrl];
      currentAnalysis = cached.analysis;
      showJobMeta(cached.title, cached.company, cached.location, cached.salary);
      renderAnalysis(cached.response);
      shadowRoot.getElementById('jmSaveJob').style.display = 'flex';
      btn.textContent = 'Re-Analyze';
      setStatus('Showing cached results.', 'success');
      setTimeout(clearStatus, 2000);
      return;
    }

    btn.disabled = true;
    btn.innerHTML = '<span class="jm-spinner"></span> Analyzing...';

    try {
      const jd = extractJobDescription();
      const title = extractJobTitle();
      const company = extractCompany();
      const location = extractLocation();
      const salary = extractSalary();

      if (jd.length < 50) {
        setStatus('Could not find a job description on this page.', 'error');
        return;
      }

      showJobMeta(title, company, location, salary);
      setStatus('Analyzing job match...', 'info');

      const response = await sendMessage({
        type: 'ANALYZE_JOB',
        jobDescription: jd,
        jobTitle: title,
        company: company
      });

      currentAnalysis = { ...response, title, company, location, salary, url: pageUrl };
      // Cache the result
      analysisCache[pageUrl] = { response, analysis: currentAnalysis, title, company, location, salary };
      renderAnalysis(response);
      clearStatus();

      // Show save & applied buttons
      shadowRoot.getElementById('jmSaveJob').style.display = 'flex';
      const appliedBtn = shadowRoot.getElementById('jmMarkApplied');
      if (appliedBtn.textContent !== 'Applied') {
        appliedBtn.style.display = 'flex';
      }
    } catch (err) {
      setStatus('Error: ' + err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = analysisCache[pageUrl] ? 'Re-Analyze' : 'Analyze Job';
    }
  }

  function showJobMeta(title, company, location, salary) {
    const jobInfo = shadowRoot.getElementById('jmJobInfo');
    shadowRoot.getElementById('jmJobTitle').textContent = title;
    shadowRoot.getElementById('jmJobCompany').textContent = company;
    jobInfo.style.display = 'block';
    if (location) {
      shadowRoot.getElementById('jmJobLocationText').textContent = location;
      shadowRoot.getElementById('jmJobLocation').style.display = 'inline-flex';
    }
    if (salary) {
      shadowRoot.getElementById('jmJobSalaryText').textContent = salary;
      shadowRoot.getElementById('jmJobSalary').style.display = 'inline-flex';
    }
  }

  function renderAnalysis(data) {
    // Score
    const scoreSection = shadowRoot.getElementById('jmScoreSection');
    const scoreCircle = shadowRoot.getElementById('jmScoreCircle');
    const score = data.matchScore || 0;
    scoreCircle.textContent = score;
    scoreCircle.className = 'jm-score-circle ' + getScoreClass(score);
    scoreSection.style.display = 'block';

    // Matching skills
    const matchingSection = shadowRoot.getElementById('jmMatchingSection');
    const matchingEl = shadowRoot.getElementById('jmMatchingSkills');
    if (data.matchingSkills && data.matchingSkills.length) {
      matchingEl.innerHTML = data.matchingSkills.map(s =>
        `<span class="jm-tag jm-tag-match">${escapeHTML(s)}</span>`
      ).join('');
      matchingSection.style.display = 'block';
    }

    // Missing skills
    const missingSection = shadowRoot.getElementById('jmMissingSection');
    const missingEl = shadowRoot.getElementById('jmMissingSkills');
    if (data.missingSkills && data.missingSkills.length) {
      missingEl.innerHTML = data.missingSkills.map(s =>
        `<span class="jm-tag jm-tag-missing">${escapeHTML(s)}</span>`
      ).join('');
      missingSection.style.display = 'block';
    }

    // Recommendations
    const recsSection = shadowRoot.getElementById('jmRecsSection');
    const recsEl = shadowRoot.getElementById('jmRecs');
    if (data.recommendations && data.recommendations.length) {
      recsEl.innerHTML = data.recommendations.map(r =>
        `<li>${escapeHTML(r)}</li>`
      ).join('');
      recsSection.style.display = 'block';
    }

    // Insights
    const insightsSection = shadowRoot.getElementById('jmInsightsSection');
    const insightsEl = shadowRoot.getElementById('jmInsights');
    if (data.insights) {
      let html = '';
      if (data.insights.strengths) {
        html += `<div class="jm-insight-block"><h4>Strengths</h4><p>${escapeHTML(data.insights.strengths)}</p></div>`;
      }
      if (data.insights.gaps) {
        html += `<div class="jm-insight-block"><h4>Gaps</h4><p>${escapeHTML(data.insights.gaps)}</p></div>`;
      }
      insightsEl.innerHTML = html;
      insightsSection.style.display = 'block';

      // Keywords
      if (data.insights.keywords && data.insights.keywords.length) {
        const keySection = shadowRoot.getElementById('jmKeywordsSection');
        const keyEl = shadowRoot.getElementById('jmKeywords');
        keyEl.innerHTML = data.insights.keywords.map(k =>
          `<span class="jm-tag jm-tag-keyword">${escapeHTML(k)}</span>`
        ).join('');
        keySection.style.display = 'block';
      }
    }
  }

  function getScoreClass(score) {
    if (score >= 70) return 'score-green';
    if (score >= 45) return 'score-amber';
    return 'score-red';
  }

  // ─── Save job ─────────────────────────────────────────────────

  async function saveJob() {
    if (!currentAnalysis) return;
    try {
      await sendMessage({
        type: 'SAVE_JOB',
        jobData: {
          title: currentAnalysis.title,
          company: currentAnalysis.company,
          location: currentAnalysis.location || '',
          salary: currentAnalysis.salary || '',
          score: currentAnalysis.matchScore,
          url: currentAnalysis.url,
          analysis: currentAnalysis
        }
      });
      setStatus('Job saved to tracker!', 'success');
      setTimeout(clearStatus, 2000);
    } catch (err) {
      setStatus('Error saving: ' + err.message, 'error');
    }
  }

  // ─── Mark as Applied ─────────────────────────────────────────

  async function markApplied() {
    if (!currentAnalysis) return;
    const btn = shadowRoot.getElementById('jmMarkApplied');
    btn.disabled = true;
    try {
      await sendMessage({
        type: 'MARK_APPLIED',
        jobData: {
          title: currentAnalysis.title,
          company: currentAnalysis.company,
          location: currentAnalysis.location || '',
          salary: currentAnalysis.salary || '',
          score: currentAnalysis.matchScore || 0,
          url: currentAnalysis.url
        }
      });
      btn.textContent = 'Applied';
      btn.className = 'jm-btn jm-btn-applied-done';
      setStatus('Marked as applied!', 'success');
      setTimeout(clearStatus, 2000);
    } catch (err) {
      setStatus('Error: ' + err.message, 'error');
      btn.disabled = false;
    }
  }

  async function checkIfApplied() {
    try {
      const jobs = await sendMessage({ type: 'GET_APPLIED_JOBS' });
      if (jobs && jobs.some(j => j.url === window.location.href)) {
        const btn = shadowRoot.getElementById('jmMarkApplied');
        btn.textContent = 'Applied';
        btn.className = 'jm-btn jm-btn-applied-done';
        btn.style.display = 'flex';
      }
    } catch (e) { /* ignore */ }
  }

  // ─── AutoFill ─────────────────────────────────────────────────

  // Module-level map: question_id → { element(s), actualType }
  let _fieldMap = {};

  async function autofillForm() {
    const btn = shadowRoot.getElementById('jmAutofill');
    btn.disabled = true;
    btn.innerHTML = '<span class="jm-spinner"></span> Scanning form...';

    try {
      // Step 1: detect fields and store DOM references
      _fieldMap = {};
      const questions = detectFormFields();
      if (questions.length === 0) {
        setStatus('No form fields found on this page.', 'error');
        return;
      }

      setStatus(`Found ${questions.length} questions. Getting AI suggestions...`, 'info');

      // Step 2: send serializable questions to AI (no DOM refs)
      const questionsForAI = questions.map(q => {
        const clean = { ...q };
        delete clean._el;
        delete clean._radios;
        return clean;
      });

      const response = await sendMessage({
        type: 'GENERATE_AUTOFILL',
        formFields: questionsForAI
      });

      // Step 3: fill using stored DOM refs — never trust AI field_type
      const answers = response.answers || response;
      setStatus(`Filling fields...`, 'info');
      const filled = await fillFormFromAnswers(answers);
      setStatus(`Filled ${filled} of ${questions.length} fields. Review before submitting!`, 'success');
    } catch (err) {
      setStatus('Error: ' + err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.innerHTML = 'AutoFill Application';
    }
  }

  // ─── Form field detection ─────────────────────────────────────

  function detectFormFields() {
    const questions = [];
    let qIndex = 0;
    const seen = new Set(); // track qids to avoid duplicates

    // ── Helper: build select option data ──
    function buildSelectOptions(selectEl) {
      const optMap = {};
      const optTexts = [];
      Array.from(selectEl.options).forEach(o => {
        const v = o.value.trim();
        const t = o.textContent.trim();
        if (!v || v === '' || v === '-1') return;
        if (!t || /^(select|choose|--|pick)/i.test(t)) return;
        optTexts.push(t);
        optMap[t.toLowerCase()] = o.value;
      });
      return { optMap, optTexts };
    }

    // ── Helper: detect if an input is a custom dropdown trigger ──
    function isCustomDropdown(el) {
      if (el.getAttribute('role') === 'combobox') return true;
      if (el.getAttribute('aria-haspopup') === 'listbox' || el.getAttribute('aria-haspopup') === 'true') return true;
      if (el.getAttribute('aria-autocomplete')) return true;
      if (el.getAttribute('data-testid')?.includes('select')) return true;
      // Check if parent/grandparent looks like a select wrapper
      const wrapper = el.closest('[class*="select"], [class*="dropdown"], [class*="combobox"], [class*="listbox"]');
      if (wrapper && wrapper.querySelector('[role="listbox"], [role="option"], [class*="option"]')) return true;
      return false;
    }

    // ── Helper: read options from custom dropdown's associated listbox ──
    function readCustomOptions(el) {
      const optTexts = [];
      // 1. Check aria-controls / aria-owns
      const listboxId = el.getAttribute('aria-controls') || el.getAttribute('aria-owns');
      if (listboxId) {
        const lb = document.getElementById(listboxId);
        if (lb) {
          lb.querySelectorAll('[role="option"]').forEach(o => {
            const t = o.textContent.trim();
            if (t) optTexts.push(t);
          });
          if (optTexts.length > 0) return optTexts;
        }
      }
      // 2. Search nearby in DOM
      const container = el.closest('[class*="select"], [class*="dropdown"], [class*="field"], [data-testid]') || el.parentElement;
      if (container) {
        container.querySelectorAll('[role="option"], [class*="option"]:not([class*="options"])').forEach(o => {
          const t = o.textContent.trim();
          if (t && !optTexts.includes(t)) optTexts.push(t);
        });
      }
      return optTexts;
    }

    // ── 1. ALL <select> elements (visible AND hidden) ──
    document.querySelectorAll('select').forEach(sel => {
      const qid = sel.id || sel.name;
      if (!qid || seen.has(qid)) return;
      const label = getFieldLabel(sel);
      if (!label && !sel.id && !sel.name) return;

      const { optMap, optTexts } = buildSelectOptions(sel);
      if (optTexts.length === 0) return;

      seen.add(qid);
      questions.push({
        question_id: qid,
        question_text: label || sel.name || '',
        field_type: 'dropdown',
        required: sel.required,
        available_options: optTexts
      });
      _fieldMap[qid] = { el: sel, type: 'dropdown', optionMap: optMap, optionTexts: optTexts, questionText: label || sel.name || '' };
      qIndex++;
    });

    // ── 2. Text inputs, textareas (detect custom dropdowns among them) ──
    document.querySelectorAll(
      'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="checkbox"]):not([type="radio"]):not([type="file"]), textarea'
    ).forEach(input => {
      if (input.offsetParent === null) return;
      const label = getFieldLabel(input);
      const qid = input.id || input.name || ('q_' + qIndex);
      if ((!label && !input.id && !input.name) || seen.has(qid)) return;

      const tag = input.tagName.toLowerCase();

      // Check if this text input is actually a custom dropdown
      if (tag !== 'textarea' && isCustomDropdown(input)) {
        const optTexts = readCustomOptions(input);
        seen.add(qid);
        questions.push({
          question_id: qid,
          question_text: label || input.placeholder || input.name || '',
          field_type: 'dropdown',
          required: input.required,
          available_options: optTexts // may be empty — will be read during fill
        });
        _fieldMap[qid] = { el: input, type: 'custom_dropdown', optionTexts: optTexts, questionText: label || input.placeholder || input.name || '' };
        qIndex++;
        return;
      }

      // Check if a hidden <select> shares this field's container (custom select wrappers)
      const container = input.closest('.field, .form-field, .form-group, [class*="field"], [class*="select"]');
      if (container) {
        const hiddenSelect = container.querySelector('select');
        if (hiddenSelect && !seen.has(hiddenSelect.id || hiddenSelect.name)) {
          const selQid = hiddenSelect.id || hiddenSelect.name || qid;
          if (!seen.has(selQid)) {
            const { optMap, optTexts } = buildSelectOptions(hiddenSelect);
            if (optTexts.length > 0) {
              seen.add(selQid);
              seen.add(qid);
              questions.push({
                question_id: selQid,
                question_text: label || input.placeholder || '',
                field_type: 'dropdown',
                required: input.required || hiddenSelect.required,
                available_options: optTexts
              });
              // Store BOTH the hidden select and the visible input
              _fieldMap[selQid] = {
                el: hiddenSelect, visibleEl: input,
                type: 'dropdown', optionMap: optMap, optionTexts: optTexts,
                questionText: label || input.placeholder || ''
              };
              qIndex++;
              return;
            }
          }
        }
      }

      // Regular text / textarea
      seen.add(qid);
      const fieldType = tag === 'textarea' ? 'textarea' : 'text';
      questions.push({
        question_id: qid,
        question_text: label || input.placeholder || input.name || '',
        field_type: fieldType,
        required: input.required
      });
      _fieldMap[qid] = { el: input, type: fieldType };
      qIndex++;
    });

    // ── 3. Radio button groups ──
    const radioGroups = {};
    document.querySelectorAll('input[type="radio"]').forEach(radio => {
      if (radio.offsetParent === null) return;
      const groupName = radio.name;
      if (!groupName) return;
      if (!radioGroups[groupName]) {
        radioGroups[groupName] = {
          question_id: groupName,
          question_text: getFieldLabel(radio) || groupName.replace(/[_-]/g, ' '),
          field_type: 'radio',
          required: radio.required,
          available_options: [],
          _radios: []
        };
        _fieldMap[groupName] = { type: 'radio', radios: [] };
      }
      const optText = getRadioLabel(radio);
      if (optText && !radioGroups[groupName].available_options.includes(optText)) {
        radioGroups[groupName].available_options.push(optText);
      }
      radioGroups[groupName]._radios.push(radio);
      _fieldMap[groupName].radios.push({ el: radio, text: optText });
    });
    for (const group of Object.values(radioGroups)) {
      if (group.available_options.length > 0) {
        const clean = { ...group };
        delete clean._radios;
        questions.push(clean);
      }
    }

    // ── 4. Standalone checkboxes ──
    document.querySelectorAll('input[type="checkbox"]').forEach(cb => {
      if (cb.offsetParent === null) return;
      const label = getFieldLabel(cb) || getRadioLabel(cb);
      if (!label) return;
      const qid = cb.id || cb.name || ('cb_' + qIndex);
      if (seen.has(qid)) return;
      seen.add(qid);
      questions.push({
        question_id: qid,
        question_text: label,
        field_type: 'checkbox',
        required: cb.required,
        available_options: ['Yes', 'No']
      });
      _fieldMap[qid] = { el: cb, type: 'checkbox' };
      qIndex++;
    });

    console.log('[JobMatch] Detected fields:', questions.map(q => `${q.question_id}(${q.field_type}${q.available_options ? ':' + q.available_options.length + 'opts' : ''})`));
    return questions;
  }

  function getRadioLabel(input) {
    const parentLabel = input.closest('label');
    if (parentLabel) {
      const clone = parentLabel.cloneNode(true);
      clone.querySelectorAll('input').forEach(el => el.remove());
      const text = clone.textContent.trim();
      if (text) return text;
    }
    const next = input.nextSibling;
    if (next && next.nodeType === Node.TEXT_NODE && next.textContent.trim()) {
      return next.textContent.trim();
    }
    if (next && next.nodeType === Node.ELEMENT_NODE && next.tagName === 'LABEL') {
      return next.textContent.trim();
    }
    if (input.getAttribute('aria-label')) return input.getAttribute('aria-label');
    if (input.value && input.value !== 'on') return input.value;
    return '';
  }

  function getFieldLabel(input) {
    // 1. <label for="id">
    if (input.id) {
      const label = document.querySelector(`label[for="${CSS.escape(input.id)}"]`);
      if (label) return label.textContent.trim();
    }

    // 2. Wrapping <label>
    const parentLabel = input.closest('label');
    if (parentLabel) {
      const clone = parentLabel.cloneNode(true);
      clone.querySelectorAll('input, textarea, select').forEach(el => el.remove());
      const text = clone.textContent.trim();
      if (text) return text;
    }

    // 3. aria-label
    if (input.getAttribute('aria-label')) return input.getAttribute('aria-label');

    // 4. aria-labelledby
    const labelledBy = input.getAttribute('aria-labelledby');
    if (labelledBy) {
      const el = document.getElementById(labelledBy);
      if (el) return el.textContent.trim();
    }

    // 5. placeholder
    if (input.placeholder) return input.placeholder;

    // 6. name attribute (humanized)
    if (input.name) return input.name.replace(/[_-]/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2');

    return '';
  }

  // ─── Form filling (uses _fieldMap from detection) ────────────

  async function fillFormFromAnswers(answers) {
    // Handle array format (new) or flat object (legacy)
    if (!Array.isArray(answers)) {
      return await fillFormLegacy(answers);
    }

    let filled = 0;
    for (const ans of answers) {
      const val = ans.selected_option || ans.generated_text || '';
      if (!val || val === 'NEEDS_USER_INPUT') continue;
      const qid = ans.question_id;

      try {
        const ref = _fieldMap[qid];
        if (!ref) {
          console.warn('[JobMatch] No DOM ref for', qid);
          continue;
        }

        console.log('[JobMatch] Filling', qid, 'type:', ref.type, 'val:', val);

        // Route by ACTUAL element type
        if (ref.type === 'dropdown') {
          // For native selects: use deterministic matcher via background for better accuracy
          const questionText = ref.questionText || ans.question_text || '';
          if (questionText && ref.optionTexts && ref.optionTexts.length > 0) {
            try {
              const bestOption = await sendMessage({
                type: 'MATCH_DROPDOWN',
                questionText: questionText,
                options: ref.optionTexts
              });
              if (bestOption && bestOption !== 'SKIP' && bestOption !== 'NEEDS_USER_INPUT') {
                fillSelectByText(ref.el, bestOption, ref.optionMap, ref.optionTexts);
                filled++;
                continue;
              }
            } catch (e) {
              console.warn('[JobMatch] Deterministic/AI match failed for select, using AI autofill value:', e.message);
            }
          }
          // Fallback: use the bulk AI answer directly
          fillSelectByText(ref.el, val, ref.optionMap, ref.optionTexts);
          filled++;
        } else if (ref.type === 'custom_dropdown') {
          // For custom dropdowns: open → read real options → ask AI → click
          // Pass the question text, not the bulk AI answer
          if (await fillCustomDropdown(ref.el, ref.questionText || val)) filled++;
        } else if (ref.type === 'radio') {
          if (fillRadioFromRef(ref.radios, val)) filled++;
        } else if (ref.type === 'checkbox') {
          fillCheckboxFromRef(ref.el, val);
          filled++;
        } else {
          fillInput(ref.el, val);
          filled++;
        }
      } catch (e) {
        console.warn('[JobMatch] Error filling', qid, e);
      }
    }
    return filled;
  }

  async function fillFormLegacy(mapping) {
    let filled = 0;
    for (const [key, value] of Object.entries(mapping)) {
      if (!value || value === 'NEEDS_USER_INPUT') continue;
      const ref = _fieldMap[key];
      if (!ref) continue;
      if (ref.type === 'dropdown') {
        fillSelectByText(ref.el, value, ref.optionMap, ref.optionTexts);
      } else if (ref.type === 'custom_dropdown') {
        await fillCustomDropdown(ref.el, ref.questionText || value);
      } else {
        fillInput(ref.el, value);
      }
      filled++;
    }
    return filled;
  }

  // ── Custom dropdown: open → read options → ask AI → click chosen option ──
  async function fillCustomDropdown(input, questionText) {
    console.log('[JobMatch] Custom dropdown:', questionText);

    // Step 1: Click to open the dropdown
    input.focus();
    input.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    input.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    input.click();
    await sleep(600);

    // Step 2: Read all visible option elements from the live DOM
    const optionEls = findVisibleOptions(input);
    if (optionEls.length === 0) {
      console.warn('[JobMatch] No options found for:', questionText);
      // Close the dropdown
      document.body.click();
      return false;
    }

    const optionTexts = optionEls.map(o => o.text);
    console.log('[JobMatch] Found', optionTexts.length, 'options:', optionTexts.slice(0, 5), '...');

    // Step 3: Ask AI to pick the best option
    let aiChoice;
    try {
      aiChoice = await sendMessage({
        type: 'MATCH_DROPDOWN',
        questionText: questionText,
        options: optionTexts
      });
    } catch (e) {
      console.warn('[JobMatch] AI match failed:', e.message);
      document.body.click();
      return false;
    }

    console.log('[JobMatch] AI chose:', aiChoice);

    if (!aiChoice || aiChoice === 'SKIP' || aiChoice === 'NEEDS_USER_INPUT') {
      document.body.click();
      return false;
    }

    // Step 4: Find the option element that matches AI's choice and click it
    const choiceLower = aiChoice.toLowerCase().trim();
    const choiceNorm = choiceLower.replace(/[^a-z0-9]/g, '');

    // Exact text match
    for (const opt of optionEls) {
      if (opt.text.toLowerCase().trim() === choiceLower) {
        clickElement(opt.el);
        console.log('[JobMatch] SELECTED:', opt.text);
        await sleep(200);
        return true;
      }
    }

    // Normalized match
    for (const opt of optionEls) {
      if (opt.text.toLowerCase().replace(/[^a-z0-9]/g, '') === choiceNorm) {
        clickElement(opt.el);
        console.log('[JobMatch] SELECTED (normalized):', opt.text);
        await sleep(200);
        return true;
      }
    }

    // Partial/contains match
    for (const opt of optionEls) {
      const optLower = opt.text.toLowerCase().trim();
      if (optLower.includes(choiceLower) || choiceLower.includes(optLower)) {
        clickElement(opt.el);
        console.log('[JobMatch] SELECTED (partial):', opt.text);
        await sleep(200);
        return true;
      }
    }

    console.warn('[JobMatch] Could not find AI choice in options:', aiChoice);
    document.body.click();
    return false;
  }

  function findVisibleOptions(triggerEl) {
    const results = [];
    const seen = new Set();

    // Strategy 1: ARIA — find listbox via aria-controls/aria-owns
    const lbId = triggerEl.getAttribute('aria-controls') || triggerEl.getAttribute('aria-owns');
    if (lbId) {
      const lb = document.getElementById(lbId);
      if (lb) collectOptions(lb.querySelectorAll('[role="option"]'), results, seen);
    }

    // Strategy 2: Search nearby container
    const container = triggerEl.closest(
      '[class*="select"], [class*="dropdown"], [class*="field"], [class*="combobox"], [data-testid]'
    ) || triggerEl.parentElement?.parentElement;
    if (container) {
      collectOptions(container.querySelectorAll('[role="option"], [class*="option"]:not([class*="options"])'), results, seen);
    }

    // Strategy 3: Search entire document for visible options (dropdown might be portaled)
    if (results.length === 0) {
      const allOptions = document.querySelectorAll(
        '[role="option"], [role="listbox"] > *, .dropdown-option, [class*="menu-item"], [class*="listbox-option"]'
      );
      collectOptions(allOptions, results, seen);
    }

    return results;
  }

  function collectOptions(nodeList, results, seen) {
    for (const el of nodeList) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      const text = el.textContent.trim();
      if (!text || seen.has(text)) continue;
      if (/^(select|choose|--|pick|search)/i.test(text)) continue;
      seen.add(text);
      results.push({ el, text });
    }
  }

  function clickElement(el) {
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    el.click();
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // ── Select: match AI's option text → actual option value, then select it ──
  function fillSelectByText(select, aiText, optionMap, optionTexts) {
    const text = String(aiText).trim();
    const textLower = text.toLowerCase();

    // 1. Exact text match → get the real value from our map
    if (optionMap && optionMap[textLower] !== undefined) {
      select.value = optionMap[textLower];
      fireEvents(select);
      console.log('[JobMatch] SELECT exact text match:', text);
      return;
    }

    // 2. Try matching against actual <option> elements directly
    const realOptions = Array.from(select.options).filter(o =>
      o.value.trim() && o.value.trim() !== '-1' && o.textContent.trim()
    );

    // Exact value match (AI returned the value attribute)
    for (const opt of realOptions) {
      if (opt.value === text || opt.value.toLowerCase() === textLower) {
        select.value = opt.value;
        fireEvents(select);
        console.log('[JobMatch] SELECT value match:', text);
        return;
      }
    }

    // 3. Normalized match — strip all non-alphanumeric chars
    const norm = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    const textNorm = norm(text);
    for (const opt of realOptions) {
      if (norm(opt.textContent) === textNorm) {
        select.value = opt.value;
        fireEvents(select);
        console.log('[JobMatch] SELECT normalized match:', text, '→', opt.textContent.trim());
        return;
      }
    }

    // 4. Partial / contains match on text
    for (const opt of realOptions) {
      const optText = opt.textContent.trim().toLowerCase();
      if (optText.includes(textLower) || textLower.includes(optText)) {
        select.value = opt.value;
        fireEvents(select);
        console.log('[JobMatch] SELECT partial match:', text, '→', opt.textContent.trim());
        return;
      }
    }

    // 4. Best fuzzy match — word overlap + prefix scoring
    let bestOpt = null;
    let bestScore = 0;
    const words = textLower.split(/[\s,\/\-_]+/).filter(Boolean);
    for (const opt of realOptions) {
      const optText = opt.textContent.trim().toLowerCase();
      const optWords = optText.split(/[\s,\/\-_]+/).filter(Boolean);
      let score = 0;
      for (const w of words) {
        for (const ow of optWords) {
          if (w === ow) { score += 10; continue; }
          let p = 0;
          while (p < w.length && p < ow.length && w[p] === ow[p]) p++;
          if (p >= 2) score += p;
        }
      }
      if (score > bestScore) { bestScore = score; bestOpt = opt; }
    }
    if (bestOpt && bestScore >= 3) {
      select.value = bestOpt.value;
      fireEvents(select);
      console.log('[JobMatch] SELECT fuzzy match:', text, '→', bestOpt.textContent.trim(), 'score:', bestScore);
      return;
    }

    console.warn('[JobMatch] SELECT no match for:', text, 'in', optionTexts);
  }

  // ── Radio: use stored refs directly ──
  function fillRadioFromRef(radioRefs, selectedText) {
    const target = selectedText.toLowerCase().trim();

    // Exact label match
    for (const r of radioRefs) {
      if (r.text.toLowerCase().trim() === target || r.el.value.toLowerCase().trim() === target) {
        r.el.checked = true;
        fireEvents(r.el);
        return true;
      }
    }
    // Partial match
    for (const r of radioRefs) {
      const label = r.text.toLowerCase().trim();
      const val = r.el.value.toLowerCase().trim();
      if (label.includes(target) || target.includes(label) ||
          val.includes(target) || target.includes(val)) {
        r.el.checked = true;
        fireEvents(r.el);
        return true;
      }
    }
    return false;
  }

  // ── Checkbox: use stored ref directly ──
  function fillCheckboxFromRef(cb, value) {
    const shouldCheck = /^(yes|true|1|checked|agree|accept)$/i.test(String(value).trim());
    if (cb.checked !== shouldCheck) {
      cb.checked = shouldCheck;
      fireEvents(cb);
    }
  }

  // ── Shared event dispatcher ──
  function fireEvents(el) {
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
  }

  function fillInput(input, value) {
    // React-compatible value setter
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, 'value'
    )?.set;
    const nativeTextAreaValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype, 'value'
    )?.set;

    const setter = input.tagName.toLowerCase() === 'textarea'
      ? nativeTextAreaValueSetter
      : nativeInputValueSetter;

    if (setter) {
      setter.call(input, value);
    } else {
      input.value = value;
    }

    // Dispatch events for frameworks
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new Event('blur', { bubbles: true }));
  }


  // ─── Message handling ─────────────────────────────────────────

  function sendMessage(msg) {
    return new Promise((resolve, reject) => {
      try {
        if (!chrome.runtime?.id) {
          return reject(new Error('Extension was updated. Please refresh this page (F5) and try again.'));
        }
        chrome.runtime.sendMessage(msg, (resp) => {
          if (chrome.runtime.lastError) {
            const errMsg = chrome.runtime.lastError.message || '';
            if (errMsg.includes('invalidated') || errMsg.includes('Extension context')) {
              return reject(new Error('Extension was updated. Please refresh this page (F5) and try again.'));
            }
            return reject(new Error(errMsg));
          }
          if (!resp) return reject(new Error('No response'));
          if (!resp.success) return reject(new Error(resp.error));
          resolve(resp.data);
        });
      } catch (e) {
        reject(new Error('Extension was updated. Please refresh this page (F5) and try again.'));
      }
    });
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message.type) {
      case 'TOGGLE_PANEL':
        togglePanel();
        sendResponse({ success: true });
        break;
      case 'TRIGGER_ANALYZE':
        if (!panelOpen) togglePanel();
        setTimeout(analyzeJob, 300);
        sendResponse({ success: true });
        break;
      case 'TRIGGER_AUTOFILL':
        if (!panelOpen) togglePanel();
        setTimeout(autofillForm, 300);
        sendResponse({ success: true });
        break;
    }
    return true;
  });

  // ─── Utility ──────────────────────────────────────────────────

  function escapeHTML(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ─── Initialize ───────────────────────────────────────────────

  createPanel();
  createToggleButton();
  checkIfApplied();

})();
