/**
 * @file content.js
 * @description Main content script for JobMatch AI.
 *
 * ROLE IN EXTENSION ARCHITECTURE
 * --------------------------------
 * This file is injected into supported job-site pages (LinkedIn, Indeed,
 * Glassdoor, Greenhouse, Lever, Workday, etc.) by the manifest content_scripts
 * declaration.  It runs in the page's context (but is isolated from page JS)
 * and is responsible for ALL user-facing UI and interaction logic.
 *
 * Everything runs inside a single IIFE to avoid polluting the global namespace.
 * The panel and its toggle button each live inside their own Shadow DOM host so
 * the page's CSS can never bleed in and the extension's CSS can never bleed out.
 *
 * KEY RESPONSIBILITIES
 * ---------------------
 * 1. Shadow DOM side panel — renders the full analysis UI (score, skills, recs,
 *    insights, ATS keywords, cover letter, bullet rewriter, notes).
 * 2. Draggable floating ★ button — always-visible trigger that opens/closes panel.
 * 3. Job data extraction — scrapes title, company, location, salary, and the
 *    full job description from the host page using site-specific CSS selectors.
 * 4. Job analysis — sends extracted data to background.js for AI scoring and
 *    caches results in chrome.storage.local to avoid redundant API calls.
 * 5. AutoFill pipeline — detects form fields (text, select, radio, checkbox,
 *    custom dropdowns), sends them to the AI for answer generation, shows a
 *    preview for user review, then fills the form on confirmation.
 * 6. Cover letter & bullet rewriter — post-analysis AI writing tools.
 * 7. Job notes — per-URL free-text notes saved to chrome.storage.local.
 * 8. SPA navigation detection — resets state when LinkedIn/Indeed navigate to a
 *    new job posting without a full page reload.
 */

// Injected into job site pages by manifest.json content_scripts

