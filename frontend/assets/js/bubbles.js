// Floating logo bubbles for the login page background.
// Change LOGO_SRC to your logo file (logo.svg is a placeholder). If it can't be loaded,
// the bubbles show the badge icon instead.
(function () {
  var LOGO_SRC = 'assets/img/logo.svg';
  var COUNT = window.innerWidth < 600 ? 9 : 16;   // how many bubbles
  var MIN_DUR = 14, MAX_DUR = 28;                 // seconds to float up (lower = faster)

  var box = document.getElementById('bubbles');
  if (!box || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  function rand(min, max) { return Math.random() * (max - min) + min; }

  function build(useImage) {
    var frag = document.createDocumentFragment();
    for (var i = 0; i < COUNT; i++) {
      var size = rand(34, 92);
      var dur = rand(MIN_DUR, MAX_DUR);
      var b = document.createElement('div');
      b.className = 'bubble';
      b.style.setProperty('--size', size + 'px');
      b.style.setProperty('--x', rand(0, 96) + '%');
      b.style.setProperty('--dur', dur + 's');
      b.style.setProperty('--delay', (-rand(0, dur)) + 's'); // start mid-flight so the screen isn't empty
      b.style.setProperty('--sway', rand(10, 30) + 'px');
      b.style.setProperty('--sway-dur', rand(2.5, 5) + 's');
      b.style.setProperty('--alpha', (size > 70 ? rand(.45, .65) : rand(.65, .95)).toFixed(2));

      var inner = document.createElement('div');
      inner.className = 'bubble-inner';
      if (useImage) {
        var img = document.createElement('img');
        img.src = LOGO_SRC;
        img.alt = '';
        inner.appendChild(img);
      } else {
        var icon = document.createElement('i');
        icon.className = 'bi bi-person-badge';
        inner.appendChild(icon);
      }
      b.appendChild(inner);
      frag.appendChild(b);
    }
    box.appendChild(frag);
  }

  var test = new Image();
  test.onload = function () { build(true); };
  test.onerror = function () { build(false); };
  test.src = LOGO_SRC;
})();