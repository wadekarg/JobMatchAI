/**
 * Direct Q&A Fill — fills form fields by matching labels to Q&A answers.
 * No AI needed. Runs as Pass 1 before the AI autofill.
 *
 * Strategy:
 * 1. Scan ALL interactive elements (inputs, selects, textareas, React Selects)
 * 2. For each, extract its label using multiple strategies
 * 3. Match label to Q&A or profile data
 * 4. Fill directly with proper event simulation
 */

(function () {
  'use strict';

  // Logs leak Q&A answer content (gender/race/salary/etc) into the page's
  // DevTools console — never enable in shipped builds.
  const DEBUG = false;
  const dbg = (...args) => { if (DEBUG) console.log('[JobMatch AI]', ...args); };

  // ─── Label extraction (tries multiple strategies) ───────────────

  function getElementLabel(el) {
    // 1. <label for="id">
    if (el.id) {
      const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (label) return cleanLabel(label.textContent);
    }

    // 2. Wrapping <label>
    const parentLabel = el.closest('label');
    if (parentLabel) return cleanLabel(parentLabel.textContent);

    // 3. aria-label
    if (el.getAttribute('aria-label')) return cleanLabel(el.getAttribute('aria-label'));

    // 4. aria-labelledby
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const labelEl = document.getElementById(labelledBy);
      if (labelEl) return cleanLabel(labelEl.textContent);
    }

    // 5. placeholder
    if (el.placeholder) return cleanLabel(el.placeholder);

    // 6. Previous sibling label or nearby label
    const container = el.closest('.field, .form-group, .form-field, [class*="field"], [class*="form-group"]');
    if (container) {
      const label = container.querySelector('label, [class*="label"], [class*="Label"]');
      if (label && !label.contains(el)) return cleanLabel(label.textContent);
    }

    // 7. Previous sibling text
    let prev = el.previousElementSibling;
    if (prev && prev.tagName === 'LABEL') return cleanLabel(prev.textContent);

    // 8. Walk up DOM looking for label
    let parent = el.parentElement;
    for (let i = 0; i < 5 && parent; i++) {
      const label = parent.querySelector('label');
      if (label && !label.contains(el)) return cleanLabel(label.textContent);
      parent = parent.parentElement;
    }

    // 9. name attribute as fallback
    if (el.name) return cleanLabel(el.name.replace(/_/g, ' ').replace(/\[.*\]/, ''));

    return '';
  }

  function cleanLabel(text) {
    return (text || '').replace(/\*/g, '').replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
  }

  // ─── Event simulation ──────────────────────────────────────────

  function fireEvents(el) {
    el.dispatchEvent(new Event('focus', { bubbles: true }));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
  }

  function setNativeInputValue(el, value) {
    // React overrides the value setter, so we need to use the native one
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, 'value'
    )?.set || Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype, 'value'
    )?.set;

    if (nativeInputValueSetter) {
      nativeInputValueSetter.call(el, value);
    } else {
      el.value = value;
    }
    fireEvents(el);
  }

  // ─── Q&A matching ─────────────────────────────────────────────

  function matchQA(label, qaList, profile) {
    if (!label) return null;
    const l = label.toLowerCase().trim();

    // ── Profile field mapping (only for very specific short labels) ──
    const profileMap = {
      'first name': profile?.name?.split(/\s+/)[0] || '',
      'preferred first name': profile?.name?.split(/\s+/)[0] || '',
      'last name': profile?.name?.split(/\s+/).slice(1).join(' ') || '',
      'full name': profile?.name || '',
      'email': profile?.email || '',
      'email address': profile?.email || '',
      'phone': profile?.phone || '',
      'phone number': profile?.phone || '',
      'linkedin profile url': profile?.linkedin || '',
      'github profile url': profile?.github || '',
      'portfolio / personal website url': profile?.website || '',
      'location (city)': (profile?.location || '').split(',')[0]?.trim() || '',
      'city': (profile?.location || '').split(',')[0]?.trim() || '',
    };

    // Profile match: ONLY exact label match (no fuzzy)
    if (profileMap[l] !== undefined && profileMap[l]) {
      return profileMap[l];
    }

    // ── Q&A matching (strict) ──
    if (!qaList || qaList.length === 0) return null;

    // 1. Exact question match
    const exact = qaList.find(qa => qa.answer && qa.question.toLowerCase().trim() === l);
    if (exact) return exact.answer;

    // 2. Very high similarity: label and Q&A question are nearly identical
    //    Both must be short (< 50 chars) and one must contain the other fully
    const highSim = qaList.find(qa => {
      if (!qa.answer) return false;
      const q = qa.question.toLowerCase().trim();
      // Both short and one contains the other
      if (q.length < 50 && l.length < 50) {
        if (q === l) return true;
        // Q contains label but label must be substantial (>= 6 chars)
        if (l.length >= 6 && q.includes(l)) return true;
        // Label contains Q but Q must be substantial
        if (q.length >= 6 && l.includes(q)) return true;
      }
      return false;
    });
    if (highSim) return highSim.answer;

    // 3. For LONG labels (questions), check if the core meaning matches
    //    Only match if the label is clearly about the same topic
    //    Skip this for short generic labels to avoid false matches
    if (l.length > 20) {
      // Extract the key noun phrases, ignoring common words
      const stopWords = new Set(['the', 'a', 'an', 'is', 'are', 'do', 'does', 'did', 'you',
        'your', 'have', 'has', 'will', 'would', 'in', 'on', 'at', 'to', 'for', 'of', 'or',
        'and', 'from', 'with', 'by', 'this', 'that', 'what', 'how', 'which', 'who', 'where',
        'when', 'please', 'select', 'enter', 'provide', 'currently', 'now', 'not', 'been',
        'being', 'most', 'any', 'if', 'can', 'may', 'need', 'order', 'job', 'posted']);

      const labelWords = l.split(/[\s,?/()]+/).filter(w => w.length > 2 && !stopWords.has(w));
      if (labelWords.length >= 2) {
        const match = qaList.find(qa => {
          if (!qa.answer) return false;
          const qWords = qa.question.toLowerCase().split(/[\s,?/()]+/).filter(w => w.length > 2 && !stopWords.has(w));
          // Require at least 50% of Q&A keywords present in label
          const overlap = qWords.filter(qw => labelWords.some(lw => lw === qw || (lw.length > 4 && qw.includes(lw)) || (qw.length > 4 && lw.includes(qw))));
          return qWords.length > 0 && overlap.length >= Math.ceil(qWords.length * 0.5) && overlap.length >= 2;
        });
        if (match) return match.answer;
      }
    }

    return null;
  }

  // ─── Option matching for dropdowns ────────────────────────────

  function findBestOption(options, answer) {
    const a = answer.toLowerCase().trim();
    // Exact match
    const exact = options.find(o => o.toLowerCase().trim() === a);
    if (exact) return exact;
    // Option contains answer
    const contains = options.find(o => o.toLowerCase().includes(a));
    if (contains) return contains;
    // Answer contains option
    const contained = options.find(o => a.includes(o.toLowerCase().trim()) && o.trim().length > 2);
    if (contained) return contained;
    // Common swaps
    const swaps = { 'male': ['man'], 'man': ['male'], 'female': ['woman'], 'woman': ['female'],
      'yes': ['i am', 'authorized', 'i do', 'i have'], 'no': ['i am not', 'i do not'] };
    const alts = swaps[a] || [];
    for (const alt of alts) {
      const sw = options.find(o => o.toLowerCase().includes(alt));
      if (sw) return sw;
    }
    return null;
  }

  // ─── React Select handler ────────────────────────────────────

  async function fillReactSelect(container, answer) {
    // Find the control element to click
    const control = container.querySelector('[class*="control"], [class*="Control"]')
      || container.querySelector('[class*="css-"][class*="-"]');
    if (!control) return false;

    // Click to open
    control.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    control.click();

    // Wait for options
    await new Promise(r => setTimeout(r, 400));

    // Find options
    const options = document.querySelectorAll('[role="option"]');
    const optTexts = Array.from(options).map(o => o.textContent.trim());
    const best = findBestOption(optTexts, answer);

    if (best) {
      const optEl = Array.from(options).find(o => o.textContent.trim() === best);
      if (optEl) {
        optEl.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        optEl.click();
        await new Promise(r => setTimeout(r, 200));
        return true;
      }
    }

    // Close if no match
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    return false;
  }

  // ─── Main: Direct fill all fields ─────────────────────────────

  /**
   * Scans the page and fills all matching fields directly from Q&A and profile.
   * Returns { filled, unfilled } where unfilled is a list of field labels that
   * couldn't be matched (these get sent to AI in Pass 2).
   */
  async function directFillFromQA(qaList, profile) {
    let filled = 0;
    const filledIds = new Set();
    const filledLabels = new Set();
    const unfilled = [];

    // Store filled labels globally so Pass 2 can skip them
    window.__jobMatchFilledLabels = filledLabels;

    dbg(`Direct fill: scanning page with ${qaList?.length || 0} Q&A entries`);

    // ── 1. Native inputs and textareas ──
    const inputs = document.querySelectorAll(
      'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="file"]):not([type="checkbox"]):not([type="radio"]), textarea'
    );

    for (const input of inputs) {
      if (input.offsetParent === null) continue; // hidden
      if (input.value && input.value.trim().length > 0) continue; // already has value
      // Skip inputs that are part of React Select (combobox search inputs)
      if (input.getAttribute('role') === 'combobox') continue;
      if (input.getAttribute('aria-autocomplete')) continue;
      // Skip hidden inputs inside React Select containers
      if (input.closest('[class*="css-"][class*="-container"]') || input.closest('[class*="select__"]')) continue;
      if (input.type === 'hidden') continue;

      const label = getElementLabel(input);
      if (!label) continue;

      const answer = matchQA(label, qaList, profile);
      if (answer) {
        // Sanity check: don't put long answers in short text inputs
        if (input.type !== 'textarea' && input.tagName !== 'TEXTAREA' && answer.length > 200) continue;
        dbg(`Direct fill: "${label}" (${answer.length} chars)`);
        setNativeInputValue(input, answer);
        filledIds.add(input.id || input.name);
        filledLabels.add(label);
        filled++;
      }
    }

    // ── 2. Native <select> elements ──
    const selects = document.querySelectorAll('select');
    for (const sel of selects) {
      const label = getElementLabel(sel);
      if (!label) continue;

      const answer = matchQA(label, qaList, profile);
      if (!answer) continue;

      const optTexts = Array.from(sel.options).map(o => o.text.trim());
      const best = findBestOption(optTexts, answer);
      if (best) {
        const opt = Array.from(sel.options).find(o => o.text.trim() === best);
        if (opt) {
          dbg(`Direct fill <select>: "${label}" matched`);
          sel.value = opt.value;
          fireEvents(sel);
          filledIds.add(sel.id || sel.name);
          filledLabels.add(label);
          filled++;
        }
      }
    }

    // ── 3. Radio buttons ──
    const radioGroups = {};
    document.querySelectorAll('input[type="radio"]').forEach(r => {
      const name = r.name;
      if (!name) return;
      if (!radioGroups[name]) radioGroups[name] = [];
      radioGroups[name].push(r);
    });

    for (const [name, radios] of Object.entries(radioGroups)) {
      const label = getElementLabel(radios[0]) || name.replace(/_/g, ' ');
      const answer = matchQA(label, qaList, profile);
      if (!answer) continue;

      const radioLabels = radios.map(r => ({
        el: r,
        text: (r.labels?.[0]?.textContent || r.value || '').trim()
      }));
      const best = findBestOption(radioLabels.map(r => r.text), answer);
      if (best) {
        const radio = radioLabels.find(r => r.text === best);
        if (radio) {
          dbg(`Direct fill radio: "${label}" matched`);
          radio.el.checked = true;
          fireEvents(radio.el);
          filledLabels.add(label);
          filled++;
        }
      }
    }

    // ── 4. Checkboxes (only for Yes/No type questions, not multi-select) ──
    // Skip checkboxes that look like multi-select options (city names, skills, etc.)
    document.querySelectorAll('input[type="checkbox"]').forEach(cb => {
      const label = getElementLabel(cb);
      if (!label) return;

      // Skip multi-select checkboxes (city names, office locations, skills)
      // Only fill checkboxes that are clearly Yes/No questions
      const answer = matchQA(label, qaList, profile);
      if (!answer) return;

      // Only fill if the Q&A answer is clearly a yes/no type
      const isYesNo = /^(yes|no|true|false|i am|i do|i have|i don't|i am not)/i.test(answer);
      if (!isYesNo) return;

      const shouldCheck = /^(yes|true|1|checked|agree|accept|i am|i do|i have)/i.test(answer);
      if (cb.checked !== shouldCheck) {
        dbg(`Direct fill checkbox: "${label}" matched`);
        cb.checked = shouldCheck;
        fireEvents(cb);
        filledLabels.add(label);
        filled++;
      }
    });

    // ── 5. React Select dropdowns ──
    // Find all React Select containers by looking for the input[role="combobox"] inside them
    const reactInputs = document.querySelectorAll('input[role="combobox"]');
    const processedContainers = new Set();
    dbg(`Direct fill: found ${reactInputs.length} React Select inputs`);

    for (const input of reactInputs) {
      // Walk up to find the React Select container
      let container = input.closest('[class*="css-"]');
      // Go up a few levels to find the full container with the label
      let fieldWrapper = container;
      for (let i = 0; i < 6 && fieldWrapper; i++) {
        fieldWrapper = fieldWrapper.parentElement;
        if (!fieldWrapper) break;
        if (fieldWrapper.querySelector('label')) break;
      }

      if (!fieldWrapper || processedContainers.has(fieldWrapper)) continue;
      processedContainers.add(fieldWrapper);

      // Find label
      const labelEl = fieldWrapper.querySelector('label');
      const label = labelEl ? cleanLabel(labelEl.textContent) : '';
      if (!label) continue;

      // Get current selected value
      const singleValue = fieldWrapper.querySelector('[class*="single-value"], [class*="singleValue"]');
      const currentText = singleValue?.textContent?.trim() || '';

      const answer = matchQA(label, qaList, profile);
      if (!answer) continue;

      // Check if already correct
      if (currentText && currentText.toLowerCase() === answer.toLowerCase()) continue;

      // Find the inner React Select container for clicking
      const selectContainer = input.closest('[class*="css-"]')?.parentElement
        || input.closest('[class*="select"], [class*="Select"]');
      if (!selectContainer) continue;

      dbg(`Direct fill React Select: "${label}" matched (${answer.length} chars)`);
      const success = await fillReactSelect(selectContainer, answer);
      if (success) {
        filledLabels.add(label);
        filled++;
      }
    }

    dbg(`Direct fill complete: ${filled} fields filled`);
    return { filled, filledIds };
  }

  // Export for use by content.js
  window.__jobMatchDirectFill = directFillFromQA;
})();
