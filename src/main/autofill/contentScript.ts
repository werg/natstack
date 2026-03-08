/**
 * Content script for autofill — injected via executeJavaScriptInIsolatedWorld.
 *
 * Runs in isolated world (AUTOFILL_WORLD_ID = 1000) with pristine DOM APIs.
 * Page JS cannot observe, override, or interact with this code.
 *
 * Responsibilities:
 * - Detect password/username fields via MutationObserver
 * - Track field focus state and rects
 * - Inject key icon via closed shadow root
 * - Snapshot credentials on form submission
 * - Watch for field removal/hiding (SPA signal)
 * - Notify main process via ping() (argless, zero-data)
 */

export function getContentScript(): string {
  return `(function() {
  'use strict';

  // Idempotency guard — prevent stacking on SPA re-injection
  if (window.__natstack_af_initialized) return;
  window.__natstack_af_initialized = true;

  // State exposed to main process (pulled via executeJavaScriptInIsolatedWorld)
  window.__natstack_af_fields = null;       // detected form info
  window.__natstack_af_focus = null;        // focused field info + rect
  window.__natstack_af_pending = null;      // snapshot of credentials on submit
  window.__natstack_af_fields_removed = false;
  window.__natstack_af_username_snapshot = null; // carried forward for multi-step login

  var ping = window.__natstack_autofill ? window.__natstack_autofill.ping : function() {};

  // Relay pings from iframes (they use postMessage since they lack the preload bridge)
  window.addEventListener('message', function(e) {
    if (e.data && e.data.type === '__natstack_af_iframe_ping') {
      ping();
    }
  });

  // =========================================================================
  // Field Detection
  // =========================================================================

  var trackedForms = new WeakSet();
  var iconHosts = new WeakMap();

  function findUsernameField(passwordEl) {
    // Walk backwards through inputs to find the username field
    var form = passwordEl.closest('form');
    var scope = form || passwordEl.parentElement;
    if (!scope) return null;

    var inputs = scope.querySelectorAll('input');
    var candidates = [];

    for (var i = 0; i < inputs.length; i++) {
      var inp = inputs[i];
      if (inp === passwordEl) break; // only look at inputs before the password field
      var type = (inp.type || 'text').toLowerCase();
      if (type === 'hidden' || type === 'submit' || type === 'button' || type === 'checkbox' || type === 'radio') continue;

      var name = (inp.name || '').toLowerCase();
      var ac = (inp.autocomplete || '').toLowerCase();
      var id = (inp.id || '').toLowerCase();
      var placeholder = (inp.placeholder || '').toLowerCase();

      if (type === 'email' || ac === 'username' || ac === 'email' ||
          /user|login|email|account/i.test(name) || /user|login|email|account/i.test(id) ||
          /user|login|email|account/i.test(placeholder) || type === 'text') {
        candidates.push(inp);
      }
    }

    // Prefer email type, then autocomplete=username, then last text-like input
    for (var j = 0; j < candidates.length; j++) {
      if (candidates[j].type === 'email') return candidates[j];
    }
    for (var k = 0; k < candidates.length; k++) {
      if ((candidates[k].autocomplete || '').toLowerCase() === 'username') return candidates[k];
    }
    return candidates.length > 0 ? candidates[candidates.length - 1] : null;
  }

  function getFieldRect(el) {
    var rect = el.getBoundingClientRect();
    return {
      x: Math.round(rect.left + window.scrollX),
      y: Math.round(rect.top + window.scrollY),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      viewportX: Math.round(rect.left),
      viewportY: Math.round(rect.top),
    };
  }

  function buildSelector(el) {
    if (el.id) return '#' + CSS.escape(el.id);
    if (el.name) return el.tagName.toLowerCase() + '[name="' + CSS.escape(el.name) + '"]';
    // Fallback: nth-of-type
    var parent = el.parentElement;
    if (!parent) return el.tagName.toLowerCase();
    var siblings = parent.querySelectorAll(':scope > ' + el.tagName.toLowerCase());
    for (var i = 0; i < siblings.length; i++) {
      if (siblings[i] === el) {
        return el.tagName.toLowerCase() + ':nth-of-type(' + (i + 1) + ')';
      }
    }
    return el.tagName.toLowerCase();
  }

  // =========================================================================
  // Key Icon (Closed Shadow DOM)
  // =========================================================================

  function injectKeyIcon(targetField) {
    if (iconHosts.has(targetField)) return;

    var host = document.createElement('div');
    host.style.cssText = 'position:absolute;z-index:2147483647;pointer-events:auto;width:20px;height:20px;';
    var shadow = host.attachShadow({ mode: 'closed' });
    shadow.innerHTML = '<style>:host{color:#555}@media(prefers-color-scheme:dark){:host{color:#aaa}}</style>' +
      '<div style="width:20px;height:20px;cursor:pointer;display:flex;align-items:center;justify-content:center;opacity:0.6;transition:opacity 0.15s" onmouseenter="this.style.opacity=1" onmouseleave="this.style.opacity=0.6">' +
      '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">' +
      '<path d="M8 1C6.067 1 4.5 2.567 4.5 4.5V6H4a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V7a1 1 0 0 0-1-1h-.5V4.5C11.5 2.567 9.933 1 8 1zM6 4.5C6 3.395 6.895 2.5 8 2.5s2 .895 2 2v1.5H6V4.5zm2 5.5a1 1 0 1 1 0-2 1 1 0 0 1 0 2z" fill="currentColor"/>' +
      '</svg></div>';

    // Position at right edge of field
    var offsetParent = targetField.offsetParent || document.body;
    if (getComputedStyle(offsetParent).position === 'static') {
      offsetParent.style.position = 'relative';
    }

    function positionIcon() {
      var rect = targetField.getBoundingClientRect();
      var parentRect = offsetParent.getBoundingClientRect();
      host.style.left = (rect.right - parentRect.left - 24) + 'px';
      host.style.top = (rect.top - parentRect.top + (rect.height - 20) / 2) + 'px';
    }

    positionIcon();
    offsetParent.appendChild(host);
    iconHosts.set(targetField, host);

    // Click icon -> ping to show dropdown
    shadow.firstElementChild.addEventListener('click', function() {
      targetField.focus();
      ping();
    });

    // Reposition on scroll/resize
    var repositionTimer = null;
    function debouncedReposition() {
      if (repositionTimer) return;
      repositionTimer = setTimeout(function() {
        repositionTimer = null;
        if (document.contains(targetField)) positionIcon();
      }, 100);
    }
    window.addEventListener('scroll', debouncedReposition, true);
    window.addEventListener('resize', debouncedReposition);
  }

  // =========================================================================
  // Focus Tracking
  // =========================================================================

  function setupFocusTracking(usernameEl, passwordEl) {
    function onFocus(evt) {
      var el = evt.target;
      if (el !== usernameEl && el !== passwordEl) return;
      window.__natstack_af_focus = {
        fieldType: el === passwordEl ? 'password' : 'username',
        rect: getFieldRect(el),
        element: el,
      };
      ping();
    }

    function onBlur() {
      // Delay clearing focus to allow overlay click to register
      setTimeout(function() {
        if (document.activeElement !== usernameEl && document.activeElement !== passwordEl) {
          window.__natstack_af_focus = null;
          ping(); // notify main to dismiss overlay
        }
      }, 200);
    }

    if (usernameEl) {
      usernameEl.addEventListener('focus', onFocus, true);
      usernameEl.addEventListener('blur', onBlur, true);
    }
    passwordEl.addEventListener('focus', onFocus, true);
    passwordEl.addEventListener('blur', onBlur, true);
  }

  // =========================================================================
  // Credential Snapshot on Submit
  // =========================================================================

  function setupSnapshotListeners(usernameEl, passwordEl, formEl) {
    var nativeGetter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype, 'value'
    ).get;

    function snapshotCredentials() {
      // Only snapshot POST forms
      if (formEl && formEl.method && formEl.method.toLowerCase() === 'get') return;

      var password = nativeGetter.call(passwordEl);
      if (!password) return; // No password entered

      var username = usernameEl ? nativeGetter.call(usernameEl) : (window.__natstack_af_username_snapshot || '');

      window.__natstack_af_pending = {
        username: username,
        password: password,
        timestamp: Date.now(),
        pageUrl: location.href,
        actionUrl: formEl ? formEl.action : null,
      };

      startFieldRemovalWatch(passwordEl);
      ping();
    }

    // 1. Form submit event
    if (formEl) {
      formEl.addEventListener('submit', snapshotCredentials, true);
    }

    // 2. Click on submit buttons
    var scope = formEl || (passwordEl.parentElement ? passwordEl.closest('div,section,main,body') : document.body);
    if (scope) {
      var submitButtons = scope.querySelectorAll('button, input[type="submit"], [role="button"]');
      for (var i = 0; i < submitButtons.length; i++) {
        submitButtons[i].addEventListener('click', snapshotCredentials, true);
      }
    }

    // 3. Enter key on password field
    passwordEl.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') snapshotCredentials();
    }, true);
  }

  // =========================================================================
  // Username Snapshot (Multi-step Login)
  // =========================================================================

  function setupUsernameSnapshot(usernameEl) {
    var nativeGetter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype, 'value'
    ).get;

    function snapshot() {
      var val = nativeGetter.call(usernameEl);
      if (val) window.__natstack_af_username_snapshot = val;
    }

    // Snapshot on form submit or Enter
    var form = usernameEl.closest('form');
    if (form) {
      form.addEventListener('submit', snapshot, true);
    }
    usernameEl.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') snapshot();
    }, true);
  }

  // =========================================================================
  // Field Removal/Hide Detection (SPA Signal)
  // =========================================================================

  function startFieldRemovalWatch(passwordEl) {
    var observer = new MutationObserver(function() {
      if (!document.contains(passwordEl)) {
        window.__natstack_af_fields_removed = true;
        ping();
        observer.disconnect();
        clearInterval(visibilityPoll);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });

    var visibilityPoll = setInterval(function() {
      if (!document.contains(passwordEl) ||
          passwordEl.offsetWidth === 0 ||
          getComputedStyle(passwordEl).visibility === 'hidden') {
        window.__natstack_af_fields_removed = true;
        ping();
        observer.disconnect();
        clearInterval(visibilityPoll);
      }
    }, 500);

    // Stop watching after 30 seconds (snapshot expiry)
    setTimeout(function() {
      observer.disconnect();
      clearInterval(visibilityPoll);
      window.__natstack_af_pending = null;
      window.__natstack_af_fields_removed = false;
    }, 30000);
  }

  // =========================================================================
  // Main Scan
  // =========================================================================

  function scanForFields() {
    var passwordFields = document.querySelectorAll('input[type="password"]');
    if (passwordFields.length === 0) {
      // Check for username-only forms (multi-step login)
      var emailInputs = document.querySelectorAll('input[type="email"], input[autocomplete="username"]');
      for (var e = 0; e < emailInputs.length; e++) {
        var emailEl = emailInputs[e];
        if (emailEl.offsetWidth === 0) continue;
        var emailForm = emailEl.closest('form');
        if (emailForm && !trackedForms.has(emailForm)) {
          trackedForms.add(emailForm);
          window.__natstack_af_fields = {
            type: 'username-only',
            usernameSelector: buildSelector(emailEl),
            usernameRect: getFieldRect(emailEl),
          };
          setupUsernameSnapshot(emailEl);
          setupFocusTracking(emailEl, emailEl);
          ping();
        }
      }
      return;
    }

    for (var i = 0; i < passwordFields.length; i++) {
      var passwordEl = passwordFields[i];
      if (passwordEl.offsetWidth === 0 && passwordEl.offsetHeight === 0) continue;
      var form = passwordEl.closest('form');
      var trackTarget = form || passwordEl;
      if (trackedForms.has(trackTarget)) continue;
      trackedForms.add(trackTarget);

      var usernameEl = findUsernameField(passwordEl);
      var formSelector = form ? buildSelector(form) : null;

      window.__natstack_af_fields = {
        type: 'login',
        usernameSelector: usernameEl ? buildSelector(usernameEl) : null,
        passwordSelector: buildSelector(passwordEl),
        formSelector: formSelector,
        actionUrl: form ? form.action : null,
        passwordRect: getFieldRect(passwordEl),
        usernameRect: usernameEl ? getFieldRect(usernameEl) : null,
      };

      setupFocusTracking(usernameEl, passwordEl);
      setupSnapshotListeners(usernameEl, passwordEl, form);
      ping();
    }
  }

  // Expose for main process to call via getInjectKeyIconScript
  window.__natstack_af_injectIcon = injectKeyIcon;

  // Scroll → clear focus (main will hide overlay)
  var scrollTimer = null;
  window.addEventListener('scroll', function() {
    if (window.__natstack_af_focus) {
      window.__natstack_af_focus = null;
      if (scrollTimer) clearTimeout(scrollTimer);
      scrollTimer = setTimeout(function() {
        scrollTimer = null;
        ping();
      }, 50);
    }
  }, true);

  // Initial scan
  scanForFields();

  // Watch for dynamically added fields
  var domObserver = new MutationObserver(function() {
    scanForFields();
  });
  domObserver.observe(document.body || document.documentElement, {
    childList: true, subtree: true,
  });
})()`;
}

