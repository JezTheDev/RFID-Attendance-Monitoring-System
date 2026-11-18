// Login page: sign in, forced password change, and forgot-password views.
// There is no sign-up: only the administrator creates accounts. Server calls go
// through window.RFIDLogin, which pages/login.js (an ES module) sets up.
(function () {
  'use strict';

  var card = document.getElementById('authCard');
  if (!card) return;

  var signInForm = document.getElementById('signInForm');
  var changeForm = document.getElementById('changeForm');

  function api() {
    if (!window.RFIDLogin) throw new Error('The page is still loading. Please try again.');
    if (!window.RFIDLogin.configured) throw new Error('The server address (API_URL) is not set in config.js yet.');
    return window.RFIDLogin;
  }

  function errorResult(error) {
    var message = (error && error.message) || 'Something went wrong. Please try again.';
    if (error && error.fields) {
      var first = Object.keys(error.fields)[0];
      if (first) message = error.fields[first];
    }
    return { tone: 'danger', icon: 'exclamation-triangle', message: message };
  }

  function showChangeForm() {
    signInForm.hidden = true;
    changeForm.hidden = false;
    var first = changeForm.querySelector('.auth-input');
    if (first && desktop.matches) first.focus({ preventScroll: true });
  }

  function goHome(session) {
    showSplash();
    setTimeout(function () { api().goHome(session); }, SPLASH_DELAY);
  }

  // Resolves to a notice to show, or to null when the page is moving on.
  function submitToServer(formId, values) {
    return Promise.resolve().then(function () {
      if (formId === 'signInForm') {
        return api().signIn(values.username, values.password).then(function (session) {
          if (session.must_change_password) {
            var old = changeForm.querySelector('[name="old_password"]');
            old.value = values.password;
            signInForm.reset();
            showChangeForm();
            return null;
          }
          goHome(session);
          return null;
        });
      }
      if (formId === 'changeForm') {
        if (values.new_password !== values.confirm_password) {
          return { tone: 'danger', icon: 'exclamation-triangle', message: 'The new passwords do not match.' };
        }
        return api().changePassword(values.old_password, values.new_password).then(function (session) {
          changeForm.reset();
          goHome(session);
          return null;
        });
      }
      return null;
    }).catch(errorResult);
  }

  var viewSignIn = card.querySelector('.auth-view--signin');
  var viewForgot = card.querySelector('.auth-view--forgot');
  var views = card.querySelector('.auth-views');
  var desktop = window.matchMedia('(min-width: 768px)');
  var TITLES = { signin: 'Sign in', forgot: 'Reset password' };

  function setHidden(el, hidden) {
    if (!el) return;
    if (hidden) {
      el.setAttribute('inert', '');
      el.setAttribute('aria-hidden', 'true');
    } else {
      el.removeAttribute('inert');
      el.removeAttribute('aria-hidden');
    }
  }

  // ---------- Switching between sign in / forgot password ----------
  function show(target, initial) {
    var view = target === 'forgot' ? 'forgot' : 'signin'; // old #signup links land on sign in

    if (!initial) card.classList.add('was-switched');
    card.dataset.mode = 'signin';
    views.dataset.view = view;
    setHidden(viewSignIn, view !== 'signin');
    setHidden(viewForgot, view !== 'forgot');

    document.title = TITLES[view] + ' · RFID Attendance';

    var hash = view === 'signin' ? '' : '#' + view;
    if (initial) {
      if (location.hash && location.hash !== hash) history.replaceState(null, '', location.pathname + location.search + hash);
      return;
    }
    history.replaceState(null, '', location.pathname + location.search + hash);

    // move focus to the first field once the switch is done (desktop only,
    // so phones don't pop the keyboard open)
    var area = view === 'forgot' ? viewForgot : viewSignIn;
    setTimeout(function () {
      var input = area.querySelector('.auth-input');
      if (input && desktop.matches) input.focus({ preventScroll: true });
    }, 480);
  }

  document.addEventListener('click', function (event) {
    var trigger = event.target.closest('[data-switch]');
    if (!trigger) return;
    event.preventDefault();
    show(trigger.dataset.switch);
  });

  window.addEventListener('hashchange', function () {
    show(location.hash.slice(1) || 'signin');
  });

  show(location.hash.slice(1) || 'signin', true);

  // ---------- Show / hide password ----------
  card.querySelectorAll('[data-toggle-password]').forEach(function (button) {
    button.addEventListener('click', function () {
      var input = button.parentElement.querySelector('.auth-input');
      var showing = input.type === 'text';
      input.type = showing ? 'password' : 'text';
      button.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
      button.setAttribute('aria-pressed', String(!showing));
      button.querySelector('.bi').className = 'bi ' + (showing ? 'bi-eye' : 'bi-eye-slash');
    });
  });

  // ---------- Notices, loading, shake ----------
  function showNotice(form, result) {
    var box = form.querySelector('[data-role="notice"]');
    box.dataset.tone = result.tone;
    box.innerHTML = '';
    var icon = document.createElement('i');
    icon.className = 'bi bi-' + result.icon;
    icon.setAttribute('aria-hidden', 'true');
    var text = document.createElement('span');
    text.textContent = result.message;
    box.append(icon, text);
    box.hidden = false;
  }

  function hideNotice(form) {
    form.querySelector('[data-role="notice"]').hidden = true;
  }

  function setLoading(button, loading) {
    button.classList.toggle('is-loading', loading);
    button.disabled = loading;
    var spinner = button.querySelector('.auth-spinner');
    if (loading && !spinner) {
      spinner = document.createElement('span');
      spinner.className = 'auth-spinner';
      spinner.setAttribute('aria-hidden', 'true');
      button.prepend(spinner);
    } else if (!loading && spinner) {
      spinner.remove();
    }
  }

  function shake(form) {
    form.classList.remove('is-shaking');
    void form.offsetWidth; // restart the animation
    form.classList.add('is-shaking');
  }

  // ---------- Form submit ----------
  ['signInForm', 'changeForm'].forEach(function (id) {
    var form = document.getElementById(id);
    if (!form) return;
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      hideNotice(form);
      form.classList.add('was-validated');

      if (!form.checkValidity()) {
        shake(form);
        var firstInvalid = form.querySelector('input:invalid');
        if (firstInvalid) firstInvalid.focus();
        return;
      }

      var button = form.querySelector('[type="submit"]');
      setLoading(button, true);
      submitToServer(id, Object.fromEntries(new FormData(form))).then(function (result) {
        setLoading(button, false);
        if (result) {
          showNotice(form, result);
          shake(form);
        }
      });
    });
  });

  // ---------- "Signing you in…" screen before going to the dashboard ----------
  var splash = null;
  var splashTimer = null;
  var SPLASH_DELAY = 700; // ms the screen shows before the sign-in continues

  function showSplash(x, y, title) {
    hideSplash(true);
    splash = document.createElement('div');
    splash.className = 'auth-splash';
    splash.setAttribute('role', 'status');
    splash.setAttribute('aria-live', 'polite');
    if (typeof x === 'number') {
      splash.style.setProperty('--cx', x + 'px');
      splash.style.setProperty('--cy', y + 'px');
    }
    splash.innerHTML =
      '<div class="auth-splash-inner">' +
        '<div class="auth-splash-mark" aria-hidden="true"><i class="bi bi-person-badge"></i></div>' +
        '<div class="auth-splash-title"></div>' +
        '<div class="auth-splash-sub">Preparing your dashboard</div>' +
        '<div class="auth-splash-bar" aria-hidden="true"><span></span></div>' +
      '</div>';
    splash.querySelector('.auth-splash-title').textContent = title || 'Signing you in…';
    document.body.appendChild(splash);
    // safety net: if nothing happened after a while, give the page back
    clearTimeout(splashTimer);
    splashTimer = setTimeout(hideSplash, 10000);
  }

  function hideSplash(instant) {
    clearTimeout(splashTimer);
    if (!splash) return;
    var el = splash;
    splash = null;
    if (instant === true) { el.remove(); return; }
    el.classList.add('is-leaving');
    el.addEventListener('animationend', function () { el.remove(); }, { once: true });
  }

  // "Sign in as someone else" on the change-password step
  document.addEventListener('click', function (event) {
    if (!event.target.closest('[data-action="cancel-change"]')) return;
    if (window.RFIDLogin) window.RFIDLogin.cancelChange();
    changeForm.reset();
    changeForm.hidden = true;
    signInForm.hidden = false;
  });

  // Reloaded the page while a password change was still required
  function resumePendingChange() {
    if (window.RFIDLogin && window.RFIDLogin.pendingChange) showChangeForm();
  }
  if (window.RFIDLogin) resumePendingChange();
  else document.addEventListener('rfid-login-ready', resumePendingChange, { once: true });

  // If login.js reports an error, remove the screen so the message is visible
  var signInError = document.getElementById('signInError');
  if (signInError) {
    new MutationObserver(function () {
      if (!signInError.classList.contains('d-none')) hideSplash();
    }).observe(signInError, { attributes: true, attributeFilter: ['class'], childList: true });
  }

  // Coming back with the browser's Back button
  window.addEventListener('pageshow', function (event) {
    if (event.persisted) hideSplash(true);
  });

  // ---------- Click ripple on buttons ----------
  document.addEventListener('pointerdown', function (event) {
    var button = event.target.closest('.auth-btn');
    if (!button || button.disabled) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    var rect = button.getBoundingClientRect();
    var size = Math.max(rect.width, rect.height);
    var dot = document.createElement('span');
    dot.className = 'auth-ripple';
    dot.style.width = dot.style.height = size + 'px';
    dot.style.left = (event.clientX - rect.left - size / 2) + 'px';
    dot.style.top = (event.clientY - rect.top - size / 2) + 'px';
    button.appendChild(dot);
    dot.addEventListener('animationend', function () { dot.remove(); });
  });
})();