(function() {
  'use strict';

  // Prevent double injection (e.g. if the content script fires twice on the same page)
  if (window.__jobmatchAILoaded) return;
  window.__jobmatchAILoaded = true;

  // ─── State ──────────────────────────────────────────────────────
  // Module-level variables shared across functions within this IIFE.

  let panelOpen = false;        // Whether the side panel is currently visible
  let currentAnalysis = null;   // The most recent analysis result for the current page
  let panelRoot = null;         // The host DOM element that contains the Shadow DOM panel
  let shadowRoot = null;        // The closed Shadow DOM root — panel elements are queried from here
  let toggleBtnRef = null;      // Reference to the floating toggle button (inside closed Shadow DOM)

  // AutoFill state
  let _pendingAnswers   = null; // kept for legacy compatibility
  let _pendingQuestions = null;
  let _fieldMap         = {};   // Map of question_id → { el, type, ... } built during field detection

  // Inline chip state — chips live in document.body (outside Shadow DOM)
  let _chips             = new Map(); // questionId → { chipEl, fieldEl, ans }
  let _chipBar           = null;      // sticky bottom bar element
  let _chipScrollHandler = null;      // scroll listener reference (for cleanup)
  let _chipResizeObs     = null;      // ResizeObserver reference (for cleanup)

  // Autofill badges — fixed-position pills that don't affect page layout
  let _badges            = [];        // [{ badgeEl, fieldEl, place }] for repositioning + cleanup
  let _badgeScrollHandler = null;     // scroll listener for badge repositioning
  let _badgeResizeObs    = null;      // ResizeObserver for badge repositioning

  // Resume slot switcher state — mirrors chrome.storage.local slot data
  let _activeSlot = 0;                                  // Currently selected slot index (0-2)
  let _slotNames  = ['Resume 1', 'Resume 2', 'Resume 3']; // Display names for each slot
  let _slotHasData = [false, false, false];             // Whether each slot has a profile loaded

  // ─── Persistent analysis cache (chrome.storage.local) ──────────
  // Caching analysis results prevents redundant API calls when the user
  // closes and reopens the panel or navigates back to a job they already viewed.
  // Results are stored under a single 'jm_analysisCache' key as a URL→data map.

  const CACHE_STORAGE_KEY = 'jm_analysisCache'; // Key used in chrome.storage.local
  const MAX_CACHE_ENTRIES = 50;                  // LRU eviction kicks in beyond this limit

  /**
   * Retrieves a cached analysis result for the given page URL.
   * @async
   * @param {string} url - The full URL of the job posting page.
   * @returns {Promise<Object|null>} Cached result or null if not found.
   */
  const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24-hour TTL for cache entries

  async function getCachedAnalysis(url) {
    const result = await chrome.storage.local.get(CACHE_STORAGE_KEY);
    const cache = result[CACHE_STORAGE_KEY] || {};
    const entry = cache[url];
    if (!entry) return null;
    // Expire entries older than 24 hours
    if (entry.timestamp && Date.now() - entry.timestamp > CACHE_TTL_MS) {
      delete cache[url];
      await chrome.storage.local.set({ [CACHE_STORAGE_KEY]: cache });
      return null;
    }
    return entry;
  }

  /**
   * Stores an analysis result for the given URL, evicting the oldest entries
   * when the cache exceeds MAX_CACHE_ENTRIES.
   * @async
   * @param {string} url  - The full URL of the job posting page.
   * @param {Object} data - The analysis payload to cache.
   */
  async function setCachedAnalysis(url, data) {
    const result = await chrome.storage.local.get(CACHE_STORAGE_KEY);
    const cache = result[CACHE_STORAGE_KEY] || {};
    cache[url] = { ...data, timestamp: Date.now() };
    // Evict oldest entries (Object.keys preserves insertion order in V8)
    const keys = Object.keys(cache);
    if (keys.length > MAX_CACHE_ENTRIES) {
      keys.slice(0, keys.length - MAX_CACHE_ENTRIES).forEach(k => delete cache[k]);
    }
    await chrome.storage.local.set({ [CACHE_STORAGE_KEY]: cache });
  }

  // ─── Theme management ────────────────────────────────────────────
  // Themes: 'blue' (default), 'dark', 'warm'

  const THEME_ORDER = ['blue', 'dark', 'warm'];
  const THEME_FAB_COLORS = {
    blue: { bg: '#3b82f6', shadow: 'rgba(59,130,246,0.4)' },
    dark: { bg: '#1e3a5f', shadow: 'rgba(30,58,95,0.4)' },
    warm: { bg: '#d97706', shadow: 'rgba(217,119,6,0.4)' }
  };
  // Next theme's primary color shown inside the toggle button
  const THEME_ICONS = { blue: '\u2600\uFE0F', dark: '\uD83C\uDF19', warm: '\uD83C\uDF3B' };
  let _currentTheme = 'blue';

  /**
   * Applies the given theme to the panel and FAB toggle button.
   * @param {string} theme - 'blue', 'dark', or 'warm'
   */
  function applyTheme(theme) {
    _currentTheme = theme;
    const panel = shadowRoot && shadowRoot.getElementById('jm-panel');
    if (panel) {
      panel.classList.remove('theme-dark', 'theme-warm');
      if (theme === 'dark') panel.classList.add('theme-dark');
      if (theme === 'warm') panel.classList.add('theme-warm');
    }
    // Update FAB toggle button colors
    if (toggleBtnRef) {
      const colors = THEME_FAB_COLORS[theme] || THEME_FAB_COLORS.blue;
      toggleBtnRef.style.background = colors.bg;
      toggleBtnRef.style.boxShadow = `0 4px 12px ${colors.shadow}`;
    }
    // Update the theme toggle button indicator
    if (shadowRoot) {
      const themeBtn = shadowRoot.getElementById('jmThemeToggle');
      if (themeBtn) {
        themeBtn.textContent = THEME_ICONS[theme] || THEME_ICONS.blue;
        const nextIdx = (THEME_ORDER.indexOf(theme) + 1) % THEME_ORDER.length;
        const nextName = THEME_ORDER[nextIdx] === 'blue' ? 'Ocean Blue' : THEME_ORDER[nextIdx] === 'dark' ? 'Dark Mode' : 'Warm Amber';
        themeBtn.title = `Switch to ${nextName}`;
      }
    }
  }

  /**
   * Cycles to the next theme, saves it, and applies it.
   */
  async function cycleTheme() {
    const idx = THEME_ORDER.indexOf(_currentTheme);
    const nextTheme = THEME_ORDER[(idx + 1) % THEME_ORDER.length];
    _currentTheme = nextTheme;
    try {
      await chrome.storage.local.set({ jm_theme: nextTheme });
    } catch (e) { /* ignore */ }
    applyTheme(nextTheme);
  }

  /**
   * Loads the saved theme from storage and applies it.
   */
  async function loadTheme() {
    try {
      const result = await chrome.storage.local.get('jm_theme');
      const theme = result.jm_theme || 'blue';
      if (THEME_ORDER.includes(theme)) {
        applyTheme(theme);
      }
    } catch (e) { /* ignore */ }
  }

  // ─── Shadow DOM panel creation ──────────────────────────────────
  // The panel lives entirely inside a closed Shadow DOM so that:
  //   • The host page's CSS cannot override the panel's styles.
  //   • The panel's CSS cannot leak out and break the host page.
  //   • The panel's DOM is inaccessible to page scripts (mode: 'closed').

  /**
   * Creates the side panel Shadow DOM, injects styles and HTML, and wires events.
   * Called once on first use (lazy init — not on script inject).
   */
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

    // Load and apply saved theme
    loadTheme();

    return host;
  }

  /**
   * Returns the full CSS string for the side panel Shadow DOM.
   * All selectors are scoped inside the shadow root so they cannot
   * affect or be affected by the host page's stylesheet.
   * @returns {string} CSS text to inject into a <style> element.
   */
  function getPanelCSS() {
    return `
      * { margin: 0; padding: 0; box-sizing: border-box; }

      /* ── Theme CSS Variables ── */
      #jm-panel {
        --jm-primary: #3b82f6;
        --jm-primary-hover: #2563eb;
        --jm-bg: #ffffff;
        --jm-card-bg: #f8fafc;
        --jm-border: #e2e8f0;
        --jm-text: #1e293b;
        --jm-text-secondary: #64748b;
        --jm-text-muted: #94a3b8;
        --jm-tag-bg: #dbeafe;
        --jm-tag-text: #1e40af;
        --jm-hover-bg: #eff6ff;
        --jm-input-bg: #f8fafc;
        --jm-shadow: rgba(59,130,246,0.15);
        --jm-nav-inactive-bg: #f1f5f9;
        --jm-nav-inactive-text: #64748b;
      }

      #jm-panel.theme-dark {
        --jm-primary: #3b82f6;
        --jm-primary-hover: #2563eb;
        --jm-bg: #1e293b;
        --jm-card-bg: #0f172a;
        --jm-border: #334155;
        --jm-text: #f1f5f9;
        --jm-text-secondary: #cbd5e1;
        --jm-text-muted: #94a3b8;
        --jm-tag-bg: #1e3a5f;
        --jm-tag-text: #93c5fd;
        --jm-hover-bg: #334155;
        --jm-input-bg: #0f172a;
        --jm-shadow: rgba(0,0,0,0.3);
        --jm-nav-inactive-bg: #334155;
        --jm-nav-inactive-text: #94a3b8;
      }

      #jm-panel.theme-warm {
        --jm-primary: #d97706;
        --jm-primary-hover: #b45309;
        --jm-bg: #fffbf5;
        --jm-card-bg: #fefce8;
        --jm-border: #fde68a;
        --jm-text: #451a03;
        --jm-text-secondary: #92400e;
        --jm-text-muted: #a16207;
        --jm-tag-bg: #fef3c7;
        --jm-tag-text: #92400e;
        --jm-hover-bg: #fef9c3;
        --jm-input-bg: #fefce8;
        --jm-shadow: rgba(217,119,6,0.15);
        --jm-nav-inactive-bg: #fef3c7;
        --jm-nav-inactive-text: #92400e;
      }

      #jm-panel {
        position: fixed;
        top: 0;
        right: 0;
        width: 380px;
        height: 100vh;
        background: var(--jm-bg);
        box-shadow: none;
        display: flex;
        flex-direction: column;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        font-size: 14px;
        color: var(--jm-text);
        overflow: hidden;
        transform: translateX(100%);
        transition: transform 0.25s cubic-bezier(0.4, 0, 0.2, 1);
        z-index: 2147483646;
        pointer-events: auto;
      }

      #jm-panel.open {
        transform: translateX(0);
        box-shadow: -4px 0 24px rgba(0,0,0,0.15);
      }

      .jm-header {
        background: var(--jm-primary);
        color: white;
        padding: 16px 20px;
        display: flex;
        justify-content: space-between;
        align-items: center;
        flex-shrink: 0;
      }
      #jm-panel.theme-dark .jm-header { background: #1e3a5f !important; }
      #jm-panel.theme-warm .jm-header { background: #d97706 !important; }

      .jm-header h2 { font-size: 18px; font-weight: 600; display: flex; align-items: center; gap: 6px; margin: 0; }
      .jm-header h2 span { font-size: 40px; line-height: 1; flex-shrink: 0; }
      .jm-header .jm-title-text { display: flex; flex-direction: column; }
      .jm-header .jm-title-text .jm-subtitle { font-size: 11px; font-weight: 400; opacity: 0.8; margin-top: 2px; }

      /* Theme toggle button */
      .jm-theme-btn {
        width: 28px;
        height: 28px;
        border-radius: 50%;
        border: 2px solid rgba(255,255,255,0.4);
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        background: rgba(255,255,255,0.15);
        color: #fff;
        font-size: 14px;
        transition: background 0.15s;
        flex-shrink: 0;
        padding: 0;
      }
      .jm-theme-btn:hover {
        background: rgba(255,255,255,0.3);
      }
      /* subtitle is now styled via .jm-title-text .jm-subtitle */

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
        background: var(--jm-bg);
        border-bottom: 1px solid var(--jm-border);
        flex-shrink: 0;
      }

      .jm-nav-btn {
        flex: 1;
        padding: 9px 0;
        border: none;
        background: none;
        font-size: 12px;
        font-weight: 500;
        color: var(--jm-nav-inactive-text);
        cursor: pointer;
        transition: color 0.2s, background 0.2s;
        font-family: inherit;
        text-align: center;
      }

      .jm-nav-btn:hover {
        color: var(--jm-primary);
        background: var(--jm-hover-bg);
      }

      .jm-nav-btn.active {
        color: var(--jm-primary);
        border-bottom: 2px solid var(--jm-primary);
        font-weight: 600;
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
        background: var(--jm-primary);
        color: white;
      }
      .jm-btn-primary:hover { background: var(--jm-primary-hover); }

      .jm-btn-secondary {
        background: var(--jm-border);
        color: var(--jm-text-secondary);
      }
      .jm-btn-secondary:hover { background: var(--jm-hover-bg); }

      .jm-btn-success {
        background: #d1fae5;
        color: #059669;
      }
      .jm-btn-success:hover { background: #a7f3d0; }

      .jm-btn-applied {
        background: var(--jm-primary);
        color: white;
      }
      .jm-btn-applied:hover { background: var(--jm-primary-hover); }

      .jm-btn-applied-done {
        background: #93c5fd;
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
      .jm-status.info { display: block; background: var(--jm-tag-bg); color: var(--jm-tag-text); }
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

      .jm-score-label { font-size: 13px; color: var(--jm-text-secondary); }

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
        color: var(--jm-text-secondary);
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
      .jm-tag-keyword { background: var(--jm-tag-bg); color: var(--jm-tag-text); }

      /* Recommendations */
      .jm-recs {
        list-style: none;
        padding: 0;
      }

      .jm-recs li {
        padding: 8px 0;
        border-bottom: 1px solid var(--jm-border);
        font-size: 13px;
        line-height: 1.5;
        color: var(--jm-text);
      }
      .jm-recs li:last-child { border-bottom: none; }

      .jm-recs li::before {
        content: '\\2192 ';
        color: var(--jm-primary);
        font-weight: 600;
      }

      /* Insights */
      .jm-insight-block {
        background: var(--jm-card-bg);
        border-radius: 8px;
        padding: 12px;
        margin-bottom: 8px;
        border: 1px solid var(--jm-border);
      }

      .jm-insight-block h4 {
        font-size: 12px;
        font-weight: 600;
        color: var(--jm-primary);
        margin-bottom: 4px;
        text-transform: uppercase;
      }

      .jm-insight-block p {
        font-size: 13px;
        color: var(--jm-text-secondary);
        line-height: 1.5;
      }

      /* Job info */
      .jm-job-info {
        background: var(--jm-card-bg);
        border-radius: 8px;
        padding: 12px;
        margin-bottom: 16px;
        border: 1px solid var(--jm-border);
        display: none;
      }

      .jm-job-info .jm-job-title {
        font-weight: 600;
        font-size: 14px;
        color: var(--jm-text);
      }

      .jm-job-info .jm-job-company {
        font-size: 13px;
        color: var(--jm-text-secondary);
      }

      .jm-job-meta {
        display: flex;
        gap: 12px;
        margin-top: 6px;
        flex-wrap: wrap;
      }

      .jm-job-meta span {
        font-size: 12px;
        color: var(--jm-text-secondary);
        display: inline-flex;
        align-items: center;
        gap: 4px;
      }

      /* Backdrop (transparent overlay to capture outside clicks) */
      .jm-backdrop {
        position: fixed;
        top: 0;
        left: 0;
        width: 100vw;
        height: 100vh;
        background: transparent;
        z-index: 2147483645;
      }

      /* Toggle button (outside panel) */
      .jm-toggle {
        position: fixed;
        width: 42px;
        height: 42px;
        border-radius: 50%;
        background: var(--jm-fab-bg, #3b82f6);
        color: white;
        border: none;
        cursor: grab;
        box-shadow: 0 4px 12px var(--jm-fab-shadow, rgba(59,130,246,0.4));
        font-size: 30px;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: box-shadow 0.2s, transform 0.2s;
        z-index: 2147483647;
        user-select: none;
        touch-action: none;
      }
      .jm-toggle:hover {
        transform: scale(1.1);
        box-shadow: 0 6px 16px var(--jm-fab-shadow, rgba(59,130,246,0.5));
      }
      .jm-toggle.dragging {
        cursor: grabbing;
        transform: scale(1.1);
        box-shadow: 0 8px 20px var(--jm-fab-shadow, rgba(59,130,246,0.6));
        transition: none;
      }

      /* Outline button */
      .jm-btn-outline {
        background: var(--jm-bg);
        border: 1.5px solid var(--jm-primary);
        color: var(--jm-primary);
      }
      .jm-btn-outline:hover { background: var(--jm-hover-bg); }

      /* Truncation notice */
      .jm-trunc-notice {
        font-size: 11px;
        color: #92400e;
        background: #fffbeb;
        border: 1px solid #fde68a;
        border-radius: 5px;
        padding: 6px 10px;
        margin-bottom: 10px;
        display: none;
      }

      /* AutoFill preview */
      .jm-preview-list {
        display: flex;
        flex-direction: column;
        gap: 5px;
        max-height: 240px;
        overflow-y: auto;
        margin-bottom: 4px;
      }
      .jm-preview-row {
        display: flex;
        align-items: flex-start;
        gap: 8px;
        padding: 7px 8px;
        background: var(--jm-card-bg);
        border-radius: 6px;
        border: 1px solid var(--jm-border);
        font-size: 12px;
        line-height: 1.4;
      }
      .jm-preview-row input[type="checkbox"] {
        margin-top: 2px;
        flex-shrink: 0;
        accent-color: var(--jm-primary);
        width: 14px;
        height: 14px;
      }
      .jm-preview-label { font-weight: 600; color: var(--jm-text); }
      .jm-preview-val { color: var(--jm-text-secondary); word-break: break-word; }
      .jm-preview-row.jm-needs-input { background: #fffbeb; border-color: #fde68a; }
      .jm-preview-row.jm-needs-input .jm-preview-val { color: #92400e; }
      .jm-preview-actions { display: flex; gap: 8px; margin-top: 10px; }

      /* Cover letter */
      .jm-cover-letter {
        background: var(--jm-card-bg);
        border: 1px solid var(--jm-border);
        border-radius: 8px;
        padding: 12px 14px;
        font-size: 12.5px;
        line-height: 1.7;
        color: var(--jm-text);
        white-space: pre-wrap;
        max-height: 260px;
        overflow-y: auto;
        margin-bottom: 8px;
      }
      .jm-copy-btn {
        font-size: 12px;
        padding: 5px 12px;
        float: right;
        margin-top: -2px;
      }
      .jm-section-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 8px;
      }
      .jm-section-head h3 { margin-bottom: 0; }

      /* Bullet rewriter */
      .jm-bullet-item {
        background: var(--jm-card-bg);
        border: 1px solid var(--jm-border);
        border-radius: 8px;
        padding: 10px 12px;
        margin-bottom: 8px;
      }
      .jm-bullet-job {
        font-size: 10px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        color: var(--jm-primary);
        margin-bottom: 6px;
      }
      .jm-bullet-before {
        font-size: 12px;
        color: var(--jm-text-muted);
        text-decoration: line-through;
        margin-bottom: 4px;
        line-height: 1.5;
      }
      .jm-bullet-after {
        font-size: 12px;
        color: var(--jm-text);
        margin-bottom: 7px;
        line-height: 1.5;
        padding: 6px 8px;
        border-radius: 6px;
        border: 1px solid transparent;
        transition: border-color 0.15s;
        outline: none;
      }
      .jm-bullet-after:hover { border-color: var(--jm-border); }
      .jm-bullet-after:focus { border-color: var(--jm-primary); background: var(--jm-card-bg); }
      .jm-bullet-skills-btn { font-size: 10px; padding: 2px 7px; cursor: pointer; background: none; border: 1px solid var(--jm-border); border-radius: 4px; color: var(--jm-text-secondary); transition: all 0.15s; margin-left: auto; white-space: nowrap; }
      .jm-bullet-skills-btn:hover { border-color: var(--jm-primary); color: var(--jm-primary); }
      .jm-bullet-skills-btn.jm-active { border-color: var(--jm-primary); color: var(--jm-primary); background: var(--jm-primary)/10; }
      .jm-bullet-skills-panel { display: none; margin: 6px 0; padding: 8px 10px; background: var(--jm-card-bg); border: 1px solid var(--jm-border); border-radius: 8px; }
      .jm-bullet-skills-panel.jm-open { display: block; }
      .jm-bullet-skills-label { font-size: 10px; font-weight: 600; color: var(--jm-text-secondary); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 6px; }
      .jm-bullet-skills-list { display: flex; flex-wrap: wrap; gap: 4px; }
      .jm-skill-chip { font-size: 11px; padding: 3px 8px; border-radius: 12px; cursor: pointer; border: 1px solid var(--jm-primary); color: var(--jm-primary); background: var(--jm-primary)/8; transition: all 0.15s; user-select: none; }
      .jm-skill-chip:hover { opacity: 0.8; }
      .jm-skill-chip.jm-excluded-skill { border-color: var(--jm-border); color: var(--jm-text-muted); background: transparent; text-decoration: line-through; opacity: 0.5; }
      .jm-add-bullet-area { margin-top: 12px; padding: 12px; border: 1px dashed var(--jm-border); border-radius: 8px; background: var(--jm-card-bg); }
      .jm-add-bullet-area.jm-open { border-style: solid; border-color: var(--jm-primary); }
      .jm-add-bullet-trigger { width: 100%; padding: 8px; border: none; background: none; color: var(--jm-primary); font-size: 12px; font-weight: 600; cursor: pointer; text-align: center; }
      .jm-add-bullet-trigger:hover { text-decoration: underline; }
      .jm-add-bullet-form { display: none; }
      .jm-add-bullet-form.jm-open { display: block; }
      .jm-add-bullet-select { width: 100%; padding: 6px 8px; font-size: 12px; border: 1px solid var(--jm-border); border-radius: 6px; background: var(--jm-card-bg); color: var(--jm-text); margin-bottom: 8px; }
      .jm-add-bullet-input { width: 100%; padding: 8px; font-size: 12px; border: 1px solid var(--jm-border); border-radius: 6px; background: var(--jm-card-bg); color: var(--jm-text); resize: vertical; min-height: 50px; font-family: inherit; outline: none; }
      .jm-add-bullet-input:focus { border-color: var(--jm-primary); }
      .jm-add-bullet-actions { display: flex; gap: 6px; margin-top: 8px; }
      .jm-bullet-item.jm-custom-bullet { border-left: 3px solid var(--jm-primary); }
      .jm-bullet-custom-tag { font-size: 9px; background: var(--jm-primary); color: white; padding: 1px 6px; border-radius: 3px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; }
      .jm-bullet-actions { display: flex; gap: 6px; align-items: center; }
      .jm-bullet-copy { font-size: 11px; padding: 3px 10px; }
      .jm-bullet-refresh { font-size: 11px; padding: 3px 8px; cursor: pointer; background: none; border: 1px solid var(--jm-border); border-radius: 4px; color: var(--jm-text-secondary); transition: all 0.15s; }
      .jm-bullet-refresh:hover { border-color: var(--jm-primary); color: var(--jm-primary); }
      .jm-bullet-refresh:disabled { opacity: 0.4; cursor: not-allowed; }
      @keyframes jm-spin-refresh { to { transform: rotate(360deg); } }
      .jm-bullet-refresh.jm-spinning { animation: jm-spin-refresh 0.8s linear infinite; }
      .jm-bullet-header { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; }
      .jm-bullet-toggle-wrap {
        position: relative;
        flex-shrink: 0;
      }
      .jm-bullet-toggle { width: 14px; height: 14px; accent-color: var(--jm-primary); cursor: pointer; }
      .jm-bullet-toggle-wrap::before {
        content: attr(data-tip);
        position: absolute;
        bottom: calc(100% + 8px);
        left: 0;
        background: #1e293b;
        color: #f1f5f9;
        font-size: 11px;
        font-weight: 500;
        line-height: 1.4;
        padding: 6px 10px;
        border-radius: 6px;
        white-space: nowrap;
        box-shadow: 0 4px 12px rgba(0,0,0,0.15);
        pointer-events: none;
        opacity: 0;
        transition: opacity 0.15s ease;
        z-index: 10;
      }
      .jm-bullet-toggle-wrap::after {
        content: '';
        position: absolute;
        bottom: calc(100% + 2px);
        left: 7px;
        border: 5px solid transparent;
        border-top-color: #1e293b;
        pointer-events: none;
        opacity: 0;
        transition: opacity 0.15s ease;
        z-index: 10;
      }
      .jm-bullet-toggle-wrap:hover::before,
      .jm-bullet-toggle-wrap:hover::after {
        opacity: 1;
      }
      .jm-bullet-item.jm-excluded { opacity: 0.45; }
      .jm-bullet-item.jm-excluded .jm-bullet-after { text-decoration: line-through; }

      /* Job notes */
      .jm-notes-section {
        border-top: 1px solid var(--jm-border);
        margin-top: 12px;
        padding-top: 12px;
      }
      .jm-notes-section h3 {
        font-size: 12px;
        font-weight: 600;
        color: var(--jm-text-muted);
        text-transform: uppercase;
        letter-spacing: 0.5px;
        margin-bottom: 6px;
      }
      .jm-notes-textarea {
        width: 100%;
        resize: vertical;
        border: 1px solid var(--jm-border);
        border-radius: 6px;
        padding: 8px 10px;
        font-size: 12.5px;
        font-family: inherit;
        color: var(--jm-text);
        background: var(--jm-input-bg);
        min-height: 62px;
        box-sizing: border-box;
      }
      .jm-notes-textarea:focus {
        outline: none;
        border-color: var(--jm-primary);
        box-shadow: 0 0 0 2px var(--jm-shadow);
      }

      /* Resume slot switcher */
      .jm-resume-switcher {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 10px;
        flex-wrap: wrap;
      }
      .jm-switch-label {
        font-size: 11px;
        font-weight: 600;
        color: var(--jm-text-secondary);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        white-space: nowrap;
      }
      .jm-switch-pills {
        display: flex;
        gap: 4px;
        flex-wrap: wrap;
      }
      .jm-switch-pill {
        font-size: 11px;
        padding: 3px 10px;
        border-radius: 20px;
        border: 1.5px solid var(--jm-border);
        background: transparent;
        color: var(--jm-text-secondary);
        cursor: pointer;
        transition: all 0.15s;
        white-space: nowrap;
        max-width: 90px;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .jm-switch-pill:hover:not(:disabled) {
        border-color: var(--jm-primary);
        color: var(--jm-primary);
      }
      .jm-switch-pill.active {
        background: var(--jm-primary);
        border-color: transparent;
        color: white;
        font-weight: 600;
      }
      .jm-switch-pill:disabled {
        opacity: 0.35;
        cursor: not-allowed;
      }

      /* Saved jobs tab */
      .jm-saved-list { display: flex; flex-direction: column; gap: 8px; }
      .jm-saved-card {
        background: var(--jm-card-bg); border-radius: 8px; padding: 12px;
        position: relative; border: 1px solid var(--jm-border);
        transition: border-color 0.15s;
      }
      .jm-saved-card:hover { border-color: var(--jm-primary); }
      .jm-saved-title { font-weight: 600; font-size: 13px; color: var(--jm-text); text-decoration: none; display: block; margin-bottom: 4px; }
      .jm-saved-title:hover { color: var(--jm-primary); }
      .jm-saved-company { font-size: 12px; color: var(--jm-text-secondary); }
      .jm-saved-meta { display: flex; align-items: center; gap: 8px; margin-top: 6px; font-size: 11px; color: var(--jm-text-muted); }
      .jm-saved-score { padding: 2px 8px; border-radius: 4px; color: #fff; font-weight: 600; font-size: 11px; }
      .jm-saved-delete {
        position: absolute; top: 8px; right: 8px;
        background: none; border: none; cursor: pointer;
        color: var(--jm-text-muted); font-size: 16px; line-height: 1;
        transition: color 0.15s;
      }
      .jm-saved-delete:hover { color: #ef4444; }
      .jm-saved-empty { text-align: center; color: var(--jm-text-muted); font-size: 13px; padding: 32px 16px; }

      /* Tab content visibility */
      .jm-tab-content { display: none; }
      .jm-tab-content.active { display: block; }

      @media (max-width: 500px) {
        #jm-panel { width: 100vw !important; }
        .jm-body { padding: 12px !important; }
      }
    `;
  }

  /**
   * Returns the static inner HTML string for the side panel.
   * Sections that are initially hidden (display:none) are shown
   * programmatically after analysis / autofill completes.
   * @returns {string} HTML markup for the panel body.
   */
  function getPanelHTML() {
    return `
      <div class="jm-header">
        <h2>
          <span>&#9733;</span>
          <div class="jm-title-text">
            JobMatch AI
            <span class="jm-subtitle">Resume & Job Analyzer</span>
          </div>
        </h2>
        <div style="display:flex;align-items:center;gap:8px;">
          <button class="jm-theme-btn" id="jmThemeToggle" title="Switch theme">&#9728;&#65039;</button>
        </div>
      </div>
      <div class="jm-nav">
        <button class="jm-nav-btn" data-nav="profile">Profile</button>
        <button class="jm-nav-btn" data-nav="qa">Q&A</button>
        <button class="jm-nav-btn" data-nav="saved">Saved</button>
        <button class="jm-nav-btn" data-nav="settings">Settings</button>
      </div>
      <div class="jm-body">
        <!-- Saved Jobs tab -->
        <div class="jm-tab-content" id="jmSavedTab">
          <div class="jm-saved-list" id="jmSavedList">
            <div class="jm-saved-empty" id="jmSavedEmpty">No saved jobs yet. Click 'Save Job' on any job posting to bookmark it.</div>
          </div>
        </div>

        <!-- Main content (default) -->
        <div class="jm-tab-content active" id="jmMainTab">
        <div class="jm-status" id="jmStatus"></div>

        <div class="jm-job-info" id="jmJobInfo">
          <div class="jm-job-title" id="jmJobTitle"></div>
          <div class="jm-job-company" id="jmJobCompany"></div>
          <div class="jm-job-meta">
            <span id="jmJobLocation" style="display:none">&#128205; <span id="jmJobLocationText"></span></span>
            <span id="jmJobSalary" style="display:none">&#128176; <span id="jmJobSalaryText"></span></span>
          </div>
        </div>

        <!-- Resume slot switcher -->
        <div class="jm-resume-switcher" id="jmResumeSwitch">
          <span class="jm-switch-label">Resume:</span>
          <div class="jm-switch-pills" id="jmSwitchPills"></div>
        </div>

        <div class="jm-actions">
          <button class="jm-btn jm-btn-primary" id="jmAnalyze">Analyze Job</button>
          <button class="jm-btn jm-btn-secondary" id="jmAutofill">AutoFill Application</button>
          <button class="jm-btn jm-btn-success" id="jmSaveJob" style="display:none">Save Job</button>
          <button class="jm-btn jm-btn-applied" id="jmMarkApplied" style="display:none">Mark as Applied</button>
          <button class="jm-btn jm-btn-outline" id="jmCoverLetterBtn" style="display:none">&#9993; Cover Letter</button>
          <button class="jm-btn jm-btn-outline" id="jmRewriteBulletsBtn" style="display:none">&#9997; Improve Resume Bullets</button>
          <button class="jm-btn jm-btn-outline" id="jmTailoredResumeBtn" style="display:none">&#128196; Generate Tailored Resume</button>
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

        <!-- Truncation notice -->
        <div class="jm-trunc-notice" id="jmTruncNotice">
          &#9888; Job description was too long and was trimmed — match score may be approximate.
        </div>
        <div class="jm-trunc-notice" id="jmResumeTruncNotice">
          &#9888; Note: Your resume was truncated for analysis. Consider shortening it for better results.
        </div>

        <!-- AutoFill preview -->
        <div class="jm-section" id="jmAutofillPreview" style="display:none">
          <h3>Review Autofill <span id="jmPreviewCount" style="font-weight:400;color:var(--jm-text-secondary);text-transform:none;letter-spacing:0"></span></h3>
          <div class="jm-preview-list" id="jmPreviewList"></div>
          <div class="jm-preview-actions">
            <button class="jm-btn jm-btn-primary" id="jmApplyFill" style="flex:1">Apply Selected</button>
            <button class="jm-btn jm-btn-secondary" id="jmCancelFill">Cancel</button>
          </div>
        </div>

        <!-- Cover letter output -->
        <div class="jm-section" id="jmCoverLetterSection" style="display:none">
          <div class="jm-section-head">
            <h3>Cover Letter</h3>
            <button class="jm-btn jm-btn-secondary jm-copy-btn" id="jmCopyCoverLetter">Copy</button>
          </div>
          <div class="jm-cover-letter" id="jmCoverLetterText"></div>
        </div>

        <!-- Bullet rewriter output -->
        <div class="jm-section" id="jmBulletSection" style="display:none">
          <h3>Improved Resume Bullets</h3>
          <div id="jmBulletList"></div>
          <div class="jm-add-bullet-area" id="jmAddBulletArea" style="display:none;">
            <button class="jm-add-bullet-trigger" id="jmAddBulletTrigger">+ Add Custom Bullet</button>
            <div class="jm-add-bullet-form" id="jmAddBulletForm">
              <label style="font-size:11px;font-weight:600;color:var(--jm-text-secondary);display:block;margin-bottom:4px;">Add under:</label>
              <select class="jm-add-bullet-select" id="jmAddBulletTarget"></select>
              <label style="font-size:11px;font-weight:600;color:var(--jm-text-secondary);display:block;margin-bottom:4px;">Describe what you did:</label>
              <textarea class="jm-add-bullet-input" id="jmAddBulletInput" placeholder="e.g. built a dashboard for tracking sales metrics using React and D3..."></textarea>
              <div class="jm-add-bullet-actions">
                <button class="jm-btn jm-btn-primary" id="jmAddBulletGenerate" style="font-size:11px;padding:5px 14px;">Generate</button>
                <button class="jm-btn jm-btn-secondary" id="jmAddBulletCancel" style="font-size:11px;padding:5px 14px;">Cancel</button>
              </div>
            </div>
          </div>
          <button class="jm-btn jm-btn-outline" id="jmTailoredResumeBtnBottom" style="display:none;margin-top:10px;width:100%;">&#128196; Generate Tailored Resume</button>
        </div>

        <!-- Tailored resume output -->
        <div class="jm-section" id="jmTailoredResumeSection" style="display:none">
          <h3>Tailored Resume</h3>
          <p id="jmTailoredResumeStatus" style="font-size:12px;color:var(--jm-text-secondary);"></p>
        </div>

        <!-- Job notes (always visible) -->
        <div class="jm-notes-section">
          <h3>Notes</h3>
          <textarea class="jm-notes-textarea" id="jmNotesInput" placeholder="Add notes about this job — saved automatically..."></textarea>
        </div>
        </div><!-- end jmMainTab -->
      </div>
    `;
  }

  /**
   * Attaches all button click listeners and tab-switch handlers to the panel.
   * Called once after the panel HTML is injected into the Shadow DOM.
   * @param {HTMLElement} panel - The #jm-panel element inside the Shadow DOM.
   */
  function wireEvents(panel) {
    panel.querySelector('#jmAnalyze').addEventListener('click', () => {
      const btn = shadowRoot.getElementById('jmAnalyze');
      // If button says "Re-Analyze", force refresh; otherwise use cache
      const forceRefresh = btn.textContent.trim() === 'Re-Analyze';
      analyzeJob(forceRefresh);
    });
    panel.querySelector('#jmAutofill').addEventListener('click', autofillForm);
    panel.querySelector('#jmSaveJob').addEventListener('click', saveJob);

    panel.querySelector('#jmMarkApplied').addEventListener('click', markApplied);
    panel.querySelector('#jmCoverLetterBtn').addEventListener('click', generateCoverLetter);
    panel.querySelector('#jmRewriteBulletsBtn').addEventListener('click', rewriteBullets);
    panel.querySelector('#jmTailoredResumeBtn').addEventListener('click', generateTailoredResume);
    panel.querySelector('#jmTailoredResumeBtnBottom').addEventListener('click', generateTailoredResume);

    // Add custom bullet UI
    panel.querySelector('#jmAddBulletTrigger').addEventListener('click', () => {
      const form = shadowRoot.getElementById('jmAddBulletForm');
      const area = shadowRoot.getElementById('jmAddBulletArea');
      const trigger = shadowRoot.getElementById('jmAddBulletTrigger');
      form.classList.add('jm-open');
      area.classList.add('jm-open');
      trigger.style.display = 'none';
      populateAddBulletDropdown();
    });
    panel.querySelector('#jmAddBulletCancel').addEventListener('click', () => {
      shadowRoot.getElementById('jmAddBulletForm').classList.remove('jm-open');
      shadowRoot.getElementById('jmAddBulletArea').classList.remove('jm-open');
      shadowRoot.getElementById('jmAddBulletTrigger').style.display = '';
      shadowRoot.getElementById('jmAddBulletInput').value = '';
    });
    panel.querySelector('#jmAddBulletGenerate').addEventListener('click', generateCustomBullet);
    panel.querySelector('#jmApplyFill').addEventListener('click', applyAutofill);
    panel.querySelector('#jmCancelFill').addEventListener('click', cancelAutofill);
    panel.querySelector('#jmCopyCoverLetter').addEventListener('click', () => {
      const text = shadowRoot.getElementById('jmCoverLetterText').textContent;
      navigator.clipboard.writeText(text).then(() => {
        const btn = shadowRoot.getElementById('jmCopyCoverLetter');
        const orig = btn.textContent;
        btn.textContent = 'Copied!';
        setTimeout(() => { btn.textContent = orig; }, 1500);
      }).catch(() => {});
    });
    panel.querySelector('#jmNotesInput').addEventListener('blur', saveJobNotes);
    panel.querySelector('#jmNotesInput').addEventListener('input', saveJobNotes);

    // Theme toggle button
    panel.querySelector('#jmThemeToggle').addEventListener('click', cycleTheme);

    // Nav buttons → open profile page at the right tab, or switch to Saved tab
    panel.querySelectorAll('.jm-nav-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const tab = btn.dataset.nav;
        if (tab === 'saved') {
          // Switch to Saved tab within the panel
          activateSavedTab();
        } else {
          // Deactivate Saved tab highlight if switching away
          deactivateSavedTab();
          chrome.runtime.sendMessage({ type: 'OPEN_PROFILE_TAB', hash: tab });
        }
      });
    });
  }

  // ─── Saved Jobs tab ──────────────────────────────────────────

  /**
   * Activates the Saved tab: highlights the nav button, shows the saved
   * tab content, hides the main tab content, and fetches saved jobs.
   */
  function activateSavedTab() {
    if (!shadowRoot) return;
    // Highlight the Saved nav button
    shadowRoot.querySelectorAll('.jm-nav-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.nav === 'saved');
    });
    // Show saved tab, hide main tab
    const savedTab = shadowRoot.getElementById('jmSavedTab');
    const mainTab = shadowRoot.getElementById('jmMainTab');
    if (savedTab) savedTab.classList.add('active');
    if (mainTab) mainTab.classList.remove('active');
    // Fetch and render saved jobs each time the tab is activated
    loadSavedJobs();
  }

  /**
   * Deactivates the Saved tab: removes nav highlight, hides saved tab,
   * and restores the main tab content.
   */
  function deactivateSavedTab() {
    if (!shadowRoot) return;
    shadowRoot.querySelectorAll('.jm-nav-btn').forEach(btn => {
      btn.classList.remove('active');
    });
    const savedTab = shadowRoot.getElementById('jmSavedTab');
    const mainTab = shadowRoot.getElementById('jmMainTab');
    if (savedTab) savedTab.classList.remove('active');
    if (mainTab) mainTab.classList.add('active');
  }

  /**
   * Fetches saved jobs from background.js and renders them in the Saved tab.
   * @async
   */
  async function loadSavedJobs() {
    if (!shadowRoot) return;
    const list = shadowRoot.getElementById('jmSavedList');
    const emptyMsg = shadowRoot.getElementById('jmSavedEmpty');
    if (!list) return;

    try {
      const jobs = await sendMessage({ type: 'GET_SAVED_JOBS' });
      // Clear previous cards (keep the empty message element)
      list.querySelectorAll('.jm-saved-card').forEach(c => c.remove());

      if (!jobs || jobs.length === 0) {
        if (emptyMsg) emptyMsg.style.display = 'block';
        return;
      }

      if (emptyMsg) emptyMsg.style.display = 'none';

      jobs.forEach(job => {
        const card = document.createElement('div');
        card.className = 'jm-saved-card';
        card.dataset.jobId = job.id;

        // Title link
        const title = document.createElement('a');
        title.className = 'jm-saved-title';
        title.textContent = job.title || 'Unknown Position';
        title.href = job.url || '#';
        title.target = '_blank';
        title.rel = 'noopener';

        // Company
        const company = document.createElement('div');
        company.className = 'jm-saved-company';
        company.textContent = job.company || 'Unknown Company';

        // Meta row (score + date)
        const meta = document.createElement('div');
        meta.className = 'jm-saved-meta';

        if (job.score != null && job.score !== 0) {
          const score = document.createElement('span');
          score.className = 'jm-saved-score';
          score.textContent = job.score + '%';
          if (job.score >= 70) score.style.background = '#059669';
          else if (job.score >= 45) score.style.background = '#d97706';
          else score.style.background = '#dc2626';
          meta.appendChild(score);
        }

        if (job.date) {
          const date = document.createElement('span');
          date.textContent = 'Saved ' + job.date;
          meta.appendChild(date);
        }

        // Delete button
        const del = document.createElement('button');
        del.className = 'jm-saved-delete';
        del.innerHTML = '&#10005;';
        del.title = 'Remove saved job';
        del.addEventListener('click', () => deleteSavedJob(job.id, card));

        card.appendChild(title);
        card.appendChild(company);
        card.appendChild(meta);
        card.appendChild(del);
        list.appendChild(card);
      });
    } catch (e) {
      // Silently fail — user can retry by switching tabs
    }
  }

  /**
   * Deletes a saved job by ID (optimistic UI removal).
   * @async
   * @param {string} jobId - The saved job's ID.
   * @param {HTMLElement} cardEl - The card DOM element to remove.
   */
  async function deleteSavedJob(jobId, cardEl) {
    // Optimistic removal from DOM
    cardEl.remove();

    // Show empty state if no cards remain
    if (shadowRoot) {
      const list = shadowRoot.getElementById('jmSavedList');
      const emptyMsg = shadowRoot.getElementById('jmSavedEmpty');
      if (list && list.querySelectorAll('.jm-saved-card').length === 0 && emptyMsg) {
        emptyMsg.style.display = 'block';
      }
    }

    try {
      await sendMessage({ type: 'DELETE_JOB', jobId: jobId });
    } catch (e) {
      // If delete fails, reload the list to restore correct state
      loadSavedJobs();
    }
  }

  /**
   * Checks if the current page URL is already saved and updates
   * the Save Job button to show "Saved" state if so.
   * @async
   */
  async function checkIfSaved() {
    try {
      const jobs = await sendMessage({ type: 'GET_SAVED_JOBS' });
      const btn = shadowRoot.getElementById('jmSaveJob');
      if (!btn) return;
      if (jobs && jobs.some(j => j.url === window.location.href)) {
        btn.textContent = 'Saved';
        btn.disabled = true;
        btn.style.opacity = '0.7';
      } else {
        btn.textContent = 'Save Job';
        btn.disabled = false;
        btn.style.opacity = '1';
      }
    } catch (e) { /* ignore */ }
  }

  // ─── Toggle button (always visible) ────────────────────────────
  // The ★ button is a separate Shadow DOM host from the panel so it can float
  // freely without interfering with the panel's stacking context.
  // It supports both mouse drag and touch drag, and persists its last position
  // across page navigations using localStorage.

  /**
   * Creates the draggable floating ★ toggle button and appends it to the page.
   *
   * Position is restored from localStorage on creation. Drag state is tracked
   * with mousedown/mousemove/mouseup (and touch equivalents). A click only fires
   * togglePanel() if the button was not meaningfully dragged (delta < 4px).
   */
  function createToggleButton() {
    const btn = document.createElement('button');
    btn.className = 'jm-toggle';
    btn.id = 'jobmatch-ai-toggle';
    btn.innerHTML = '&#9733;';
    btn.title = 'JobMatch AI';
    btn.setAttribute('role', 'button');
    btn.setAttribute('aria-label', 'Open JobMatch AI panel');
    btn.setAttribute('aria-pressed', 'false');
    btn.setAttribute('tabindex', '0');
    toggleBtnRef = btn;

    // Restore saved position or default to bottom-right
    const saved = (() => {
      try { return JSON.parse(localStorage.getItem('jm-fab-pos')); } catch { return null; }
    })();
    const defaultRight = 24;
    const defaultBottom = 24;
    if (saved && typeof saved.right === 'number' && typeof saved.bottom === 'number') {
      btn.style.right  = saved.right + 'px';
      btn.style.bottom = saved.bottom + 'px';
      btn.style.left   = 'auto';
      btn.style.top    = 'auto';
    } else {
      btn.style.right  = defaultRight + 'px';
      btn.style.bottom = defaultBottom + 'px';
      btn.style.left   = 'auto';
      btn.style.top    = 'auto';
    }

    // ── Drag logic ──
    let didDrag = false, startX, startY, startRight, startBottom;
    const MIN_MARGIN = 8;
    const DRAG_THRESHOLD = 4;

    function onMove(e) {
      const cx = e.touches ? e.touches[0].clientX : e.clientX;
      const cy = e.touches ? e.touches[0].clientY : e.clientY;
      const dx = cx - startX;
      const dy = cy - startY;

      // Only start dragging after movement exceeds threshold
      if (!didDrag && Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
      didDrag = true;
      btn.classList.add('dragging');

      // Calculate new right/bottom with bounds checking (8px min margin)
      let newRight  = startRight - dx;
      let newBottom = startBottom - dy;
      newRight  = Math.max(MIN_MARGIN, Math.min(newRight,  window.innerWidth  - 48 - MIN_MARGIN));
      newBottom = Math.max(MIN_MARGIN, Math.min(newBottom, window.innerHeight - 48 - MIN_MARGIN));

      btn.style.right  = newRight + 'px';
      btn.style.bottom = newBottom + 'px';
      btn.style.left   = 'auto';
      btn.style.top    = 'auto';
    }

    function onEnd(e) {
      btn.classList.remove('dragging');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup',   onEnd);
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend',  onEnd);

      if (didDrag) {
        // Save position as {right, bottom}
        const pos = {
          right:  parseInt(btn.style.right,  10),
          bottom: parseInt(btn.style.bottom, 10)
        };
        try { localStorage.setItem('jm-fab-pos', JSON.stringify(pos)); } catch {}
      }
    }

    btn.addEventListener('mousedown', e => {
      startX = e.clientX; startY = e.clientY;
      startRight  = parseInt(btn.style.right,  10) || defaultRight;
      startBottom = parseInt(btn.style.bottom, 10) || defaultBottom;
      didDrag = false;
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup',   onEnd);
      e.preventDefault();
    });

    btn.addEventListener('touchstart', e => {
      startX = e.touches[0].clientX; startY = e.touches[0].clientY;
      startRight  = parseInt(btn.style.right,  10) || defaultRight;
      startBottom = parseInt(btn.style.bottom, 10) || defaultBottom;
      didDrag = false;
      document.addEventListener('touchmove', onMove, { passive: false });
      document.addEventListener('touchend',  onEnd);
      e.preventDefault();
    }, { passive: false });

    // Only fire click if not dragged (threshold already checked during move)
    btn.addEventListener('click', e => {
      if (!didDrag) togglePanel();
    });

    // Keyboard accessibility: Enter and Space trigger toggle
    btn.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        togglePanel();
      }
    });

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

  // ─── Resume slot switcher ─────────────────────────────────────

  /**
   * Loads slot state from chrome.storage.local and renders the switcher pills.
   * Called when the panel opens so the switcher always reflects current storage.
   * @async
   */
  async function loadSlotState() {
    try {
      const result = await chrome.storage.local.get(['profileSlots', 'activeProfileSlot', 'slotNames']);
      _activeSlot  = result.activeProfileSlot ?? 0;
      _slotNames   = result.slotNames   || ['Resume 1', 'Resume 2', 'Resume 3'];
      const slots  = result.profileSlots || [null, null, null];
      _slotHasData = slots.map(s => !!s);
      renderSlotSwitcher();
    } catch (e) { /* ignore — switcher stays hidden */ }
  }

  /**
   * Renders the three slot pills into #jmSwitchPills.
   * Disables pills for empty slots. Marks the active slot with .active class.
   */
  function renderSlotSwitcher() {
    const container = shadowRoot && shadowRoot.getElementById('jmSwitchPills');
    if (!container) return;
    container.innerHTML = '';
    _slotNames.forEach((name, i) => {
      const btn = document.createElement('button');
      btn.className = 'jm-switch-pill' + (i === _activeSlot ? ' active' : '');
      btn.textContent = name || `Resume ${i + 1}`;
      btn.title = _slotHasData[i] ? name : `${name} (empty)`;
      btn.disabled = !_slotHasData[i];
      btn.addEventListener('click', () => switchSlot(i));
      container.appendChild(btn);
    });
  }

  /**
   * Switches the active resume slot, updates chrome.storage.local, and resets
   * the current analysis so the user re-analyzes with the new resume.
   * @async
   * @param {number} slotIndex - The slot index (0, 1, or 2) to switch to.
   */
  async function switchSlot(slotIndex) {
    if (slotIndex === _activeSlot) return;
    try {
      const result = await chrome.storage.local.get(['profileSlots', 'slotNames']);
      const slots  = result.profileSlots || [null, null, null];
      if (!slots[slotIndex]) return; // slot is empty — should not happen (button is disabled)

      // Persist the new active slot and update the top-level `profile` key
      // so background.js always reads the correct resume for AI calls.
      await chrome.storage.local.set({
        activeProfileSlot: slotIndex,
        profile: slots[slotIndex]
      });

      _activeSlot = slotIndex;
      renderSlotSwitcher();

      // Reset analysis — it was scored against the previous resume
      currentAnalysis = null;
      const analyzeBtn = shadowRoot.getElementById('jmAnalyze');
      if (analyzeBtn) analyzeBtn.textContent = 'Analyze Job';

      // Hide all result sections so the panel is clean for the new resume
      ['jmScoreSection','jmMatchingSection','jmMissingSection','jmRecsSection',
       'jmInsightsSection','jmKeywordsSection','jmCoverLetterSection','jmBulletSection',
       'jmSaveJob','jmMarkApplied','jmCoverLetterBtn','jmRewriteBulletsBtn'
      ].forEach(id => {
        const el = shadowRoot.getElementById(id);
        if (el) el.style.display = 'none';
      });

      setStatus(`Switched to ${_slotNames[slotIndex] || `Resume ${slotIndex + 1}`}. Click Analyze Job.`, 'success');
      setTimeout(clearStatus, 2500);
    } catch (e) {
      setStatus('Could not switch resume: ' + e.message, 'error');
    }
  }

  // ─── Panel toggle ─────────────────────────────────────────────

  /**
   * Opens or closes the side panel.
   * On first open, createPanel() is called to build the Shadow DOM.
   * When opening, also triggers checkIfApplied() and loadJobNotes()
   * so the panel always reflects the latest state for the current URL.
   */
  // Reference to the backdrop element inside the panel's shadow DOM
  let _backdropEl = null;
  // Reference to the escape key handler so we can add/remove it
  let _escHandler = null;

  function togglePanel() {
    panelOpen = !panelOpen;
    if (!panelRoot) createPanel();

    const panel = shadowRoot.getElementById('jm-panel');

    // Update accessibility attributes on the toggle button
    if (toggleBtnRef) {
      toggleBtnRef.setAttribute('aria-label', panelOpen ? 'Close JobMatch AI panel' : 'Open JobMatch AI panel');
      toggleBtnRef.setAttribute('aria-pressed', String(panelOpen));
    }

    if (panelOpen) {
      // Create backdrop inside the shadow DOM
      if (!_backdropEl) {
        _backdropEl = document.createElement('div');
        _backdropEl.className = 'jm-backdrop';
        _backdropEl.addEventListener('click', () => togglePanel());
        shadowRoot.insertBefore(_backdropEl, shadowRoot.firstChild.nextSibling);
      } else {
        _backdropEl.style.display = 'block';
      }

      panelRoot.classList.add('open');
      panel.classList.add('open');

      // Add Escape key handler
      _escHandler = (e) => {
        if (e.key === 'Escape' && panelOpen) togglePanel();
      };
      document.addEventListener('keydown', _escHandler);

      loadSlotState();
      checkIfApplied();
      checkIfSaved();
      loadJobNotes();
      // Ensure we start on the main tab when opening the panel
      deactivateSavedTab();
    } else {
      panel.classList.remove('open');
      panelRoot.classList.remove('open');

      // Hide backdrop
      if (_backdropEl) _backdropEl.style.display = 'none';

      // Remove Escape key handler
      if (_escHandler) {
        document.removeEventListener('keydown', _escHandler);
        _escHandler = null;
      }
    }
    // Button always stays visible — never hide the toggle host
  }

  // ─── Status helpers ───────────────────────────────────────────

  /**
   * Displays a status message inside the panel (info / success / error styles).
   * @param {string} text - Message to display.
   * @param {'info'|'success'|'error'} type - CSS modifier class for color.
   */
  function setStatus(text, type) {
    const el = shadowRoot.getElementById('jmStatus');
    el.textContent = text;
    el.className = 'jm-status ' + type;
  }

  /** Hides the status bar (used after a timed delay post-success). */
  function clearStatus() {
    const el = shadowRoot.getElementById('jmStatus');
    el.className = 'jm-status';
    el.style.display = 'none';
  }

  /**
   * Scrolls the panel's scrollable body to bring a section into view.
   * Uses the panel's own scrollable container rather than window.scrollIntoView,
   * which would scroll the host page instead of the Shadow DOM panel.
   * @param {HTMLElement} el - The element to scroll to inside the panel.
   */
  function scrollPanelTo(el) {
    const body = shadowRoot.querySelector('.jm-body');
    if (!body) return;
    body.scrollTo({ top: el.offsetTop - 10, behavior: 'smooth' });
  }

  // ─── Job description extraction ───────────────────────────────
  // Each function tries a prioritised list of CSS selectors for supported job
  // sites, then falls back to heuristic DOM scanning.  Returns an empty string
  // (or null) when nothing can be found, so callers can show an error.

  /**
   * Extracts the full job description text from the current page.
   * Tries site-specific selectors first, then generic heuristics.
   * @returns {string} The extracted job description text, or '' if not found.
   */
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

  /** @returns {string} The job title extracted from the page, or ''. */
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

  /** @returns {string} The company name extracted from the page, or ''. */
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

  /** @returns {string} The job location extracted from the page, or ''. */
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

  /** @returns {string} The salary/compensation text extracted from the page, or ''. */
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

  /**
   * Runs a job analysis for the current page: extracts the JD, sends it to the
   * AI via background.js, caches the result, and renders it in the panel.
   *
   * If a cached result exists for the current URL and forceRefresh is false,
   * the cached result is displayed immediately with no API call.
   *
   * @async
   * @param {boolean} [forceRefresh=false] - When true, bypasses the cache and
   *   always makes a fresh AI call (triggered by the "Re-Analyze" button).
   */
  async function analyzeJob(forceRefresh) {
    const btn = shadowRoot.getElementById('jmAnalyze');
    const pageUrl = window.location.href;

    // Check cache first (unless force re-analyze)
    const cached = await getCachedAnalysis(pageUrl);
    if (!forceRefresh && cached) {
      currentAnalysis = cached.analysis;
      showJobMeta(cached.title, cached.company, cached.location, cached.salary);
      renderAnalysis(cached.response);
      shadowRoot.getElementById('jmSaveJob').style.display = 'flex';
      shadowRoot.getElementById('jmCoverLetterBtn').style.display = 'flex';
      shadowRoot.getElementById('jmRewriteBulletsBtn').style.display = 'flex';
      shadowRoot.getElementById('jmTailoredResumeBtn').style.display = 'flex';
      btn.textContent = 'Re-Analyze';
      setStatus('Showing cached results.', 'success');
      setTimeout(clearStatus, 2000);
      return;
    }

    btn.disabled = true;
    btn.innerHTML = '<span class="jm-spinner"></span> Analyzing...';
    let analysisSucceeded = false;

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

      // Warn if the extracted JD is too short to produce reliable results,
      // but don't block — the user can still trigger analysis.
      if (jd.length < 100) {
        setStatus('Could not extract enough job details from this page. Try copying the job description manually.', 'error');
        btn.disabled = false;
        btn.textContent = 'Analyze Job';
        return;
      }

      setStatus('Analyzing job match...', 'info');

      const response = await sendMessage({
        type: 'ANALYZE_JOB',
        jobDescription: jd,
        jobTitle: title,
        company: company
      });

      currentAnalysis = { ...response, title, company, location, salary, url: pageUrl };
      await setCachedAnalysis(pageUrl, { response, analysis: currentAnalysis, title, company, location, salary });
      analysisSucceeded = true;
      renderAnalysis(response);
      clearStatus();

      // Show truncation notices if text was trimmed
      shadowRoot.getElementById('jmTruncNotice').style.display = response.jdTruncated ? 'block' : 'none';
      shadowRoot.getElementById('jmResumeTruncNotice').style.display = response.truncated ? 'block' : 'none';

      // Show save, applied, cover letter, bullet rewriter buttons
      shadowRoot.getElementById('jmSaveJob').style.display = 'flex';
      const appliedBtn = shadowRoot.getElementById('jmMarkApplied');
      if (appliedBtn.textContent !== 'Applied') {
        appliedBtn.style.display = 'flex';
      }
      shadowRoot.getElementById('jmCoverLetterBtn').style.display = 'flex';
      shadowRoot.getElementById('jmRewriteBulletsBtn').style.display = 'flex';
      shadowRoot.getElementById('jmTailoredResumeBtn').style.display = 'flex';
      // Reset any previous AI output sections
      shadowRoot.getElementById('jmCoverLetterSection').style.display = 'none';
      shadowRoot.getElementById('jmBulletSection').style.display = 'none';
      shadowRoot.getElementById('jmTailoredResumeSection').style.display = 'none';
    } catch (err) {
      setStatus('Error: ' + err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = analysisSucceeded ? 'Re-Analyze' : 'Analyze Job';
    }
  }

  /**
   * Renders the job title, company, location, and salary in the panel header.
   * Elements with no data are hidden to avoid empty UI gaps.
   * @param {string} title    - Job title text.
   * @param {string} company  - Company name.
   * @param {string} location - Job location string.
   * @param {string} salary   - Salary/compensation string.
   */
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

  /**
   * Populates all analysis sections in the panel (score, matching skills,
   * missing skills, recommendations, insights, ATS keywords).
   * Each section is shown only if the AI returned data for it.
   * @param {Object} data - The analysis object returned by background.js handleAnalyzeJob.
   */
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

  /**
   * Maps a 0–100 match score to a CSS class for color-coding the score circle.
   * @param {number} score - The match score.
   * @returns {'score-green'|'score-amber'|'score-red'}
   */
  function getScoreClass(score) {
    if (score >= 70) return 'score-green';
    if (score >= 45) return 'score-amber';
    return 'score-red';
  }

  // ─── Save job ─────────────────────────────────────────────────

  /**
   * Saves the current job to the user's saved-jobs list via background.js.
   * Requires a completed analysis (currentAnalysis must be non-null).
   * @async
   */
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
      // Update button to "Saved" state
      const saveBtn = shadowRoot.getElementById('jmSaveJob');
      if (saveBtn) {
        saveBtn.textContent = 'Saved';
        saveBtn.disabled = true;
        saveBtn.style.opacity = '0.7';
      }
      setStatus('Job saved to tracker!', 'success');
      setTimeout(clearStatus, 2000);
    } catch (err) {
      setStatus('Error saving: ' + err.message, 'error');
    }
  }

  // ─── Mark as Applied ─────────────────────────────────────────

  /**
   * Records the current job as applied in the user's applied-jobs list.
   * Deduplication is handled by background.js (URL-based).
   * Updates the button text to "Applied ✓" on success.
   * @async
   */
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
  // The autofill pipeline:
  //   1. Detect — detectFormFields() scans the page and builds _fieldMap.
  //   2. AI     — GENERATE_AUTOFILL sends questions to background, gets answers.
  //   3. Fill   — fillFormFromAnswers() immediately writes answers into the form.

  /**
   * Initiates the autofill pipeline: detects fields, asks AI for answers,
   * then immediately fills the form.
   * @async
   */
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

      setStatus(`Found ${questions.length} fields. Filling...`, 'info');

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

      // Step 3: directly fill the form
      const answers = response.answers || response;
      const { filled, skipped } = await fillFormFromAnswers(answers);
      const msg = `Filled ${filled} field${filled === 1 ? '' : 's'}` +
        (skipped.length ? ` (${skipped.length} need your input)` : '');
      setStatus(msg, 'success');
      setTimeout(clearStatus, 3000);
    } catch (err) {
      setStatus('Error: ' + err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.innerHTML = 'AutoFill Application';
    }
  }

  /**
   * Renders the autofill preview panel, showing each detected field alongside
   * the AI's proposed answer.  Fields flagged as NEEDS_USER_INPUT are highlighted.
   * Stores answers and questions in _pendingAnswers/_pendingQuestions for applyAutofill.
   * @param {Array<Object>} answers   - AI answer objects from GENERATE_AUTOFILL.
   * @param {Array<Object>} questions - Detected form field descriptors.
   */
  function showAutofillPreview(answers, questions) {
    const previewSection = shadowRoot.getElementById('jmAutofillPreview');
    const list = shadowRoot.getElementById('jmPreviewList');
    const countEl = shadowRoot.getElementById('jmPreviewCount');

    list.innerHTML = '';

    const questionMap = {};
    questions.forEach(q => { questionMap[q.question_id] = q; });

    let fillableCount = 0;
    let needsInputCount = 0;

    (Array.isArray(answers) ? answers : []).forEach(ans => {
      const val = ans.selected_option || ans.generated_text || '';
      const isNeeded = !val || val === 'NEEDS_USER_INPUT';
      const qInfo = questionMap[ans.question_id];
      const label = qInfo?.question_text || ans.question_id || '';

      if (isNeeded) needsInputCount++;
      else fillableCount++;

      const row = document.createElement('div');
      row.className = 'jm-preview-row' + (isNeeded ? ' jm-needs-input' : '');
      row.dataset.qid = ans.question_id;

      if (isNeeded) {
        row.innerHTML = `
          <div style="flex:1">
            <div class="jm-preview-label">${escapeHTML(label)}</div>
            <div class="jm-preview-val">&#9888; Needs manual input</div>
          </div>`;
      } else {
        const displayVal = val.length > 70 ? val.substring(0, 70) + '…' : val;
        row.innerHTML = `
          <input type="checkbox" checked data-qid="${escapeHTML(ans.question_id)}">
          <div style="flex:1;min-width:0">
            <div class="jm-preview-label">${escapeHTML(label)}</div>
            <div class="jm-preview-val" title="${escapeHTML(val)}">${escapeHTML(displayVal)}</div>
          </div>`;
      }
      list.appendChild(row);
    });

    countEl.textContent = `— ${fillableCount} fillable, ${needsInputCount} need manual input`;
    previewSection.style.display = 'block';
    scrollPanelTo(previewSection);
  }

  /**
   * Applies the pending autofill answers to the form (phase 3 of the pipeline).
   * Called when the user clicks "Apply Selected" in the preview panel.
   * Shows a summary toast indicating how many fields were filled vs skipped.
   * @async
   */
  async function applyAutofill() {
    if (!_pendingAnswers) return;
    const applyBtn = shadowRoot.getElementById('jmApplyFill');
    applyBtn.disabled = true;
    applyBtn.innerHTML = '<span class="jm-spinner"></span> Filling...';

    try {
      const checkedIds = new Set(
        Array.from(shadowRoot.querySelectorAll('#jmPreviewList input[type="checkbox"]:checked'))
          .map(cb => cb.dataset.qid)
      );

      const selectedAnswers = (Array.isArray(_pendingAnswers) ? _pendingAnswers : [])
        .filter(a => checkedIds.has(a.question_id));

      const { filled, skipped } = await fillFormFromAnswers(selectedAnswers);

      let msg = `Filled ${filled} of ${selectedAnswers.length} selected fields.`;
      if (skipped.length > 0) {
        msg += ` ${skipped.length} could not be filled — check manually.`;
      }
      msg += ' Review before submitting!';
      setStatus(msg, 'success');

      shadowRoot.getElementById('jmAutofillPreview').style.display = 'none';
      _pendingAnswers = null;
      _pendingQuestions = [];
    } catch (err) {
      setStatus('Error: ' + err.message, 'error');
    } finally {
      applyBtn.disabled = false;
      applyBtn.innerHTML = 'Apply Selected';
    }
  }

  /** Dismisses the autofill preview panel and clears pending state. */
  function cancelAutofill() {
    shadowRoot.getElementById('jmAutofillPreview').style.display = 'none';
    _pendingAnswers = null;
    _pendingQuestions = [];
    clearStatus();
  }

  // ─── Inline autofill chips ────────────────────────────────────
  // Chips are injected directly into document.body (not Shadow DOM) so they
  // can be positioned right next to the actual form fields on the page.
  // Each chip shows the AI's proposed answer with ✓ Accept, ✗ Dismiss, and
  // inline editing. A sticky bar at the bottom provides Apply All / Dismiss All.

  const CHIP_STYLE_ID = 'jmai-chip-styles'; // ID of the injected <style> tag

  /**
   * Injects chip CSS into document.head once. Uses a unique `jmai-` prefix
   * to avoid colliding with the host page's styles.
   */
  function injectChipStyles() {
    if (document.getElementById(CHIP_STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = CHIP_STYLE_ID;
    style.textContent = `
      .jmai-chip {
        position: fixed;
        z-index: 2147483640;
        background: #fff;
        border: 1.5px solid #3b82f6;
        border-radius: 10px;
        box-shadow: 0 3px 14px rgba(59,130,246,0.22);
        display: flex;
        align-items: center;
        gap: 5px;
        padding: 5px 7px 5px 9px;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        font-size: 12px;
        color: #1e293b;
        max-width: 360px;
        min-width: 140px;
        pointer-events: all;
        transition: opacity 0.18s, transform 0.18s;
      }
      .jmai-chip.jmai-needs-input {
        border-color: #f59e0b;
        background: #fffbeb;
      }
      .jmai-chip-icon { font-size: 12px; flex-shrink: 0; color: #3b82f6; }
      .jmai-chip.jmai-needs-input .jmai-chip-icon { color: #f59e0b; }
      .jmai-chip-answer {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        cursor: text;
        padding: 2px 4px;
        border-radius: 4px;
        border: 1px solid transparent;
        font-size: 12px;
      }
      .jmai-chip-answer:focus {
        outline: none;
        border-color: #3b82f6;
        background: #eff6ff;
        white-space: normal;
        overflow: visible;
      }
      .jmai-chip-answer[data-empty]:before {
        content: attr(data-placeholder);
        color: #94a3b8;
        font-style: italic;
      }
      .jmai-chip-accept, .jmai-chip-dismiss {
        flex-shrink: 0;
        width: 22px;
        height: 22px;
        border-radius: 50%;
        border: none;
        cursor: pointer;
        font-size: 13px;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 0;
        line-height: 1;
      }
      .jmai-chip-accept { background: #059669; color: #fff; }
      .jmai-chip-accept:hover { background: #047857; }
      .jmai-chip-dismiss { background: #f1f5f9; color: #64748b; }
      .jmai-chip-dismiss:hover { background: #fecaca; color: #dc2626; }
      .jmai-chip.jmai-fade-out {
        opacity: 0;
        transform: scale(0.88) translateY(-4px);
        pointer-events: none;
      }
      .jmai-chip-bar {
        position: fixed;
        bottom: 0; left: 0; right: 0;
        z-index: 2147483641;
        background: #3b82f6;
        color: #fff;
        padding: 10px 20px;
        display: flex;
        align-items: center;
        gap: 10px;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        font-size: 13px;
        box-shadow: 0 -3px 20px rgba(59,130,246,0.3);
      }
      .jmai-bar-logo { font-size: 16px; }
      .jmai-bar-text { flex: 1; font-weight: 500; }
      .jmai-bar-apply {
        background: #fff;
        color: #3b82f6;
        border: none;
        border-radius: 7px;
        padding: 6px 18px;
        font-size: 13px;
        font-weight: 700;
        cursor: pointer;
        transition: background 0.15s;
      }
      .jmai-bar-apply:hover { background: #eff6ff; }
      .jmai-bar-dismiss {
        background: rgba(255,255,255,0.18);
        color: #fff;
        border: 1.5px solid rgba(255,255,255,0.4);
        border-radius: 7px;
        padding: 6px 14px;
        font-size: 13px;
        cursor: pointer;
      }
      .jmai-bar-dismiss:hover { background: rgba(255,255,255,0.28); }
      .jmai-field-ring {
        outline: 2.5px solid #3b82f6 !important;
        outline-offset: 2px !important;
      }
      .jmai-badge {
        position: fixed;
        z-index: 2147483639;
        display: inline-flex;
        align-items: center;
        gap: 3px;
        padding: 2px 7px 2px 5px;
        background: #ecfdf5;
        border: 1px solid #10b981;
        border-radius: 20px;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        font-size: 10px;
        font-weight: 500;
        color: #065f46;
        pointer-events: none;
        user-select: none;
        white-space: nowrap;
        box-shadow: 0 1px 4px rgba(16,185,129,0.15);
      }
      .jmai-badge svg {
        width: 10px;
        height: 10px;
        flex-shrink: 0;
      }
    `;
    document.head.appendChild(style);
  }

  /**
   * Shows a small fixed-position "✦ Autofilled by JobMatch AI" pill anchored to
   * the bottom-right corner of the filled field. Uses position:fixed so it never
   * pushes other elements down or disrupts the page layout.
   * @param {Element} el - The filled form element (input, select, radio, etc.).
   */
  function showAutofillBadge(el) {
    if (!el) return;
    injectChipStyles();

    const badge = document.createElement('div');
    badge.className = 'jmai-badge';
    badge.innerHTML = `<svg viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M6 1l1 3h3l-2.5 1.8.95 3L6 7.2 3.55 8.8l.95-3L2 4h3L6 1z" fill="#10b981"/>
    </svg>Autofilled by JobMatch AI`;
    document.body.appendChild(badge);

    // Position badge at the bottom-right corner of the field
    function place() {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return; // element not visible
      badge.style.top  = (r.bottom - 1) + 'px';
      badge.style.left = Math.max(0, r.right - badge.offsetWidth) + 'px';
    }
    place();

    _badges.push({ badgeEl: badge, fieldEl: el, place });

    // Reposition on scroll/resize using shared listeners (set up once)
    if (_badges.length === 1) {
      _badgeScrollHandler = () => _badges.forEach(b => b.place());
      window.addEventListener('scroll', _badgeScrollHandler, { passive: true, capture: true });
      _badgeResizeObs = new ResizeObserver(() => _badges.forEach(b => b.place()));
      _badgeResizeObs.observe(document.body);
    }
  }

  /** Removes all autofill badges and their scroll/resize listeners. */
  function clearAutofillBadges() {
    _badges.forEach(({ badgeEl }) => badgeEl.remove());
    _badges = [];
    if (_badgeScrollHandler) {
      window.removeEventListener('scroll', _badgeScrollHandler, { capture: true });
      _badgeScrollHandler = null;
    }
    if (_badgeResizeObs) { _badgeResizeObs.disconnect(); _badgeResizeObs = null; }
  }

  /**
   * Main entry point: creates a chip for every AI answer that has a value,
   * positions each chip near its form field, and shows the sticky bottom bar.
   * @param {Array<Object>} answers - AI answer objects from GENERATE_AUTOFILL.
   */
  function showInlineChips(answers) {
    clearAllChips();
    injectChipStyles();

    if (!Array.isArray(answers)) answers = answers ? [answers] : [];

    let count = 0;

    answers.forEach(ans => {
      const val   = (ans.answer_value || ans.answer || '').trim();
      const qid   = ans.question_id;
      const ref   = _fieldMap[qid];
      if (!ref) return;

      // Resolve the DOM element to anchor the chip to
      const fieldEl = ref.type === 'radio'
        ? ref.options?.[0]?.el     // first radio button in the group
        : ref.el;
      if (!fieldEl) return;

      const needsInput = !val || val === 'NEEDS_USER_INPUT' || val === 'SKIP';

      // Highlight the field so the user can see it's detected
      fieldEl.classList.add('jmai-field-ring');

      // ── Build the chip ──────────────────────────────────────────
      const chip = document.createElement('div');
      chip.className = 'jmai-chip' + (needsInput ? ' jmai-needs-input' : '');
      chip.dataset.qid = qid;

      // Icon
      const icon = document.createElement('span');
      icon.className = 'jmai-chip-icon';
      icon.textContent = needsInput ? '?' : '★';

      // Editable answer text
      const ansEl = document.createElement('span');
      ansEl.className = 'jmai-chip-answer';
      ansEl.contentEditable = 'true';
      ansEl.spellcheck = false;
      if (needsInput) {
        ansEl.setAttribute('data-empty', '');
        ansEl.setAttribute('data-placeholder', 'Enter your answer…');
        ansEl.title = `${ans.question_text || 'Field'} — enter your answer`;
      } else {
        ansEl.textContent = val;
        ansEl.title = `${ans.question_text || 'Field'}: ${val} — click to edit`;
      }
      // Remove empty-placeholder attribute once user starts typing
      ansEl.addEventListener('input', () => {
        if (ansEl.textContent.trim()) ansEl.removeAttribute('data-empty');
        else ansEl.setAttribute('data-empty', '');
      });

      // ✓ Accept button
      const acceptBtn = document.createElement('button');
      acceptBtn.className = 'jmai-chip-accept';
      acceptBtn.textContent = '✓';
      acceptBtn.title = 'Apply this answer';

      // ✗ Dismiss button
      const dismissBtn = document.createElement('button');
      dismissBtn.className = 'jmai-chip-dismiss';
      dismissBtn.textContent = '✕';
      dismissBtn.title = 'Skip this field';

      chip.appendChild(icon);
      chip.appendChild(ansEl);
      chip.appendChild(acceptBtn);
      chip.appendChild(dismissBtn);
      document.body.appendChild(chip);

      const chipData = { chipEl: chip, fieldEl, ans, ansEl };
      _chips.set(qid, chipData);
      positionChip(chip, fieldEl);
      count++;

      // ── Accept handler ──────────────────────────────────────────
      acceptBtn.addEventListener('click', async () => {
        const currentVal = ansEl.textContent.trim();
        if (!currentVal) { ansEl.focus(); return; } // force user to type something for empty fields
        ans.answer_value = currentVal;
        ans.answer       = currentVal;
        await fillSingleField(ans);
        removeChip(qid);
      });

      // ── Dismiss handler ─────────────────────────────────────────
      dismissBtn.addEventListener('click', () => removeChip(qid));
    });

    if (count === 0) {
      setStatus('No fillable fields detected on this page.', 'info');
      setTimeout(clearStatus, 2500);
      return;
    }

    createChipBar(count);

    // Reposition chips on scroll (page scrolls, field rects change)
    _chipScrollHandler = repositionAllChips;
    window.addEventListener('scroll', _chipScrollHandler, { passive: true });

    // Reposition chips if the page layout changes (e.g. accordions opening)
    _chipResizeObs = new ResizeObserver(repositionAllChips);
    _chipResizeObs.observe(document.documentElement);
  }

  /**
   * Positions a chip above the field if space allows, otherwise below.
   * Uses position:fixed with getBoundingClientRect() so it tracks the viewport.
   * @param {HTMLElement} chipEl  - The chip element.
   * @param {HTMLElement} fieldEl - The form field to anchor to.
   */
  function positionChip(chipEl, fieldEl) {
    const rect = fieldEl.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      chipEl.style.display = 'none'; // field not visible — hide chip
      return;
    }
    chipEl.style.display = '';

    // Width: match field width, clamped between 160px and 360px
    const w = Math.min(360, Math.max(160, rect.width));
    chipEl.style.width = w + 'px';

    // Horizontal: align left edge with field, clamp to viewport
    const left = Math.min(Math.max(4, rect.left), window.innerWidth - w - 4);
    chipEl.style.left = left + 'px';

    // Vertical: prefer above (need ~42px clearance), fall back to below
    const CHIP_H = 42;
    if (rect.top >= CHIP_H + 6) {
      chipEl.style.top = (rect.top - CHIP_H - 4) + 'px';
    } else {
      chipEl.style.top = (rect.bottom + 4) + 'px';
    }
  }

  /** Repositions all visible chips — called on scroll/resize. */
  function repositionAllChips() {
    _chips.forEach(({ chipEl, fieldEl }) => positionChip(chipEl, fieldEl));
  }

  /**
   * Removes a single chip with a fade animation, unhighlights its field,
   * and updates the bottom bar count. Clears everything when the last chip goes.
   * @param {string} qid - The question_id of the chip to remove.
   */
  function removeChip(qid) {
    const data = _chips.get(qid);
    if (!data) return;
    const { chipEl, fieldEl } = data;
    fieldEl.classList.remove('jmai-field-ring');
    chipEl.classList.add('jmai-fade-out');
    setTimeout(() => { chipEl.remove(); }, 200);
    _chips.delete(qid);
    if (_chips.size === 0) {
      clearAllChips();
      // Reset the AutoFill button
      const btn = shadowRoot && shadowRoot.getElementById('jmAutofill');
      if (btn) { btn.innerHTML = 'AutoFill Application'; btn.onclick = null; }
    } else {
      updateChipBar();
    }
  }

  /**
   * Creates the sticky bottom bar with Apply All / Dismiss All controls.
   * @param {number} count - Initial suggestion count for the label.
   */
  function createChipBar(count) {
    if (_chipBar) _chipBar.remove();
    const bar = document.createElement('div');
    bar.className = 'jmai-chip-bar';
    bar.innerHTML = `
      <span class="jmai-bar-logo">★</span>
      <span class="jmai-bar-text">${count} suggestion${count === 1 ? '' : 's'} ready</span>
      <button class="jmai-bar-apply">Apply All</button>
      <button class="jmai-bar-dismiss">Dismiss All</button>
    `;
    document.body.appendChild(bar);
    _chipBar = bar;
    bar.querySelector('.jmai-bar-apply').addEventListener('click', applyAllChips);
    bar.querySelector('.jmai-bar-dismiss').addEventListener('click', clearAllChips);
  }

  /** Updates the suggestion count label in the bottom bar. */
  function updateChipBar() {
    if (!_chipBar) return;
    const n = _chips.size;
    const label = _chipBar.querySelector('.jmai-bar-text');
    if (label) label.textContent = `${n} suggestion${n === 1 ? '' : 's'} remaining`;
  }

  /**
   * Applies all remaining chip answers to their respective form fields, then cleans up.
   * Skips any chip whose answer text is empty.
   * @async
   */
  async function applyAllChips() {
    const entries = Array.from(_chips.values());
    let filled = 0;
    for (const { ans, ansEl, fieldEl } of entries) {
      const currentVal = ansEl.textContent.trim();
      if (!currentVal || currentVal === 'NEEDS_USER_INPUT') continue;
      ans.answer_value = currentVal;
      ans.answer       = currentVal;
      await fillSingleField(ans);
      fieldEl.classList.remove('jmai-field-ring');
      filled++;
    }
    // Show brief success message in the bar before clearing
    if (_chipBar) {
      const label = _chipBar.querySelector('.jmai-bar-text');
      if (label) label.textContent = `✓ ${filled} field${filled === 1 ? '' : 's'} filled!`;
    }
    setTimeout(() => {
      clearAllChips();
      const btn = shadowRoot && shadowRoot.getElementById('jmAutofill');
      if (btn) { btn.innerHTML = 'AutoFill Application'; btn.onclick = null; }
    }, 700);
  }

  /**
   * Removes all chips, the bottom bar, field highlights, and event listeners.
   * Safe to call even when no chips are active.
   */
  function clearAllChips() {
    _chips.forEach(({ chipEl, fieldEl }) => {
      fieldEl.classList.remove('jmai-field-ring');
      chipEl.remove();
    });
    _chips.clear();
    if (_chipBar)          { _chipBar.remove();                _chipBar = null; }
    if (_chipScrollHandler){ window.removeEventListener('scroll', _chipScrollHandler); _chipScrollHandler = null; }
    if (_chipResizeObs)    { _chipResizeObs.disconnect();      _chipResizeObs = null; }
  }

  /**
   * Fills a single form field from one AI answer object.
   * Routes to the correct fill function based on the field type in _fieldMap.
   * @async
   * @param {Object} ans - Answer object with question_id and answer_value.
   */
  async function fillSingleField(ans) {
    const ref = _fieldMap[ans.question_id];
    if (!ref) return;
    const val = (ans.answer_value || ans.answer || '').trim();
    if (!val) return;
    try {
      if (ref.type === 'dropdown') {
        const questionText = ref.questionText || ans.question_text || '';
        if (questionText && ref.optionTexts?.length) {
          const best = await sendMessage({ type: 'MATCH_DROPDOWN', questionText, options: ref.optionTexts });
          if (best && best !== 'SKIP' && best !== 'NEEDS_USER_INPUT') {
            fillSelectByText(ref.el, best, ref.optionMap, ref.optionTexts);
            return;
          }
        }
        fillSelectByText(ref.el, val, ref.optionMap, ref.optionTexts);
      } else if (ref.type === 'custom_dropdown') {
        await fillCustomDropdown(ref.el, ref.questionText || val);
      } else if (ref.type === 'radio') {
        fillRadioFromRef(ref.options, val);
      } else if (ref.type === 'checkbox') {
        fillCheckboxFromRef(ref.el, val);
      } else {
        fillInput(ref.el, val);
      }
    } catch (_) { /* ignore individual fill errors — don't block other fields */ }
  }

  // ─── Form field detection ─────────────────────────────────────
  // Scans the live DOM for all fillable form fields and builds two data structures:
  //   questions[] — serialisable descriptors sent to the AI (label, type, options)
  //   _fieldMap   — maps each question_id to the actual DOM element(s) for filling
  //
  // Supported field types: text/email/tel/number inputs, textareas, native <select>,
  // custom dropdown triggers (aria-combobox, aria-haspopup), radio groups, checkboxes.

  /**
   * Detects all fillable form fields on the current page.
   * Populates the module-level _fieldMap and returns a serialisable questions array.
   * @returns {Array<Object>} Array of field descriptors to send to the AI.
   */
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

    return questions;
  }

  /**
   * Extracts the visible label text for a radio button.
   * Clones the parent label and strips the input element to get only text.
   * @param {HTMLInputElement} input - A radio input element.
   * @returns {string} The label text, or '' if not determinable.
   */
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

  /**
   * Resolves a human-readable label for a form input using multiple strategies:
   * 1. <label for="id"> association, 2. wrapping <label>, 3. aria-label/aria-labelledby,
   * 4. placeholder, 5. nearby sibling/parent text.
   * @param {HTMLElement} input - Any form element.
   * @returns {string} The best label text found, or ''.
   */
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

  /**
   * Fills form fields using AI-generated answers and the _fieldMap built by detectFormFields.
   * Routes each answer to the correct fill strategy based on the field type:
   *   - 'dropdown'        → fillSelectByText (native <select>)
   *   - 'custom_dropdown' → fillCustomDropdown (ARIA combobox, opens a listbox)
   *   - 'radio'           → fillRadioFromRef
   *   - 'checkbox'        → fillCheckboxFromRef
   *   - default           → fillInput (text/textarea/email/etc.)
   *
   * Falls back to fillFormLegacy() if answers is a plain object (old AI response format).
   * @async
   * @param {Array<Object>|Object} answers - AI answer array or legacy flat object.
   * @returns {Promise<{filled: number, skipped: string[]}>}
   */
  async function fillFormFromAnswers(answers) {
    // Handle array format (new) or flat object (legacy)
    if (!Array.isArray(answers)) {
      return await fillFormLegacy(answers);
    }

    let filled = 0;
    const skipped = [];

    for (const ans of answers) {
      const val = ans.selected_option || ans.generated_text || '';
      if (!val || val === 'NEEDS_USER_INPUT') {
        skipped.push(ans.question_id);
        continue;
      }
      const qid = ans.question_id;

      try {
        const ref = _fieldMap[qid];
        if (!ref) {
          skipped.push(qid);
          continue;
        }


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
                showAutofillBadge(ref.el);
                filled++;
                continue;
              }
            } catch (e) {
            }
          }
          // Fallback: use the bulk AI answer directly
          fillSelectByText(ref.el, val, ref.optionMap, ref.optionTexts);
          showAutofillBadge(ref.el);
          filled++;
        } else if (ref.type === 'custom_dropdown') {
          if (await fillCustomDropdown(ref.el, ref.questionText || val)) {
            showAutofillBadge(ref.el);
            filled++;
          } else {
            skipped.push(qid);
          }
        } else if (ref.type === 'radio') {
          if (fillRadioFromRef(ref.radios, val)) {
            // Badge goes below the last radio in the group
            const lastRadio = ref.radios[ref.radios.length - 1]?.el || ref.radios[0]?.el;
            showAutofillBadge(lastRadio);
            filled++;
          } else {
            skipped.push(qid);
          }
        } else if (ref.type === 'checkbox') {
          fillCheckboxFromRef(ref.el, val);
          showAutofillBadge(ref.el);
          filled++;
        } else {
          fillInput(ref.el, val);
          showAutofillBadge(ref.el);
          filled++;
        }
      } catch (e) {
        skipped.push(qid);
      }
    }
    return { filled, skipped };
  }

  /**
   * Legacy fill path for old-format AI responses (flat key→value object).
   * Used as a fallback when the AI returns a map instead of an array.
   * @async
   * @param {Object} mapping - Map of field identifiers to answer strings.
   * @returns {Promise<{filled: number, skipped: []}>}
   */
  async function fillFormLegacy(mapping) {
    let filled = 0;
    for (const [key, value] of Object.entries(mapping)) {
      if (!value || value === 'NEEDS_USER_INPUT') continue;
      const ref = _fieldMap[key];
      if (!ref) continue;
      if (ref.type === 'dropdown') {
        fillSelectByText(ref.el, value, ref.optionMap, ref.optionTexts);
        showAutofillBadge(ref.el);
      } else if (ref.type === 'custom_dropdown') {
        await fillCustomDropdown(ref.el, ref.questionText || value);
        showAutofillBadge(ref.el);
      } else {
        fillInput(ref.el, value);
        showAutofillBadge(ref.el);
      }
      filled++;
    }
    return { filled, skipped: [] };
  }

  // ── Custom dropdown: open → read options → ask AI → click chosen option ──
  // Custom dropdowns (used by Workday, Greenhouse, Lever, etc.) are not native
  // <select> elements — they are ARIA comboboxes that render a listbox on click.
  // Strategy: programmatically open them, read the live option elements, ask AI
  // to pick one, then click the matching element and wait for it to register.

  /**
   * Fills a custom ARIA dropdown by: opening it, reading its options,
   * sending them to the AI, and clicking the AI's chosen option.
   * @async
   * @param {HTMLElement} input        - The combobox trigger element.
   * @param {string}      questionText - The field's label, sent to the AI for context.
   * @returns {Promise<boolean>} true if successfully filled, false otherwise.
   */
  async function fillCustomDropdown(input, questionText) {

    // Step 1: Click to open the dropdown
    input.focus();
    input.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    input.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    input.click();
    await sleep(600);

    // Step 2: Read all visible option elements from the live DOM
    const optionEls = findVisibleOptions(input);
    if (optionEls.length === 0) {
      // Close the dropdown
      document.body.click();
      return false;
    }

    const optionTexts = optionEls.map(o => o.text);

    // Step 3: Ask AI to pick the best option
    let aiChoice;
    try {
      aiChoice = await sendMessage({
        type: 'MATCH_DROPDOWN',
        questionText: questionText,
        options: optionTexts
      });
    } catch (e) {
      document.body.click();
      return false;
    }


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
        await sleep(200);
        return true;
      }
    }

    // Normalized match
    for (const opt of optionEls) {
      if (opt.text.toLowerCase().replace(/[^a-z0-9]/g, '') === choiceNorm) {
        clickElement(opt.el);
        await sleep(200);
        return true;
      }
    }

    // Partial/contains match
    for (const opt of optionEls) {
      const optLower = opt.text.toLowerCase().trim();
      if (optLower.includes(choiceLower) || choiceLower.includes(optLower)) {
        clickElement(opt.el);
        await sleep(200);
        return true;
      }
    }

    document.body.click();
    return false;
  }

  /**
   * Finds all visible option elements for an open custom dropdown.
   * Checks the aria-controls listbox, nearby parent containers, and
   * any floating listbox/option elements currently in the DOM.
   * @param {HTMLElement} triggerEl - The combobox trigger that was clicked to open the dropdown.
   * @returns {Array<{text: string, el: HTMLElement}>} List of option text+element pairs.
   */
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

  /**
   * Collects visible, non-placeholder option elements from a node list.
   * Skips hidden elements (zero bounding rect) and placeholder text like "Select…".
   * @param {NodeList|Array} nodeList - DOM elements to scan.
   * @param {Array}          results  - Accumulator array of {text, el} objects.
   * @param {Set}            seen     - Set of already-collected text values (dedup).
   */
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

  /**
   * Dispatches mousedown, mouseup, and click events on an element.
   * Required for custom dropdowns that listen to low-level mouse events
   * rather than just the 'click' event.
   * @param {HTMLElement} el - The element to click.
   */
  function clickElement(el) {
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    el.click();
  }

  /** Returns a Promise that resolves after `ms` milliseconds. Used for async waits during form fill. */
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // ── Select: match AI's option text → actual option value, then select it ──

  /**
   * Selects the best matching option in a native <select> element.
   * Tries six strategies in order: exact map lookup, exact value match,
   * exact text match, normalised match (strip punctuation), partial/contains match,
   * and finally a word-overlap fuzzy score.
   * @param {HTMLSelectElement} select      - The native select element to fill.
   * @param {string}            aiText      - The option text chosen by the AI.
   * @param {Object}            optionMap   - Map of lowercase option text → option value.
   * @param {string[]}          optionTexts - Array of option text strings (for fallback).
   */
  function fillSelectByText(select, aiText, optionMap, optionTexts) {
    const text = String(aiText).trim();
    const textLower = text.toLowerCase();

    // 1. Exact text match → get the real value from our map
    if (optionMap && optionMap[textLower] !== undefined) {
      select.value = optionMap[textLower];
      fireEvents(select);
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
        return;
      }
    }

    // 4. Partial / contains match on text
    for (const opt of realOptions) {
      const optText = opt.textContent.trim().toLowerCase();
      if (optText.includes(textLower) || textLower.includes(optText)) {
        select.value = opt.value;
        fireEvents(select);
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
      return;
    }

  }

  // ── Radio: use stored refs directly ──

  /**
   * Selects a radio button from a group based on the AI's text answer.
   * Tries exact label match, then normalised match, then partial match.
   * @param {Array<{text: string, el: HTMLInputElement}>} radioRefs - Radio option refs.
   * @param {string} selectedText - The option text chosen by the AI.
   */
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

  /**
   * Checks or unchecks a checkbox based on the AI's answer value.
   * Treats 'yes', 'true', '1', 'agree', 'accept' as truthy.
   * @param {HTMLInputElement} cb    - The checkbox element.
   * @param {string}           value - The AI's answer string.
   */
  function fillCheckboxFromRef(cb, value) {
    const shouldCheck = /^(yes|true|1|checked|agree|accept)$/i.test(String(value).trim());
    if (cb.checked !== shouldCheck) {
      cb.checked = shouldCheck;
      fireEvents(cb);
    }
  }

  // ── Shared event dispatcher ──

  /**
   * Fires input, change, and blur events on an element.
   * Required to notify React/Vue/Angular frameworks that the value was
   * changed programmatically — without these events, the framework's
   * internal state won't update and the value may be ignored on submit.
   * @param {HTMLElement} el - The form element that was just filled.
   */
  function fireEvents(el) {
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
  }

  /**
   * Sets a text input or textarea value in a React-compatible way.
   * React overrides the native value setter — if you set input.value directly,
   * React won't detect the change and the field will appear unchanged on submit.
   * Using Object.getOwnPropertyDescriptor to access the native setter bypasses
   * React's override and triggers its synthetic event system correctly.
   * @param {HTMLInputElement|HTMLTextAreaElement} input - The input to fill.
   * @param {string} value - The value to set.
   */
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


  // ─── Cover letter ─────────────────────────────────────────────

  /**
   * Generates a tailored cover letter for the current job via the AI and
   * displays it in the Cover Letter section of the panel.
   * Requires a completed analysis (currentAnalysis must be non-null).
   * @async
   */
  async function generateCoverLetter() {
    const btn = shadowRoot.getElementById('jmCoverLetterBtn');
    btn.disabled = true;
    btn.innerHTML = '<span class="jm-spinner"></span> Writing...';
    try {
      if (!currentAnalysis) throw new Error('Analyze the job first.');
      const jd = extractJobDescription();
      const clResult = await sendMessage({
        type: 'GENERATE_COVER_LETTER',
        jobDescription: jd,
        analysis: {
          matchingSkills: currentAnalysis.matchingSkills,
          matchScore: currentAnalysis.matchScore
        },
        jobMeta: {
          title: currentAnalysis.title || '',
          company: currentAnalysis.company || '',
          location: currentAnalysis.location || '',
          salary: currentAnalysis.salary || ''
        }
      });
      // Support both old string and new object response format
      const text = typeof clResult === 'string' ? clResult : clResult.text;
      const clTruncated = typeof clResult === 'object' && clResult.truncated;
      shadowRoot.getElementById('jmCoverLetterText').textContent = text;
      const section = shadowRoot.getElementById('jmCoverLetterSection');
      section.style.display = 'block';
      scrollPanelTo(section);
    } catch (err) {
      setStatus('Error: ' + err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.innerHTML = '&#9993; Cover Letter';
    }
  }

  // ─── Bullet rewriter ──────────────────────────────────────────

  /**
   * Requests AI-rewritten resume bullets targeted at the current job's missing skills.
   * Shows the Improved Resume Bullets section immediately (before AI responds) so the
   * user can see a loading state, then populates it with before/after pairs.
   * Each bullet has a Copy button to copy the improved version to clipboard.
   * @async
   */
  async function rewriteBullets() {
    const btn = shadowRoot.getElementById('jmRewriteBulletsBtn');
    btn.disabled = true;
    btn.innerHTML = '<span class="jm-spinner"></span> Analyzing...';
    const section = shadowRoot.getElementById('jmBulletSection');
    const list = shadowRoot.getElementById('jmBulletList');
    list.innerHTML = '';
    section.style.display = 'block';
    try {
      if (!currentAnalysis) throw new Error('Analyze the job first.');
      const jd = extractJobDescription();
      const bullets = await sendMessage({
        type: 'REWRITE_BULLETS',
        jobDescription: jd,
        missingSkills: currentAnalysis.missingSkills || []
      });

      if (!Array.isArray(bullets) || bullets.length === 0) {
        list.innerHTML = '<p style="font-size:12px;color:var(--jm-text-secondary);">No bullet improvements generated. Your resume experience section may be empty or the AI could not suggest improvements.</p>';
      } else {
        bullets.forEach(b => {
          const item = document.createElement('div');
          item.className = 'jm-bullet-item';
          // Build skill chips HTML from missing skills
          const missingSkills = currentAnalysis.missingSkills || [];
          const skillChipsHtml = missingSkills.map(s =>
            `<span class="jm-skill-chip" data-skill="${escapeHTML(s)}">${escapeHTML(s)}</span>`
          ).join('');

          item.innerHTML = `
            <div class="jm-bullet-header">
              <span class="jm-bullet-toggle-wrap" data-tip="Uncheck to exclude from tailored resume"><input type="checkbox" class="jm-bullet-toggle" checked></span>
              <div class="jm-bullet-job">${escapeHTML(b.job || '')}</div>
              <button class="jm-bullet-skills-btn" title="Manage missing skills for this bullet">Skills</button>
            </div>
            <div class="jm-bullet-skills-panel">
              <div class="jm-bullet-skills-label">Missing skills to include (click to exclude)</div>
              <div class="jm-bullet-skills-list">${skillChipsHtml}</div>
            </div>
            <div class="jm-bullet-before">${escapeHTML(b.original || '')}</div>
            <div class="jm-bullet-after" contenteditable="true" spellcheck="false" title="Click to edit — changes are used when regenerating or generating tailored resume">${escapeHTML(b.improved || '')}</div>
            <div class="jm-bullet-actions">
              <button class="jm-btn jm-btn-secondary jm-bullet-copy">Copy</button>
              <button class="jm-bullet-refresh" title="Regenerate this bullet">&#8635;</button>
            </div>`;
          // Include/exclude toggle
          item.querySelector('.jm-bullet-toggle').addEventListener('change', (e) => {
            item.classList.toggle('jm-excluded', !e.target.checked);
            e.target.closest('.jm-bullet-toggle-wrap').dataset.tip = e.target.checked
              ? 'Uncheck to exclude from tailored resume'
              : 'Check to include in tailored resume';
          });

          // Skills panel toggle
          item.querySelector('.jm-bullet-skills-btn').addEventListener('click', () => {
            const panel = item.querySelector('.jm-bullet-skills-panel');
            const btn = item.querySelector('.jm-bullet-skills-btn');
            panel.classList.toggle('jm-open');
            btn.classList.toggle('jm-active');
          });

          // Skill chip toggle (click to include/exclude)
          item.querySelectorAll('.jm-skill-chip').forEach(chip => {
            chip.addEventListener('click', () => {
              chip.classList.toggle('jm-excluded-skill');
            });
          });

          // Copy button
          item.querySelector('.jm-bullet-copy').addEventListener('click', () => {
            const currentText = item.querySelector('.jm-bullet-after').textContent;
            navigator.clipboard.writeText(currentText).then(() => {
              const cb = item.querySelector('.jm-bullet-copy');
              cb.textContent = 'Copied!';
              setTimeout(() => { cb.textContent = 'Copy'; }, 1500);
            }).catch(() => {});
          });

          // Regenerate — uses only the included skills for this bullet
          item.querySelector('.jm-bullet-refresh').addEventListener('click', async (e) => {
            const refreshBtn = e.currentTarget;
            refreshBtn.disabled = true;
            refreshBtn.classList.add('jm-spinning');
            try {
              const jd = extractJobDescription();
              const original = item.querySelector('.jm-bullet-before').textContent;
              const currentEdit = item.querySelector('.jm-bullet-after').textContent.trim();
              // Get only the included (non-excluded) skills for this bullet
              const bulletSkills = [];
              item.querySelectorAll('.jm-skill-chip:not(.jm-excluded-skill)').forEach(chip => {
                bulletSkills.push(chip.dataset.skill);
              });
              const newBullet = await sendMessage({
                type: 'REWRITE_SINGLE_BULLET',
                originalBullet: original,
                currentEdit: currentEdit !== original ? currentEdit : '',
                jobDescription: jd,
                missingSkills: bulletSkills
              });
              item.querySelector('.jm-bullet-after').textContent = newBullet;
            } catch (err) {
              item.querySelector('.jm-bullet-after').textContent = 'Error: ' + err.message;
            } finally {
              refreshBtn.disabled = false;
              refreshBtn.classList.remove('jm-spinning');
            }
          });
          list.appendChild(item);
        });
        // Show add custom bullet area and bottom generate button
        shadowRoot.getElementById('jmAddBulletArea').style.display = 'block';
        shadowRoot.getElementById('jmTailoredResumeBtnBottom').style.display = 'flex';
      }
    } catch (err) {
      list.innerHTML = `<p style="font-size:12px;color:#dc2626;">Error: ${escapeHTML(err.message)}</p>`;
    } finally {
      scrollPanelTo(section);
      btn.disabled = false;
      btn.innerHTML = '&#9997; Improve Resume Bullets';
    }
  }

  // ─── Tailored resume generator ───────────────────────────────

  /**
   * Generates a tailored DOCX resume by sending rewritten bullets to the
   * background service worker, which edits the DOCX directly using JSZip.
   * Downloads the modified DOCX file.
   * @async
   */
  async function generateTailoredResume() {
    const btn = shadowRoot.getElementById('jmTailoredResumeBtn');
    const section = shadowRoot.getElementById('jmTailoredResumeSection');
    const status = shadowRoot.getElementById('jmTailoredResumeStatus');
    btn.disabled = true;
    btn.innerHTML = '<span class="jm-spinner"></span> Generating...';
    section.style.display = 'block';
    status.textContent = '';

    try {
      if (!currentAnalysis) throw new Error('Analyze the job first.');

      // Collect only CHECKED bullets from the UI (both rewritten and custom)
      const bulletItems = shadowRoot.querySelectorAll('.jm-bullet-item');
      const rewrittenBullets = [];
      const customBullets = [];
      bulletItems.forEach(item => {
        // Skip excluded bullets (unchecked checkbox adds jm-excluded class)
        if (item.classList.contains('jm-excluded')) return;
        const checkbox = item.querySelector('.jm-bullet-toggle');
        if (checkbox && !checkbox.checked) return;
        const improved = item.querySelector('.jm-bullet-after')?.textContent || '';
        if (!improved) return;

        if (item.classList.contains('jm-custom-bullet')) {
          // Custom bullet — needs to be inserted, not replaced
          customBullets.push({
            text: improved,
            targetSection: item.dataset.targetSection || '',
            targetIdx: parseInt(item.dataset.targetIdx || '0', 10),
          });
        } else {
          // Rewritten bullet — replaces existing text
          const original = item.querySelector('.jm-bullet-before')?.textContent || '';
          if (original && original !== improved) {
            rewrittenBullets.push({ original, improved });
          }
        }
      });

      if (rewrittenBullets.length === 0 && customBullets.length === 0) {
        throw new Error('No bullets selected. Click "Improve Resume Bullets" first and check the ones you want to include.');
      }

      status.textContent = 'Editing your resume...';

      // Send to background for DOCX editing
      const result = await sendMessage({
        type: 'GENERATE_TAILORED_RESUME',
        rewrittenBullets,
        customBullets,
        missingSkills: currentAnalysis.missingSkills || []
      });

      // Build filename: {originalName}_{company or autoId}.docx
      const company = (currentAnalysis.company || '').replace(/[^a-zA-Z0-9 ]/g, '').trim().replace(/\s+/g, '_');
      const baseName = (result.originalFileName || 'resume').replace(/\.docx$/i, '');
      let downloadName;
      if (company) {
        downloadName = `${baseName}_${company}.docx`;
      } else {
        const counter = await sendMessage({ type: 'INCREMENT_RESUME_COUNTER' });
        downloadName = `${baseName}_${counter}.docx`;
      }

      // Convert base64 to blob and trigger download
      const binaryString = atob(result.base64);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      const blob = new Blob([bytes.buffer], {
        type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = downloadName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      const totalSelected = rewrittenBullets.length + customBullets.length;
      const totalAll = shadowRoot.querySelectorAll('.jm-bullet-item').length;
      const insertedInfo = result.insertedCount > 0 ? `, inserted <strong>${result.insertedCount}</strong> new` : '';
      const skippedInfo = totalAll > totalSelected ? ` (${totalAll - totalSelected} excluded)` : '';
      status.innerHTML = `Done! Replaced <strong>${result.replacedCount}</strong> of ${result.totalBullets} selected bullets${insertedInfo}${skippedInfo}. Downloaded as <strong>${escapeHTML(downloadName)}</strong>`;
      status.style.color = 'var(--jm-success, #16a34a)';
      if (result.replacedCount < result.totalBullets) {
        status.innerHTML += `<br><span style="color:var(--jm-text-secondary);font-size:11px;">${result.totalBullets - result.replacedCount} bullet(s) could not be matched in the DOCX. The text may have been split differently in the document.</span>`;
      }
      status.innerHTML += `<br><span style="margin-top:6px;display:inline-block;font-size:11px;color:#b45309;background:#fef3c7;padding:4px 8px;border-radius:4px;line-height:1.4;">&#9888; Please review the downloaded resume for accuracy and formatting before submitting your application.</span>`;
    } catch (err) {
      if (err.message === 'DOCX_REQUIRED' || err.message.includes('DOCX_REQUIRED')) {
        status.innerHTML = 'This feature requires a DOCX resume. Please go to <strong>Profile</strong> and upload your resume as a .docx file (not PDF).';
        status.style.color = '#dc2626';
      } else {
        status.textContent = 'Error: ' + err.message;
        status.style.color = '#dc2626';
      }
    } finally {
      scrollPanelTo(section);
      btn.disabled = false;
      btn.innerHTML = '&#128196; Generate Tailored Resume';
    }
  }

  // ─── Custom bullet generator ─────────────────────────────────

  /**
   * Populates the "Add under" dropdown with jobs and projects from the user's profile.
   */
  async function populateAddBulletDropdown() {
    const select = shadowRoot.getElementById('jmAddBulletTarget');
    select.innerHTML = '';
    try {
      const profile = await sendMessage({ type: 'GET_PROFILE' });
      if (profile?.experience) {
        profile.experience.forEach((exp, i) => {
          const opt = document.createElement('option');
          opt.value = `exp_${i}`;
          opt.textContent = `${exp.title || 'Role'} at ${exp.company || 'Company'}`;
          opt.dataset.section = 'experience';
          opt.dataset.idx = String(i);
          select.appendChild(opt);
        });
      }
      if (profile?.projects) {
        profile.projects.forEach((proj, i) => {
          const opt = document.createElement('option');
          opt.value = `proj_${i}`;
          opt.textContent = `Project: ${proj.name || proj.title || 'Untitled'}`;
          opt.dataset.section = 'projects';
          opt.dataset.idx = String(i);
          select.appendChild(opt);
        });
      }
    } catch (_) {
      const opt = document.createElement('option');
      opt.textContent = 'Could not load profile';
      select.appendChild(opt);
    }
  }

  /**
   * Generates a polished bullet from the user's rough description using AI,
   * then adds it to the bullet list as a custom bullet tagged with the selected job/project.
   */
  async function generateCustomBullet() {
    const input = shadowRoot.getElementById('jmAddBulletInput');
    const select = shadowRoot.getElementById('jmAddBulletTarget');
    const genBtn = shadowRoot.getElementById('jmAddBulletGenerate');
    const description = input.value.trim();

    if (!description) return;

    genBtn.disabled = true;
    genBtn.textContent = 'Generating...';

    try {
      const jd = extractJobDescription();
      const selectedOption = select.options[select.selectedIndex];
      const targetLabel = selectedOption?.textContent || 'Unknown';

      const polishedBullet = await sendMessage({
        type: 'GENERATE_CUSTOM_BULLET',
        description,
        targetRole: targetLabel,
        jobDescription: jd,
        missingSkills: currentAnalysis?.missingSkills || []
      });

      // Create a new bullet item in the list
      const list = shadowRoot.getElementById('jmBulletList');
      const item = document.createElement('div');
      item.className = 'jm-bullet-item jm-custom-bullet';
      // Store the target info for DOCX insertion
      item.dataset.customTarget = selectedOption?.value || '';
      item.dataset.targetSection = selectedOption?.dataset.section || '';
      item.dataset.targetIdx = selectedOption?.dataset.idx || '';

      const missingSkills = currentAnalysis?.missingSkills || [];
      const skillChipsHtml = missingSkills.map(s =>
        `<span class="jm-skill-chip" data-skill="${escapeHTML(s)}">${escapeHTML(s)}</span>`
      ).join('');

      item.innerHTML = `
        <div class="jm-bullet-header">
          <span class="jm-bullet-toggle-wrap" data-tip="Uncheck to exclude from tailored resume"><input type="checkbox" class="jm-bullet-toggle" checked></span>
          <div class="jm-bullet-job">${escapeHTML(targetLabel)}</div>
          <span class="jm-bullet-custom-tag">New</span>
          <button class="jm-bullet-skills-btn" title="Manage missing skills for this bullet">Skills</button>
        </div>
        <div class="jm-bullet-skills-panel">
          <div class="jm-bullet-skills-label">Missing skills to include (click to exclude)</div>
          <div class="jm-bullet-skills-list">${skillChipsHtml}</div>
        </div>
        <div class="jm-bullet-before" style="text-decoration:none;color:var(--jm-text-muted);font-style:italic;">${escapeHTML(description)}</div>
        <div class="jm-bullet-after" contenteditable="true" spellcheck="false" title="Click to edit">${escapeHTML(polishedBullet)}</div>
        <div class="jm-bullet-actions">
          <button class="jm-btn jm-btn-secondary jm-bullet-copy">Copy</button>
          <button class="jm-bullet-refresh" title="Regenerate this bullet">&#8635;</button>
        </div>`;

      // Wire events (same as regular bullets)
      item.querySelector('.jm-bullet-toggle').addEventListener('change', (e) => {
        item.classList.toggle('jm-excluded', !e.target.checked);
        e.target.closest('.jm-bullet-toggle-wrap').dataset.tip = e.target.checked
          ? 'Uncheck to exclude from tailored resume'
          : 'Check to include in tailored resume';
      });
      item.querySelector('.jm-bullet-skills-btn').addEventListener('click', () => {
        item.querySelector('.jm-bullet-skills-panel').classList.toggle('jm-open');
        item.querySelector('.jm-bullet-skills-btn').classList.toggle('jm-active');
      });
      item.querySelectorAll('.jm-skill-chip').forEach(chip => {
        chip.addEventListener('click', () => chip.classList.toggle('jm-excluded-skill'));
      });
      item.querySelector('.jm-bullet-copy').addEventListener('click', () => {
        navigator.clipboard.writeText(item.querySelector('.jm-bullet-after').textContent).then(() => {
          const cb = item.querySelector('.jm-bullet-copy');
          cb.textContent = 'Copied!';
          setTimeout(() => { cb.textContent = 'Copy'; }, 1500);
        }).catch(() => {});
      });
      item.querySelector('.jm-bullet-refresh').addEventListener('click', async (e) => {
        const refreshBtn = e.currentTarget;
        refreshBtn.disabled = true;
        refreshBtn.classList.add('jm-spinning');
        try {
          const bulletSkills = [];
          item.querySelectorAll('.jm-skill-chip:not(.jm-excluded-skill)').forEach(chip => {
            bulletSkills.push(chip.dataset.skill);
          });
          const newBullet = await sendMessage({
            type: 'GENERATE_CUSTOM_BULLET',
            description,
            targetRole: targetLabel,
            jobDescription: extractJobDescription(),
            missingSkills: bulletSkills
          });
          item.querySelector('.jm-bullet-after').textContent = newBullet;
        } catch (err) {
          item.querySelector('.jm-bullet-after').textContent = 'Error: ' + err.message;
        } finally {
          refreshBtn.disabled = false;
          refreshBtn.classList.remove('jm-spinning');
        }
      });

      list.appendChild(item);

      // Reset the form
      input.value = '';
      shadowRoot.getElementById('jmAddBulletForm').classList.remove('jm-open');
      shadowRoot.getElementById('jmAddBulletArea').classList.remove('jm-open');
      shadowRoot.getElementById('jmAddBulletTrigger').style.display = '';
    } catch (err) {
      input.value += '\n\nError: ' + err.message;
    } finally {
      genBtn.disabled = false;
      genBtn.textContent = 'Generate';
    }
  }

  // ─── Job notes ────────────────────────────────────────────────
  // Per-URL free-text notes stored in chrome.storage.local under 'jm_jobNotes'.
  // Notes are loaded when the panel opens and auto-saved on input/blur.

  const NOTES_STORAGE_KEY = 'jm_jobNotes'; // Key for the notes map in chrome.storage.local

  /**
   * Loads saved notes for the current page URL and populates the notes textarea.
   * @async
   */
  async function loadJobNotes() {
    try {
      const url = window.location.href;
      const result = await chrome.storage.local.get(NOTES_STORAGE_KEY);
      const notes = result[NOTES_STORAGE_KEY] || {};
      const textarea = shadowRoot && shadowRoot.getElementById('jmNotesInput');
      if (textarea) textarea.value = notes[url] || '';
    } catch (e) { /* ignore */ }
  }

  /**
   * Saves the current notes textarea value for the current page URL.
   * Called on textarea blur and input events (auto-save).
   * Caps the notes map at 200 entries by evicting the oldest.
   * @async
   */
  async function saveJobNotes() {
    try {
      const url = window.location.href;
      const textarea = shadowRoot && shadowRoot.getElementById('jmNotesInput');
      if (!textarea) return;
      const result = await chrome.storage.local.get(NOTES_STORAGE_KEY);
      const notes = result[NOTES_STORAGE_KEY] || {};
      const val = textarea.value.trim();
      if (val) {
        notes[url] = val;
      } else {
        delete notes[url];
      }
      // Prune to 200 entries
      const keys = Object.keys(notes);
      if (keys.length > 200) keys.slice(0, keys.length - 200).forEach(k => delete notes[k]);
      await chrome.storage.local.set({ [NOTES_STORAGE_KEY]: notes });
    } catch (e) { /* ignore */ }
  }

  // ─── Message handling ─────────────────────────────────────────

  /**
   * Sends a message to the background service worker and returns a Promise.
   * Wraps chrome.runtime.sendMessage to:
   *  - Check chrome.runtime.id before sending (detects invalidated extension context)
   *  - Translate the { success, data/error } envelope into resolve/reject
   *  - Provide a user-friendly error when the extension has been updated mid-session
   * @param {Object} msg - The message object to send (must have a `type` field).
   * @returns {Promise<*>} Resolves with resp.data on success, rejects with Error on failure.
   */
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

  /**
   * Escapes a string for safe insertion into HTML via innerHTML.
   * Uses the browser's own text node serialisation so all special characters
   * (&, <, >, ", ') are correctly escaped without a manual replacement table.
   * @param {string} str - The raw string to escape.
   * @returns {string} HTML-safe string.
   */
  function escapeHTML(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ─── Initialize ───────────────────────────────────────────────
  // Build the panel and toggle button immediately on script inject.
  // The panel starts hidden (no .open class); it is shown on first togglePanel() call.

  createPanel();
  createToggleButton();

  // ─── SPA URL change detection (LinkedIn, Indeed, etc.) ────────
  // LinkedIn and Indeed navigate between job listings without a full page reload.
  // A MutationObserver on document.body catches the DOM mutations that accompany
  // these history.pushState navigations, allowing us to reset the panel state
  // and inform the user that a new job has been detected.

  let _lastUrl = window.location.href; // Track the last seen URL to detect changes
  new MutationObserver(() => {
    const currentUrl = window.location.href;
    if (currentUrl === _lastUrl) return;
    _lastUrl = currentUrl;
    currentAnalysis = null;
    _pendingAnswers = null;
    clearAllChips();        // Remove any floating chips from the previous job page
    clearAutofillBadges();  // Remove autofill badges from the previous job page
    if (shadowRoot && panelOpen) {
      const analyzeBtn = shadowRoot.getElementById('jmAnalyze');
      if (analyzeBtn && analyzeBtn.textContent === 'Re-Analyze') analyzeBtn.textContent = 'Analyze Job';
      const autofillBtn = shadowRoot.getElementById('jmAutofill');
      if (autofillBtn) { autofillBtn.innerHTML = 'AutoFill Application'; autofillBtn.onclick = null; }
      [
        'jmScoreSection', 'jmMatchingSection', 'jmMissingSection', 'jmRecsSection',
        'jmInsightsSection', 'jmKeywordsSection', 'jmTruncNotice', 'jmResumeTruncNotice',
        'jmAutofillPreview', 'jmCoverLetterSection', 'jmBulletSection',
        'jmJobInfo', 'jmSaveJob', 'jmMarkApplied', 'jmCoverLetterBtn', 'jmRewriteBulletsBtn'
      ].forEach(id => {
        const el = shadowRoot.getElementById(id);
        if (el) el.style.display = 'none';
      });
      loadJobNotes();
      loadSlotState();
      setStatus('New job detected — click Analyze Job.', 'info');
      setTimeout(clearStatus, 3000);
    }
  }).observe(document.body, { childList: true, subtree: true });
  checkIfApplied();

})();