/**
 * Script to pull field data from the isolated world.
 * Returns the current autofill state.
 */
export function getPullStateScript(): string {
  return `(function() {
  var focus = window.__natstack_af_focus;
  // Re-read rect from live element to avoid stale position after scroll
  if (focus && focus.element && document.contains(focus.element)) {
    var rect = focus.element.getBoundingClientRect();
    focus = {
      fieldType: focus.fieldType,
      rect: {
        x: Math.round(rect.left + window.scrollX),
        y: Math.round(rect.top + window.scrollY),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        viewportX: Math.round(rect.left),
        viewportY: Math.round(rect.top),
      },
    };
  }
  var fieldsRemoved = window.__natstack_af_fields_removed || false;
  window.__natstack_af_fields_removed = false; // consume — prevent stale re-reads
  return {
    fields: window.__natstack_af_fields || null,
    focus: focus || null,
    pending: window.__natstack_af_pending || null,
    fieldsRemoved: fieldsRemoved,
    usernameSnapshot: window.__natstack_af_username_snapshot || null,
  };
})()`;
}

/**
 * Script to read and clear the pending snapshot from the isolated world.
 */
export function getReadSnapshotScript(): string {
  return `(function() {
  var pending = window.__natstack_af_pending;
  window.__natstack_af_pending = null;
  window.__natstack_af_fields_removed = false;
  return pending;
})()`;
}

