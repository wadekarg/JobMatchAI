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

    // Direct profile field mapping (highest priority)
    const profileMap = {
      'first name': profile?.name?.split(/\s+/)[0] || '',
      'last name': profile?.name?.split(/\s+/).slice(1).join(' ') || '',
      'full name': profile?.name || '',
      'name': profile?.name || '',
      'email': profile?.email || '',
      'email address': profile?.email || '',
      'phone': profile?.phone || '',
      'phone number': profile?.phone || '',
      'linkedin': profile?.linkedin || '',
      'linkedin profile': profile?.linkedin || '',
      'linkedin url': profile?.linkedin || '',
      'linkedin profile url': profile?.linkedin || '',
      'github': profile?.github || '',
      'github profile url': profile?.github || '',
      'github url': profile?.github || '',
      'website': profile?.website || '',
      'portfolio': profile?.website || '',
      'personal website': profile?.website || '',
      'portfolio / personal website url': profile?.website || '',
      'city': (profile?.location || '').split(',')[0]?.trim() || '',
      'location': profile?.location || '',
      'summary': profile?.summary || '',
      'professional summary': profile?.summary || '',
    };

    // Check exact profile match
    for (const [key, value] of Object.entries(profileMap)) {
      if (value && (l === key || l.includes(key) || key.includes(l))) {
        return value;
      }
    }

    // Check Q&A list
    if (!qaList || qaList.length === 0) return null;

    // Exact question match
    const exact = qaList.find(qa => qa.answer && qa.question.toLowerCase().trim() === l);
    if (exact) return exact.answer;

    // Q&A question contains label
    const contains = qaList.find(qa => qa.answer && qa.question.toLowerCase().includes(l));
    if (contains) return contains.answer;

    // Label contains Q&A question
    const contained = qaList.find(qa => {
      if (!qa.answer) return false;
      const q = qa.question.toLowerCase().trim();
      return q.length > 4 && l.includes(q);
    });
    if (contained) return contained.answer;

    // Keyword overlap (for longer labels)
    const words = l.split(/[\s,/]+/).filter(w => w.length > 3);
    if (words.length > 0) {
      const kwMatch = qaList.find(qa => {
        if (!qa.answer) return false;
        const qWords = qa.question.toLowerCase().split(/[\s,/]+/);
        const overlap = words.filter(w => qWords.some(qw => qw.includes(w) || w.includes(qw)));
        return overlap.length >= Math.min(2, words.length);
      });
      if (kwMatch) return kwMatch.answer;
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
    const unfilled = [];

    console.log(`[JobMatch AI] Direct fill: scanning page with ${qaList?.length || 0} Q&A entries`);

    // ── 1. Native inputs and textareas ──
    const inputs = document.querySelectorAll(
      'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="file"]):not([type="checkbox"]):not([type="radio"]), textarea'
    );

    for (const input of inputs) {
      if (input.offsetParent === null) continue; // hidden
      if (input.value && input.value.trim().length > 0) continue; // already has value

      const label = getElementLabel(input);
      if (!label) continue;

      const answer = matchQA(label, qaList, profile);
      if (answer) {
        console.log(`[JobMatch AI] Direct fill: "${label}" → "${answer.substring(0, 50)}"`);
        setNativeInputValue(input, answer);
        filledIds.add(input.id || input.name);
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
          console.log(`[JobMatch AI] Direct fill <select>: "${label}" → "${best}"`);
          sel.value = opt.value;
          fireEvents(sel);
          filledIds.add(sel.id || sel.name);
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
          console.log(`[JobMatch AI] Direct fill radio: "${label}" → "${best}"`);
          radio.el.checked = true;
          fireEvents(radio.el);
          filled++;
        }
      }
    }

    // ── 4. Checkboxes ──
    document.querySelectorAll('input[type="checkbox"]').forEach(cb => {
      const label = getElementLabel(cb);
      if (!label) return;

      const answer = matchQA(label, qaList, profile);
      if (!answer) return;

      const shouldCheck = /^(yes|true|1|checked|agree|accept|i am|i do|i have)/i.test(answer);
      if (cb.checked !== shouldCheck) {
        console.log(`[JobMatch AI] Direct fill checkbox: "${label}" → ${shouldCheck}`);
        cb.checked = shouldCheck;
        fireEvents(cb);
        filled++;
      }
    });

    // ── 5. React Select dropdowns ──
    const reactSelects = document.querySelectorAll(
      '[class*="single-value"], [class*="singleValue"], [class*="Select-value-label"]'
    );

    for (const display of reactSelects) {
      const currentText = display.textContent?.trim() || '';

      // Find the label
      let label = '';
      let el = display;
      for (let i = 0; i < 8 && el; i++) {
        el = el.parentElement;
        if (!el) break;
        const labelEl = el.querySelector('label');
        if (labelEl && !labelEl.contains(display)) {
          label = cleanLabel(labelEl.textContent);
          break;
        }
      }
      if (!label) continue;

      const answer = matchQA(label, qaList, profile);
      if (!answer) continue;

      // Check if already correct
      if (currentText.toLowerCase() === answer.toLowerCase()) continue;
      if (currentText.toLowerCase().includes(answer.toLowerCase())) continue;

      // Find container and fill
      const container = display.closest('[class*="css-"]')?.parentElement
        || display.closest('[class*="select"], [class*="Select"]');
      if (container) {
        console.log(`[JobMatch AI] Direct fill React Select: "${label}" → "${answer}" (was "${currentText}")`);
        const success = await fillReactSelect(container, answer);
        if (success) filled++;
      }
    }

    console.log(`[JobMatch AI] Direct fill complete: ${filled} fields filled`);
    return { filled, filledIds };
  }

  // Export for use by content.js
  window.__jobMatchDirectFill = directFillFromQA;
})();
