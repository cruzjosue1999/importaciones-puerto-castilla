/* Pull-to-refresh vanilla: jalar hacia abajo desde el tope recarga la app (estilo Facebook).
   Solo se activa con el scroll en el tope; no interfiere con modales, drawers ni el visor de fotos. */
(function () {
  'use strict';
  if (!('ontouchstart' in window)) return; // solo táctil

  var THRESHOLD = 80;   // px para soltar y recargar
  var MAX_PULL = 150;   // tope visual del indicador
  var startY = null;
  var state = 'idle';   // idle | pulling | ready | reloading
  var ind = null;

  function scrollingEl() {
    return document.scrollingElement || document.documentElement;
  }

  function overlayOpen() {
    // Cualquier modal, drawer, visor o backdrop visible bloquea el gesto.
    var sels = ['.modal:not(.hidden)', '.drawer:not(.hidden)', '#photo-viewer:not(.hidden)',
                '.backdrop:not(.hidden)', '.viewer:not(.hidden)'];
    for (var i = 0; i < sels.length; i++) {
      if (document.querySelector(sels[i])) return true;
    }
    return false;
  }

  function ensureIndicator() {
    if (ind) return ind;
    ind = document.createElement('div');
    ind.id = 'ptr-indicator';
    ind.setAttribute('aria-hidden', 'true');
    ind.innerHTML = '<span class="ptr-arrow">↓</span><span class="ptr-text">Jala para actualizar</span>';
    document.body.insertBefore(ind, document.body.firstChild);
    // Distancia para ocultar el indicador: su alto (56px) + 4px + el desfase
    // superior que le dé el CSS (en la tienda se despega de la barra de estado).
    var csTop = parseFloat(window.getComputedStyle(ind).top) || 0;
    ind._hideY = 60 + csTop;
    return ind;
  }

  function hideDist() { return (ind && ind._hideY) || 60; }

  function setPull(dy) {
    var el = ensureIndicator();
    var d = Math.max(0, Math.min(dy, MAX_PULL));
    el.style.transform = 'translateY(' + (d - hideDist()) + 'px)';
    if (d >= THRESHOLD) {
      if (state !== 'ready') {
        state = 'ready';
        el.classList.add('ready');
        el.querySelector('.ptr-text').textContent = 'Suelta para actualizar';
      }
    } else {
      if (state !== 'pulling') {
        state = 'pulling';
        el.classList.remove('ready');
        el.querySelector('.ptr-text').textContent = 'Jala para actualizar';
      }
    }
  }

  function hide() {
    if (ind) ind.style.transform = 'translateY(' + (-hideDist()) + 'px)';
    state = 'idle';
  }

  document.addEventListener('touchstart', function (e) {
    if (state === 'reloading') return;
    if (overlayOpen()) { startY = null; return; }
    if (scrollingEl().scrollTop > 0) { startY = null; return; }
    if (e.touches.length === 1) startY = e.touches[0].clientY;
  }, { passive: true });

  document.addEventListener('touchmove', function (e) {
    if (startY === null || state === 'reloading') return;
    if (overlayOpen()) { startY = null; hide(); return; }
    var dy = e.touches[0].clientY - startY;
    if (dy > 8 && scrollingEl().scrollTop <= 0) {
      setPull(dy);
    } else if (dy <= 0) {
      hide();
    }
    // Sin preventDefault: el scroll nativo sigue funcionando normal.
  }, { passive: true });

  function end() {
    if (startY === null) return;
    startY = null;
    if (state === 'ready') {
      state = 'reloading';
      var el = ensureIndicator();
      el.classList.add('reloading');
      el.innerHTML = '<span class="ptr-spinner"></span><span class="ptr-text">Actualizando…</span>';
      el.style.transform = 'translateY(0px)';
      setTimeout(function () { window.location.reload(); }, 350);
    } else {
      hide();
    }
  }
  document.addEventListener('touchend', end, { passive: true });
  document.addEventListener('touchcancel', function () { startY = null; hide(); }, { passive: true });
})();