/**
 * Generate fill script for a credential.
 */
export function getFillScript(
  usernameSelector: string | null,
  passwordSelector: string,
  username: string,
  password: string,
): string {
  return `(function() {
  function fillField(el, val) {
    if (!el) return;
    if (el.offsetWidth === 0 || el.offsetHeight === 0) return;
    if (getComputedStyle(el).visibility === 'hidden') return;
    var nativeSetter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype, 'value'
    ).set;
    nativeSetter.call(el, val);
    el.dispatchEvent(new Event('input', {bubbles: true}));
    el.dispatchEvent(new Event('change', {bubbles: true}));
  }
  ${usernameSelector ? `fillField(document.querySelector(${JSON.stringify(usernameSelector)}), ${JSON.stringify(username)});` : ''}
  fillField(document.querySelector(${JSON.stringify(passwordSelector)}), ${JSON.stringify(password)});
})()`;
}

/**
 * Script to inject the key icon for a specific field.
 */
export function getInjectKeyIconScript(fieldSelector: string): string {
  return `(function() {
  var el = document.querySelector(${JSON.stringify(fieldSelector)});
  if (!el) return;
  // Re-use the icon injection from the content script
  if (typeof window.__natstack_af_injectIcon === 'function') {
    window.__natstack_af_injectIcon(el);
  }
})()`;
}

/**
 * Content script variant for iframes.
 * Identical logic but uses window.top.postMessage() instead of preload ping,
 * since the preload bridge is only available in the main frame.
 * Runs in the main world (not isolated) via WebFrameMain.executeJavaScript().
 */
export function getIframeContentScript(): string {
  // Take the main content script and replace the ping mechanism
  const mainScript = getContentScript();
  return mainScript
    // Replace the preload ping with postMessage to top
    .replace(
      "var ping = window.__natstack_autofill ? window.__natstack_autofill.ping : function() {};",
      "var ping = function() { try { window.top.postMessage({type: '__natstack_af_iframe_ping'}, '*'); } catch(e) {} };",
    )
    // Remove the iframe relay listener (not needed in iframes, prevents loops)
    .replace(
      /\/\/ Relay pings from iframes[\s\S]*?}\);/,
      "// (iframe mode — no relay needed)",
    );
}

/**
 * Quick scan script for detecting password fields in a frame.
 * Returns true if the frame has login-relevant fields.
 */
export function getFrameScanScript(): string {
  return `(function() {
  return document.querySelectorAll('input[type="password"]').length > 0 ||
    document.querySelectorAll('input[type="email"], input[autocomplete="username"]').length > 0;
})()`;
}

export const AUTOFILL_WORLD_ID = 1000;
