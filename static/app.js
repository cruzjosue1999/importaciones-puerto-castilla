/* Importaciones a Puerto Castilla - lógica de la app (vanilla JS, sin dependencias). */
(function () {
  'use strict';

  /* ---------- utilidades ---------- */
  function $(id) { return document.getElementById(id); }
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmtL(v) {
    return 'L' + Number(v || 0).toLocaleString('es-HN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  /* Número negativo en rojo (para pérdidas y descuentos). */
  function negL(v) {
    v = Number(v) || 0;
    if (!v) return fmtL(0);
    return '<span class="neg">' + fmtL(-Math.abs(v)) + '</span>';
  }
  function fmtD(v) {
    return '$' + Number(v || 0).toLocaleString('es-HN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  async function api(url, opts) {
    opts = opts || {};
    var res = await fetch(url, opts);
    var data = null;
    try { data = await res.json(); } catch (e) { /* no json */ }
    if (!res.ok) throw new Error((data && data.error) || 'Error ' + res.status);
    return data;
  }
  var noticeTimer = null;
  function notice(msg, isErr) {
    var n = $('notice');
    n.textContent = msg;
    n.classList.toggle('err', !!isErr);
    n.classList.remove('hidden');
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(function () { n.classList.add('hidden'); }, 2600);
  }

  /* ---------- confirmación propia (el confirm() del navegador no funciona en la app de iOS) ---------- */
  function askConfirm(msg, yesLabel) {
    return new Promise(function (resolve) {
      var m = $('confirm-modal');
      $('confirm-msg').textContent = msg;
      $('confirm-yes').textContent = yesLabel || 'Sí, eliminar';
      m.classList.remove('hidden');
      function done(val) {
        m.classList.add('hidden');
        $('confirm-yes').removeEventListener('click', onYes);
        $('confirm-no').removeEventListener('click', onNo);
        m.removeEventListener('click', onBg);
        resolve(val);
      }
      function onYes() { done(true); }
      function onNo() { done(false); }
      function onBg(e) { if (e.target === m) done(false); }
      $('confirm-yes').addEventListener('click', onYes);
      $('confirm-no').addEventListener('click', onNo);
      m.addEventListener('click', onBg);
    });
  }

  /* ---------- navegación por pestañas ---------- */
  var tabLoaders = { graficas: loadSummary, hoja: loadSheet, productos: loadProducts, gastos: loadExpenses };
  /* Refresca los datos sin recargar la página: se queda en la pestaña actual.
     Lo usa el pull-to-refresh para no mandar al usuario a la página principal. */
  async function refreshCurrentTab() {
    await loadCajas();
    followInvestment(productFilter);
    var active = document.querySelector('.tab.active');
    var tab = active ? active.id.replace(/^tab-/, '') : null;
    if (tab && tabLoaders[tab]) await tabLoaders[tab]();
  }
  window.refreshAppData = refreshCurrentTab;
  document.querySelectorAll('.tabbtn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      document.querySelectorAll('.tabbtn').forEach(function (b) { b.classList.remove('active'); });
      document.querySelectorAll('.tab').forEach(function (t) { t.classList.remove('active'); });
      btn.classList.add('active');
      var tab = btn.getAttribute('data-tab');
      $('tab-' + tab).classList.add('active');
      // Las inversiones se crean desde varias pestañas: recargarlas al cambiar
      // de pestaña para que el cuadro "Inversiones", los iconos de caja y los
      // formularios nunca muestren datos viejos.
      loadCajas().then(function () {
        followInvestment(productFilter);
        if (tabLoaders[tab]) tabLoaders[tab]();
      });
      window.scrollTo(0, 0);
    });
  });

  /* ---------- buscador y filtros de productos ---------- */
  var prodSearchInput = $('prod-search');
  if (prodSearchInput) {
    prodSearchInput.addEventListener('input', function (e) {
      prodSearch = e.target.value;
      renderProducts();
    });
  }
  var prodChips = $('prod-chips');
  if (prodChips) {
    prodChips.querySelectorAll('.pchip').forEach(function (c) {
      c.addEventListener('click', function () { setProdChip(c.getAttribute('data-f')); });
    });
  }
  var expFilterChips = $('exp-filter-chips');
  if (expFilterChips) {
    expFilterChips.querySelectorAll('.pchip').forEach(function (c) {
      c.addEventListener('click', function () { setExpChip(c.getAttribute('data-f')); });
    });
  }
  var soldAllBtn = $('sold-all-btn');
  if (soldAllBtn) soldAllBtn.addEventListener('click', markAllSold);
  var unsoldAllBtn = $('unsold-all-btn');
  if (unsoldAllBtn) unsoldAllBtn.addEventListener('click', unmarkAllSold);
  var lostAllBtn = $('lost-all-btn');
  if (lostAllBtn) lostAllBtn.addEventListener('click', markAllLost);

  /* ---------- Acciones sobre la caja seleccionada (toda la caja) ---------- */
  function selectedCaja() {
    if (productFilter === 'all' || productFilter === 'none') return null;
    return cajaById(productFilter);
  }
  function needCaja() {
    var c = selectedCaja();
    if (!c) notice('Primero elige una inversión tocando su caja.');
    return c;
  }
  async function toggleExenta(flag) {
    var c = needCaja(); if (!c) return;
    var body = { name: c.name };
    body[flag] = c[flag] ? 0 : 1;
    try {
      await api('/api/cajas/' + c.id, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      notice('✅ ' + c.name + (body[flag] ? ': exenta.' : ': ya no exenta.'));
      await loadCajas();
      refreshExentaBtns();
      loadProducts();
      loadExpenses();
    } catch (e) { notice(e.message, true); }
  }
  function refreshExentaBtns() {
    var c = selectedCaja();
    var bf = $('exenta-fotos-btn'), bt = $('exenta-tax-btn');
    if (bf) bf.classList.toggle('toggled', !!(c && c.exenta_fotos));
    if (bt) bt.classList.toggle('toggled', !!(c && c.exenta_tax));
  }
  $('exenta-fotos-btn').addEventListener('click', function () { toggleExenta('exenta_fotos'); });
  $('exenta-tax-btn').addEventListener('click', function () { toggleExenta('exenta_tax'); });
  $('rename-caja-btn').addEventListener('click', function () {
    var c = needCaja(); if (!c) return;
    invEditId = c.id;
    $('inv-name').value = c.name;
    $('inv-fecha-realizada').value = c.fecha_realizada || '';
    $('inv-fecha-entregada').value = c.fecha_entregada || '';
    $('inv-fecha-finalizada').value = c.fecha_finalizada || '';
    $('inv-error').classList.add('hidden');
    $('inv-save').textContent = 'Guardar cambios';
    $('inv-create').classList.remove('hidden');
    $('inv-name').focus();
    window.scrollTo(0, 0);
  });
  $('del-caja-btn').addEventListener('click', function () {
    var c = needCaja(); if (!c) return;
    delCaja(c.id);
  });

  /* ---------- Cajas (grupos por enviada) ---------- */
  var cajasCache = [];
  var productFilter = 'all'; // 'all' | 'none' | <id>
  var prevBoxFilter = null; // caja anterior al entrar a "Similares"

  function cajaOptionsHTML(selected, includeGeneral) {
    var sel = selected == null ? '' : String(selected);
    var h = includeGeneral ? '<option value="">General</option>' : '';
    h += cajasCache.map(function (c) {
      return '<option value="' + c.id + '"' + (String(c.id) === sel ? ' selected' : '') + '>' +
        escapeHtml(c.name) + ' (' + c.n_products + ')</option>';
    }).join('');
    return h;
  }

  function refreshCajaSelects(keepValues) {
    var keep = {};
    if (keepValues) ['add-caja', 'edit-caja', 'expense-caja', 'sheet-caja', 'charts-caja'].forEach(function (id) {
      var el = $(id); if (el) keep[id] = el.value;
    });
    var sc = $('sheet-caja'), cc = $('charts-caja');
    if (sc) sc.innerHTML = '<option value="all">Todas las cajas</option>' + cajasCache.map(function (c) {
      return '<option value="' + c.id + '">' + escapeHtml(c.name) + '</option>';
    }).join('');
    if (cc) cc.innerHTML = sc ? sc.innerHTML : '';
    var ac = $('add-caja'); if (ac) ac.innerHTML = '<option value="">Sin inversión</option>' + cajaOptionsHTML('');
    var ec = $('edit-caja'); if (ec) ec.innerHTML = '<option value="">Sin inversión</option>' + cajaOptionsHTML('');
    var mc = $('expense-caja'); if (mc) mc.innerHTML = cajaOptionsHTML('', true);
    if (keepValues) Object.keys(keep).forEach(function (id) {
      var el = $(id);
      if (el && el.querySelector('option[value="' + keep[id] + '"]')) el.value = keep[id];
    });
  }

  /* La carpeta seleccionada manda en toda la app: los productos nuevos,
     los gastos nuevos y los filtros de Hoja y Gráficas la siguen. */
  function followInvestment(id) {
    if (id === 'none') return;
    ['add-caja', 'sheet-caja', 'charts-caja'].forEach(function (sid) {
      var el = $(sid);
      if (!el) return;
      if (id === 'all') {
        if (sid === 'sheet-caja' || sid === 'charts-caja') el.value = 'all';
        return;
      }
      if (el.querySelector('option[value="' + id + '"]')) el.value = String(id);
    });
  }

  /* Una sola inversión seleccionada manda en toda la app: las cajas con
     icono de Productos y de Gastos comparten la selección; al tocar una
     caja se muestran sus productos, fotos, gastos, gráficas y hoja. */
  /* AAAA-MM-DD -> D/M/AAAA para mostrar en las tarjetas. */
  function fmtFecha(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
    return m ? (Number(m[3]) + '/' + Number(m[2]) + '/' + m[1]) : '';
  }
  function fmtFechas(c) {
    var parts = [];
    if (c.fecha_realizada) parts.push('Realizada ' + fmtFecha(c.fecha_realizada));
    if (c.fecha_entregada) parts.push('Entregada ' + fmtFecha(c.fecha_entregada));
    if (c.fecha_finalizada) parts.push('Finalizada ' + fmtFecha(c.fecha_finalizada));
    return parts.join(' · ');
  }
  function renderChips() {
    var boxes = [{ f: 'all', icon: '🗂️', name: 'Todas', sub: '', dates: '' }];
    cajasCache.forEach(function (c) {
      boxes.push({
        f: String(c.id), icon: '📦', name: c.name,
        sub: c.n_products + ' prod.', dates: fmtFechas(c)
      });
    });
    boxes.push({ f: 'none', icon: '🏷️', name: 'Sin inversión', sub: '', dates: '' });
    var h = boxes.map(function (b) {
      return '<button class="caja-box' + (String(productFilter) === b.f ? ' active' : '') +
        '" data-f="' + b.f + '">' +
        '<span class="caja-box-icon" aria-hidden="true">' + b.icon + '</span>' +
        '<span class="caja-box-name">' + escapeHtml(b.name) + '</span>' +
        (b.sub ? '<span class="caja-box-sub">' + escapeHtml(b.sub) + '</span>' : '') +
        (b.dates ? '<span class="caja-box-dates">' + escapeHtml(b.dates) + '</span>' : '') +
        '</button>';
    }).join('');
    ['caja-chips', 'expense-chips'].forEach(function (boxId) {
      var box = $(boxId);
      if (!box) return;
      // En Productos, la primera tarjeta es "＋ Agregar caja".
      var html = (boxId === 'caja-chips')
        ? '<button class="caja-box caja-add" data-f="__add__">' +
          '<span class="caja-box-icon" aria-hidden="true">➕</span>' +
          '<span class="caja-box-name">Agregar caja</span></button>' + h
        : h;
      box.innerHTML = html;
      box.querySelectorAll('.caja-box').forEach(function (btn) {
        btn.addEventListener('click', function () {
          if (btn.getAttribute('data-f') === '__add__') { openInvCreate(); return; }
          productFilter = btn.getAttribute('data-f');
          renderChips();
          followInvestment(productFilter);
          resetExpChipSilent(); // el filtro "Sin registrar" no se arrastra entre cajas
          loadProducts();
          loadExpenses();
        });
      });
    });
    var ac = $('add-caja');
    if (ac && productFilter !== 'all' && productFilter !== 'none') {
      var opt = ac.querySelector('option[value="' + productFilter + '"]');
      if (opt) ac.value = productFilter;
    }
    refreshExentaBtns();
  }

  async function loadCajas() {
    try {
      cajasCache = await api('/api/cajas');
      renderChips();
      refreshCajaSelects(true);
    } catch (e) { /* sin cajas no se bloquea nada */ }
  }

  async function delCaja(id) {
    if (!(await askConfirm('¿Eliminar esta inversión? Solo se puede si no tiene productos.'))) return;
    try {
      await api('/api/cajas/' + id, { method: 'DELETE' });
      notice('Inversión eliminada.');
      if (String(productFilter) === String(id)) productFilter = 'all';
      await loadCajas();
      followInvestment(productFilter);
      loadProducts();
      loadExpenses();
    } catch (e) { notice(e.message, true); }
  }

  /* ---------- Cajas: exenciones ---------- */
  function cajaById(id) {
    for (var i = 0; i < cajasCache.length; i++) {
      if (String(cajasCache[i].id) === String(id)) return cajasCache[i];
    }
    return null;
  }
  function cajaExenta(cajaId, flag) {
    if (cajaId == null || cajaId === 'none') return false;
    var c = cajaById(cajaId);
    return !!(c && c[flag]);
  }
  function productCard(p) {
    var photo = p.photo_url
      ? '<img class="card-photo" src="' + escapeHtml(p.photo_url) + '" alt="Foto de ' + escapeHtml(p.description) + '" loading="lazy">'
      : '<div class="card-photo placeholder">📦</div>';
    var meta = [];
    if (p.caja_name) meta.push('📁 ' + escapeHtml(p.caja_name));
    if (p.size_shoes) meta.push('👟 ' + escapeHtml(p.size_shoes));
    if (p.size_shirts) meta.push('👕 ' + escapeHtml(p.size_shirts));
    if (p.quantity && Number(p.quantity) !== 1) meta.push('× ' + escapeHtml(String(p.quantity)));
    var metaHtml = meta.length ? '<p class="card-meta">' + meta.join(' &nbsp;·&nbsp; ') + '</p>' : '';
    var disc = Number(p.discount_pct) || 0;
    var discLps = Number(p.discount_lps) || 0;
    var qty = Number(p.quantity) || 1;
    var numsHtml = numRow('Precio compra $', fmtD(p.purchase_usd)) +
      numRow('Pagado en LPS', fmtL(p.cost_lps));
    if (p.lost === 2) {
      // Recuperado: volvió lo invertido, ganancia 0.
      numsHtml += numRow('Monto recuperado', fmtL((Number(p.cost_lps) || 0) * qty)) +
        numRow('Ganancia libre', fmtL(0), true);
    } else if (p.lost === 1) {
      // Pérdida total: el negativo va en la fila "Pérdida" (rojo);
      // la ganancia libre ya no cuenta la pérdida: queda en 0.
      numsHtml += numRow('Precio esperado de venta', fmtL(p.sale_lps)) +
        numRow('Ganancia libre', fmtL(0), true) +
        numRow('Pérdida', negL((Number(p.cost_lps) || 0) * qty), true);
    } else if (disc > 0 || discLps > 0) {
      var perdidoDesc = ((Number(p.sale_lps) || 0) - (Number(p.sale_efectivo_lps) || 0)) * qty;
      var discBadge = discLps > 0 ? '-' + fmtL(discLps) : '-' + disc + '%';
      numsHtml += numRow('Precio original',
          '<s class="tachado">' + fmtL(p.sale_lps) + '</s> <span class="desc-badge">' + discBadge + '</span>') +
        numRow('Precio con descuento', '<span class="precio-desc">' + fmtL(p.sale_efectivo_lps) + '</span>') +
        numRow('Perdido en descuento', '<span class="neg">' + fmtL(perdidoDesc) + '</span>') +
        numRow('Ganancia libre', fmtL(p.ganancia_libre), true);
    } else {
      numsHtml += numRow('Precio de venta', fmtL(p.sale_lps)) +
        numRow('Ganancia libre', fmtL(p.ganancia_libre), true);
    }
    return '<article class="card" data-id="' + p.id + '">' +
      '<button type="button" class="card-toggle">' +
      '<span class="card-toggle-title">' + escapeHtml(p.description) +
      (p.sold ? '<span class="sold-badge">VENDIDO</span>' : '') +
      (p.lost === 1 ? '<span class="lost-badge">PÉRDIDA</span>' : '') +
      (p.lost === 2 ? '<span class="rec-badge">RECUPERADO</span>' : '') + '</span>' +
      '<span class="chev">▼</span>' +
      '</button>' +
      '<div class="card-detail hidden">' + photo +
      '<div class="card-body">' + metaHtml +
      '<div class="nums">' + numsHtml + '</div>' +
      '<div class="card-actions">' +
      '<button class="btn edit-btn" data-id="' + p.id + '">✏️ Editar</button>' +
      '<button class="btn danger del-btn" data-id="' + p.id + '">🗑️ Eliminar</button>' +
      '<button class="btn sold-btn" data-id="' + p.id + '" data-sold="' + (p.sold ? 1 : 0) + '">' +
      (p.sold ? '↩ Quitar vendido' : '✓ Marcar como vendido') + '</button>' +
      '<button class="btn lost-btn" data-id="' + p.id + '" data-lost="' + (p.lost ? 1 : 0) + '">' +
      (p.lost ? '↩ Quitar pérdida' : '📉 Marcar pérdida') + '</button>' +
      '</div></div></div></article>';
  }
  function numRow(label, value, isTotal) {
    return '<div class="num-row' + (isTotal ? ' total' : '') + '">' +
      '<span class="lbl">' + label + '</span><span class="val">' + value + '</span></div>';
  }

  function productGroup(name, items) {
    var body = items.length
      ? items.map(productCard).join('')
      : '<p class="hint" style="padding: 4px 6px 10px;">Sin productos.</p>';
    return '<div class="prod-group">' +
      '<button type="button" class="group-toggle">' +
      '<span class="group-name">📦 ' + escapeHtml(name) + '</span>' +
      '<span class="group-meta">' + items.length + ' prod.</span>' +
      '<span class="chev">▼</span>' +
      '</button>' +
      '<div class="group-body hidden">' + body + '</div></div>';
  }

  function wireAccordion(box) {
    box.querySelectorAll('.group-toggle').forEach(function (t) {
      t.addEventListener('click', function () {
        var d = t.parentNode.querySelector('.group-body');
        var chev = t.querySelector('.chev');
        var collapsed = d.classList.toggle('hidden');
        chev.textContent = collapsed ? '▼' : '▲';
      });
    });
    box.querySelectorAll('.card-toggle').forEach(function (t) {
      t.addEventListener('click', function () {
        var d = t.parentNode.querySelector('.card-detail');
        var chev = t.querySelector('.chev');
        var collapsed = d.classList.toggle('hidden');
        chev.textContent = collapsed ? '▼' : '▲';
      });
    });
  }

  /* ---------- Productos: buscador, filtros y vendidos ---------- */
  var productListCache = [];
  var prodSearch = '';
  var prodChip = 'all'; // all | sold | pending | nophoto | noprecio | lost | hiprofit | similares

  /* Descripción normalizada para detectar productos similares/duplicados. */
  function normDesc(s) {
    return String(s || '').toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
  }

  function filteredProducts() {
    var q = prodSearch.trim().toLowerCase();
    var base = productListCache.filter(function (p) {
      if (q && String(p.description || '').toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
    if (prodChip === 'similares') {
      // Solo productos cuya descripción normalizada aparece 2+ veces.
      var counts = {};
      base.forEach(function (p) {
        var k = normDesc(p.description);
        if (k) counts[k] = (counts[k] || 0) + 1;
      });
      return base.filter(function (p) { return counts[normDesc(p.description)] > 1; });
    }
    if (prodChip === 'hiprofit') {
      // Solo ganancias positivas; el agrupado por categorías lo hace profitGroupsHtml.
      return base.filter(function (p) { return (p.ganancia_libre || 0) > 0; });
    }
    return base.filter(function (p) {
      if (prodChip === 'sold') return !!p.sold;
      if (prodChip === 'pending') return !p.sold && !p.lost;
      if (prodChip === 'nophoto') return !p.photo_url && !cajaExenta(p.caja_id, 'exenta_fotos');
      if (prodChip === 'noprecio') return !p.sale_lps && !p.lost;
      if (prodChip === 'lost') return p.lost === 1;
      return true;
    });
  }

  function renderSalesStrip() {
    var strip = $('sales-strip');
    if (!strip) return;
    var v = productListCache.filter(function (p) { return p.sold; });
    var l = productListCache.filter(function (p) { return p.lost === 1; });
    var r = productListCache.filter(function (p) { return p.lost === 2; });
    var real = v.reduce(function (a, p) { return a + (p.ganancia_libre || 0); }, 0);
    var perd = l.reduce(function (a, p) {
      return a + (Number(p.cost_lps) || 0) * (Number(p.quantity) || 1);
    }, 0);
    strip.innerHTML = '<span>Vendidos: <b>' + v.length + '</b></span> · ' +
      '<span>Pérdidas: <b>' + l.length + '</b></span> · ' +
      '<span>Recuperados: <b>' + r.length + '</b></span> · ' +
      '<span>Pendientes: <b>' + (productListCache.length - v.length - l.length - r.length) + '</b></span> · ' +
      '<span>Ganancia real: <b>' + fmtL(real - perd) + '</b></span>';
    strip.classList.toggle('hidden', productListCache.length === 0);
  }

  function setProdChip(f) {
    var was = prodChip;
    prodChip = f;
    // "Similares" compara productos entre todas las cajas: la selección pasa
    // a "Todas" al entrar y se restaura la caja anterior al salir.
    var boxChanged = (f === 'similares') !== (was === 'similares');
    if (f === 'similares' && was !== 'similares') {
      prevBoxFilter = productFilter;
      productFilter = 'all';
    } else if (was === 'similares' && f !== 'similares') {
      if (prevBoxFilter) productFilter = prevBoxFilter;
      prevBoxFilter = null;
    }
    var chips = $('prod-chips');
    if (chips) chips.querySelectorAll('.pchip').forEach(function (c) {
      c.classList.toggle('active', c.getAttribute('data-f') === f);
    });
    var noP = $('no-products');
    if (noP) noP.innerHTML = (f === 'similares')
      ? 'No hay productos con descripciones similares entre las cajas.'
      : (f === 'hiprofit')
        ? 'Ningún producto con ganancia para agrupar por categorías.'
        : 'Aún no hay productos. Toca el botón <strong>+</strong> para agregar el primero.';
    if (boxChanged) {
      renderChips();
      followInvestment(productFilter);
      resetExpChipSilent();
      loadProducts(); // "Similares" trae productos de todas las cajas
    } else {
      renderProducts();
    }
  }

  /* Grupos de productos con descripción similar (entre todas las cajas):
     a la derecha se muestra la diferencia de lo pagado en $ y LPS. */
  function similarGroupsHtml(list) {
    var groups = {}, order = [];
    list.forEach(function (p) {
      var k = normDesc(p.description);
      if (!k) return;
      if (!groups[k]) { groups[k] = { label: p.description, items: [] }; order.push(k); }
      groups[k].items.push(p);
    });
    return order.map(function (k) {
      var g = groups[k];
      g.items.sort(function (a, b) { return (Number(a.purchase_usd) || 0) - (Number(b.purchase_usd) || 0); });
      var usds = g.items.map(function (p) { return Number(p.purchase_usd) || 0; });
      var lpss = g.items.map(function (p) { return Number(p.cost_lps) || 0; });
      var dUsd = Math.max.apply(null, usds) - Math.min.apply(null, usds);
      var dLps = Math.max.apply(null, lpss) - Math.min.apply(null, lpss);
      var head = '<div class="sim-head"><span class="sim-title">🔍 ' + escapeHtml(g.label) +
        ' <span class="sim-count">(' + g.items.length + ')</span></span>';
      if (dUsd > 0.005 || dLps > 0.005) {
        // El producto más caro del grupo: ahí está la diferencia de precios.
        var maxP = g.items[0];
        g.items.forEach(function (p) {
          var pu = Number(p.purchase_usd) || 0, mu = Number(maxP.purchase_usd) || 0;
          var pl = Number(p.cost_lps) || 0, ml = Number(maxP.cost_lps) || 0;
          if (pu > mu || (pu === mu && pl > ml)) maxP = p;
        });
        head += '<button type="button" class="sim-diff sim-diff-btn" data-target="' + maxP.id +
          '" title="Ver el producto con la diferencia">⚠️ Dif. de pago: ' +
          fmtD(dUsd) + ' (' + fmtL(dLps) + ')</button>';
      } else {
        head += '<span class="sim-ok">✓ Mismo precio pagado</span>';
      }
      return '<div class="sim-group">' + head + '</div>' +
        g.items.map(productCard).join('');
    }).join('');
  }

  /* Categorías de ganancia (de menor a mayor): cada producto va a la
     categoría más cercana; más de L550 cae en una sola categoría "+L550". */
  var PROFIT_CATS = [25, 50, 100, 250, 300, 350, 400, 450, 500, 550];
  function profitCatOf(g) {
    if (g > 550) return 'mas550';
    var best = PROFIT_CATS[0], bd = Math.abs(g - best);
    for (var i = 1; i < PROFIT_CATS.length; i++) {
      var d = Math.abs(g - PROFIT_CATS[i]);
      if (d < bd) { bd = d; best = PROFIT_CATS[i]; }
    }
    return best;
  }
  function profitGroupsHtml(list) {
    var groups = {}, order = [];
    list.forEach(function (p) {
      var g = Number(p.ganancia_libre) || 0;
      if (g <= 0) return;
      var c = profitCatOf(g);
      var key = (c === 'mas550') ? 'mas550' : ('c' + c);
      if (!groups[key]) { groups[key] = { cat: c, items: [] }; order.push(key); }
      groups[key].items.push(p);
    });
    order.sort(function (a, b) {
      var va = groups[a].cat === 'mas550' ? Infinity : groups[a].cat;
      var vb = groups[b].cat === 'mas550' ? Infinity : groups[b].cat;
      return va - vb;
    });
    return order.map(function (key) {
      var gr = groups[key];
      gr.items.sort(function (a, b) {
        return (Number(a.ganancia_libre) || 0) - (Number(b.ganancia_libre) || 0);
      });
      var label = gr.cat === 'mas550' ? '+L550' : 'L' + gr.cat;
      var head = '<div class="sim-head"><span class="sim-title">💰 Ganancia ' + label +
        ' <span class="sim-count">(' + gr.items.length + ')</span></span></div>';
      return '<div class="sim-group profit-group">' + head + '</div>' +
        gr.items.map(productCard).join('');
    }).join('');
  }

  function renderProducts() {
    var box = $('product-list');
    if (!box) return;
    var list = filteredProducts();
    $('no-products').classList.toggle('hidden', list.length > 0);
    if (prodChip === 'similares') {
      box.innerHTML = similarGroupsHtml(list);
    } else if (prodChip === 'hiprofit') {
      box.innerHTML = profitGroupsHtml(list);
    } else if (productFilter === 'all') {
      // "Todas": una tarjeta por caja (en el orden de la app) con sus productos adentro.
      var groups = [], seen = {};
      cajasCache.forEach(function (c) {
        groups.push({ id: c.id, name: c.name, items: [] });
        seen[String(c.id)] = groups[groups.length - 1];
      });
      var noneGroup = { id: 'none', name: 'Sin inversión', items: [] };
      list.forEach(function (p) {
        var g = (p.caja_id !== null && p.caja_id !== undefined && seen[String(p.caja_id)])
          ? seen[String(p.caja_id)] : noneGroup;
        g.items.push(p);
      });
      if (noneGroup.items.length) groups.push(noneGroup);
      // Ocultar cajas vacías cuando hay búsqueda o filtro activo
      var filtering = prodSearch.trim() !== '' || prodChip !== 'all';
      box.innerHTML = groups
        .filter(function (g) { return !filtering || g.items.length > 0; })
        .map(function (g) { return productGroup(g.name, g.items); }).join('');
    } else {
      box.innerHTML = list.map(productCard).join('');
    }
    wireAccordion(box);
    box.querySelectorAll('.edit-btn').forEach(function (b) {
      b.addEventListener('click', function () { openEdit(Number(b.getAttribute('data-id'))); });
    });
    box.querySelectorAll('.del-btn').forEach(function (b) {
      b.addEventListener('click', function () { delProduct(Number(b.getAttribute('data-id'))); });
    });
    box.querySelectorAll('.sold-btn').forEach(function (b) {
      b.addEventListener('click', function () {
        toggleSold(Number(b.getAttribute('data-id')), b.getAttribute('data-sold') !== '1');
      });
    });
    box.querySelectorAll('.lost-btn').forEach(function (b) {
      b.addEventListener('click', function () {
        var id = Number(b.getAttribute('data-id'));
        var p = findCached(id);
        if (p && p.lost) toggleLost(id, 0);
        else openLostChoice(id);
      });
    });
  }

  /* Elige el tipo de pérdida: total (1) o recuperado (2). */
  var lostChoiceId = null;
  function openLostChoice(id) {
    lostChoiceId = id;
    $('lost-modal').classList.remove('hidden');
  }
  function closeLostChoice() {
    lostChoiceId = null;
    $('lost-modal').classList.add('hidden');
  }

  /* Cobros: pagos recibidos por caja (ventas al crédito, en partes). */
  function hoyISO() {
    var d = new Date();
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }
  function openCobros() {
    var sel = $('cobros-caja');
    var cv = ($('charts-caja') && $('charts-caja').value) || 'all';
    sel.innerHTML = cajasCache.map(function (c) {
      return '<option value="' + c.id + '">' + escapeHtml(c.name) + '</option>';
    }).join('');
    if (cv !== 'all' && cajasCache.some(function (c) { return String(c.id) === String(cv); })) {
      sel.value = cv;
    } else if (cajasCache.length) {
      sel.value = cajasCache[0].id;
    }
    $('cobro-monto').value = '';
    $('cobro-nota').value = '';
    $('cobro-fecha').value = hoyISO(); // automática, pero editable
    $('cobros-error').classList.add('hidden');
    $('cobros-modal').classList.remove('hidden');
    loadCobros();
  }
  function closeCobros() { $('cobros-modal').classList.add('hidden'); }
  function cobroScope() {
    var v = $('cobros-caja').value;
    return v ? '?caja_id=' + encodeURIComponent(v) : '';
  }
  function fmtFechaCorta(ts) {
    if (!ts) return '';
    var d = new Date(ts * 1000);
    return d.getDate() + '/' + (d.getMonth() + 1) + '/' + d.getFullYear();
  }
  function cobroRow(b) {
    return '<div class="cobro-row"><span class="cobro-main"><b>' + fmtL(b.amount_lps) + '</b>' +
      (b.note ? ' <span class="cobro-note">' + escapeHtml(b.note) + '</span>' : '') +
      ' <span class="cobro-date">' + fmtFechaCorta(b.created_at) + '</span></span>' +
      '<button type="button" class="btn danger cobro-del" data-id="' + b.id + '">✕</button></div>';
  }
  async function loadCobros() {
    var list = $('cobros-list'), totals = $('cobros-totals');
    try {
      var q = cobroScope();
      var items = await api('/api/cobros' + q);
      var s = await api('/api/summary' + q);
      totals.innerHTML =
        '<div class="cobros-total-row"><span>Vendido (a crédito o no)</span><b>' + fmtL(s.total_venta_vendidos_lps) + '</b></div>' +
        '<div class="cobros-total-row"><span>💵 Cobrado</span><b>' + fmtL(s.total_cobrado_lps) + '</b></div>' +
        '<div class="cobros-total-row total"><span>📋 Falta por cobrar</span><b>' + fmtL(s.falta_por_cobrar_lps) + '</b></div>';
      list.innerHTML = items.length
        ? items.map(cobroRow).join('')
        : '<p class="hint">Sin cobros registrados en esta caja.</p>';
    } catch (e) { notice('No se pudieron cargar los cobros: ' + e.message, true); }
  }

  /* Pinta botones e insignias de vendido/pérdida de una tarjeta en su lugar. */
  function paintStatus(card, p) {
    var sbtn = card.querySelector('.sold-btn');
    sbtn.setAttribute('data-sold', p.sold ? '1' : '0');
    sbtn.textContent = p.sold ? '↩ Quitar vendido' : '✓ Marcar como vendido';
    var lbtn = card.querySelector('.lost-btn');
    lbtn.setAttribute('data-lost', String(p.lost || 0));
    lbtn.textContent = p.lost ? '↩ Quitar pérdida' : '📉 Marcar pérdida';
    var title = card.querySelector('.card-toggle-title');
    var sbadge = title.querySelector('.sold-badge');
    if (p.sold && !sbadge) {
      var s = document.createElement('span');
      s.className = 'sold-badge';
      s.textContent = 'VENDIDO';
      title.appendChild(s);
    } else if (!p.sold && sbadge) {
      title.removeChild(sbadge);
    }
    var lbadge = title.querySelector('.lost-badge');
    var rbadge = title.querySelector('.rec-badge');
    if (p.lost === 1) {
      if (rbadge) title.removeChild(rbadge);
      if (!lbadge) {
        var l = document.createElement('span');
        l.className = 'lost-badge';
        l.textContent = 'PÉRDIDA';
        title.appendChild(l);
      }
    } else if (p.lost === 2) {
      if (lbadge) title.removeChild(lbadge);
      if (!rbadge) {
        var r = document.createElement('span');
        r.className = 'rec-badge';
        r.textContent = 'RECUPERADO';
        title.appendChild(r);
      }
    } else {
      if (lbadge) title.removeChild(lbadge);
      if (rbadge) title.removeChild(rbadge);
    }
  }

  function findCached(id) {
    for (var i = 0; i < productListCache.length; i++) {
      if (productListCache[i].id === id) return productListCache[i];
    }
    return null;
  }

  function refreshCardStatus(id) {
    var p = findCached(id);
    renderSalesStrip();
    var card = document.querySelector('article.card[data-id="' + id + '"]');
    if (!card || !p) return;
    var stillVisible = filteredProducts().some(function (x) { return x.id === id; });
    if (!stillVisible) {
      card.parentNode.removeChild(card);
    } else {
      paintStatus(card, p);
    }
  }

  async function toggleSold(id, toSold) {
    try {
      await api('/api/products/' + id + '/sold', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sold: toSold })
      });
      // Actualizar la caché y la tarjeta en su lugar, sin reconstruir
      // la lista (para no cerrar los acordeones abiertos).
      var p = findCached(id);
      if (p) { p.sold = toSold; if (toSold) p.lost = false; }
      refreshCardStatus(id);
      notice(toSold ? '✅ Marcado como vendido.' : '↩ Vuelto a pendiente.');
    } catch (e) { notice('No se pudo actualizar: ' + e.message, true); }
  }

  async function toggleLost(id, toLost) {
    try {
      await api('/api/products/' + id + '/lost', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lost: toLost })
      });
      var p = findCached(id);
      if (p) { p.lost = toLost; if (toLost) p.sold = false; }
      loadProducts(); // re-render completo: las filas cambian según el tipo
      notice(toLost === 2 ? '↩️ Recuperado: volvió lo invertido.'
        : toLost === 1 ? '📉 Pérdida total marcada.' : '↩ Pérdida quitada.');
    } catch (e) { notice('No se pudo actualizar: ' + e.message, true); }
  }

  /* Desmarca como vendidos todos los productos visibles (respeta la
     inversión, el buscador y los filtros). */
  async function unmarkAllSold() {
    var visible = filteredProducts();
    var marcados = visible.filter(function (p) { return p.sold; });
    if (!marcados.length) {
      notice(visible.length ? 'Ninguno está marcado como vendido.' : 'No hay productos a la vista.');
      return;
    }
    if (!window.confirm('¿Quitar la marca de vendido a ' + marcados.length + ' producto(s)?')) return;
    try {
      var r = await api('/api/products/sold_all', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: marcados.map(function (p) { return p.id; }), sold: false })
      });
      marcados.forEach(function (p) { p.sold = false; refreshCardStatus(p.id); });
      notice('↩ ' + (r.marcados || marcados.length) + ' vueltos a pendiente.');
    } catch (e) { notice('No se pudo actualizar: ' + e.message, true); }
  }
  /* Marca como pérdida todos los productos visibles (respeta la inversión,
     el buscador y los filtros). La pérdida saca al producto de "Sin precio". */
  async function markAllLost() {
    var visible = filteredProducts();
    var pendientes = visible.filter(function (p) { return !p.sold && !p.lost; });
    if (!pendientes.length) {
      notice(visible.length ? 'Ya todos están vendidos o en pérdida.' : 'No hay productos a la vista.');
      return;
    }
    if (!window.confirm('¿Marcar ' + pendientes.length + ' producto(s) como pérdida?')) return;
    try {
      var r = await api('/api/products/lost_all', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: pendientes.map(function (p) { return p.id; }) })
      });
      notice('✅ ' + (r.marcados || pendientes.length) + ' marcados como pérdida.');
      loadProducts();
    } catch (e) { notice('No se pudo marcar: ' + e.message, true); }
  }

  /* Marca como vendidos todos los productos visibles (respeta la inversión,
     el buscador y los filtros). El botón manual de cada tarjeta se conserva. */
  async function markAllSold() {
    var visible = filteredProducts();
    var pendientes = visible.filter(function (p) { return !p.sold && !p.lost; });
    if (!pendientes.length) {
      notice(visible.length ? 'Ya todos están marcados como vendidos.' : 'No hay productos a la vista.');
      return;
    }
    if (!window.confirm('¿Marcar ' + pendientes.length + ' producto(s) como vendidos?')) return;
    try {
      var r = await api('/api/products/sold_all', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: pendientes.map(function (p) { return p.id; }) })
      });
      pendientes.forEach(function (p) { p.sold = true; refreshCardStatus(p.id); });
      notice('✅ ' + (r.marcados || pendientes.length) + ' marcados como vendidos.');
    } catch (e) { notice('No se pudo marcar: ' + e.message, true); }
  }

  async function loadProducts() {
    try {
      var url = '/api/products';
      // En "Similares" se comparan productos de todas las cajas.
      if (prodChip !== 'similares' && productFilter !== 'all') {
        url += '?caja_id=' + encodeURIComponent(productFilter);
      }
      productListCache = await api(url);
      renderSalesStrip();
      renderProducts();
    } catch (e) { notice('No se pudieron cargar los productos: ' + e.message, true); }
  }

  async function openEdit(id) {
    try {
      var p = await api('/api/products/' + id);
    } catch (e) { notice(e.message, true); return; }
    $('edit-id').value = p.id;
    $('edit-desc').value = p.description;
    $('edit-caja').value = p.caja_id || '';
    $('edit-size-shoes').value = p.size_shoes || '';
    $('edit-size-shirts').value = p.size_shirts || '';
    $('edit-quantity').value = p.quantity || 1;
    $('edit-usd').value = p.purchase_usd;
    $('edit-cost').value = p.cost_lps;
    $('edit-sale').value = p.sale_lps;
    $('edit-discount').value = p.discount_pct || 0;
    $('edit-discount-lps').value = p.discount_lps || 0;
    $('edit-remove-photo').checked = false;
    var img = $('edit-photo-preview-img'), ph = document.querySelector('#edit-photo-preview .photo-placeholder');
    if (p.photo_url) {
      img.src = p.photo_url; img.classList.remove('hidden'); ph.classList.add('hidden');
    } else {
      img.src = ''; img.classList.add('hidden'); ph.classList.remove('hidden');
    }
    $('edit-error').classList.add('hidden');
    $('edit-modal').classList.remove('hidden');
  }

  async function delProduct(id) {
    if (!(await askConfirm('¿Eliminar este producto? Esta acción no se puede deshacer.'))) return;
    try {
      await api('/api/products/' + id, { method: 'DELETE' });
      notice('Producto eliminado.');
      loadProducts();
    } catch (e) { notice(e.message, true); }
  }

  /* ---------- foto: captura + vista previa ---------- */
  function wirePhotoPicker(inputId, previewId, imgId) {
    var input = $(inputId), preview = $(previewId), img = $(imgId);
    preview.addEventListener('click', function () { input.click(); });
    input.addEventListener('change', async function () {
      var file = input.files[0];
      if (!file) return;
      var fd = new FormData();
      fd.append('file', file);
      try {
        var r = await api('/api/upload', { method: 'POST', body: fd });
        input.setAttribute('data-upload-id', r.upload_id);
        img.src = r.url;
        img.classList.remove('hidden');
        preview.querySelector('.photo-placeholder').classList.add('hidden');
      } catch (e) { notice('No se pudo subir la foto: ' + e.message, true); }
    });
    return {
      getUploadId: function () { return input.getAttribute('data-upload-id') || ''; },
      reset: function () {
        input.value = ''; input.removeAttribute('data-upload-id');
        img.src = ''; img.classList.add('hidden');
        preview.querySelector('.photo-placeholder').classList.remove('hidden');
      }
    };
  }
  var addPhoto = wirePhotoPicker('add-photo', 'photo-preview', 'photo-preview-img');
  var editPhoto = wirePhotoPicker('edit-photo', 'edit-photo-preview', 'edit-photo-preview-img');

  /* ---------- Agregar producto: uno o varios del mismo diseño ---------- */
  var addMulti = false;

  function updateSaveLabel() {
    var btn = $('btn-save');
    if (!btn) return;
    if (addMulti) {
      var n = $('variant-list') ? $('variant-list').children.length : 0;
      btn.textContent = 'Guardar ' + n + ' producto' + (n === 1 ? '' : 's');
    } else {
      btn.textContent = 'Guardar producto';
    }
  }

  function addVariantRow() {
    var div = document.createElement('div');
    div.className = 'variant-row';
    div.innerHTML =
      '<input type="text" class="v-color" maxlength="40" placeholder="Color">' +
      '<input type="text" class="v-shoes" maxlength="40" placeholder="Talla zap.">' +
      '<input type="text" class="v-shirts" maxlength="40" placeholder="Talla cam.">' +
      '<input type="text" class="v-measures" maxlength="60" placeholder="Medidas">' +
      '<input type="number" class="v-qty" min="0" step="1" inputmode="numeric" placeholder="Cant." value="1">' +
      '<button type="button" class="v-del btn">✕</button>';
    div.querySelector('.v-del').addEventListener('click', function () {
      div.parentNode.removeChild(div);
      updateSaveLabel();
    });
    $('variant-list').appendChild(div);
    updateSaveLabel();
  }

  document.querySelectorAll('#add-mode-chips .pchip').forEach(function (c) {
    c.addEventListener('click', function () {
      document.querySelectorAll('#add-mode-chips .pchip').forEach(function (x) { x.classList.remove('active'); });
      c.classList.add('active');
      addMulti = c.getAttribute('data-m') === 'multi';
      $('variant-block').classList.toggle('hidden', !addMulti);
      $('add-single-sizes').classList.toggle('hidden', addMulti);
      if (addMulti && !$('variant-list').children.length) addVariantRow();
      updateSaveLabel();
    });
  });
  var variantAddBtn = $('variant-add');
  if (variantAddBtn) variantAddBtn.addEventListener('click', addVariantRow);

  /* Sube la foto de #add-photo y devuelve un upload_id fresco.
     (El upload_id se borra al usarse una vez, así que en modo multi
     hay que subir la foto de nuevo por cada variante.) */
  async function uploadFreshPhoto() {
    var input = $('add-photo');
    var file = input && input.files ? input.files[0] : null;
    if (!file) return '';
    var fd = new FormData();
    fd.append('file', file);
    var r = await api('/api/upload', { method: 'POST', body: fd });
    return r.upload_id || '';
  }

  $('add-form').addEventListener('submit', async function (e) {
    e.preventDefault();
    var err = $('add-error');
    err.classList.add('hidden');
    var common = {
      description: $('add-desc').value.trim(),
      caja_id: $('add-caja').value || undefined,
      purchase_usd: $('add-usd').value,
      cost_lps: $('add-cost').value,
      sale_lps: $('add-sale').value,
      discount_pct: $('add-discount').value,
      discount_lps: $('add-discount-lps').value
    };
    if (!common.description) { err.textContent = 'La descripción es obligatoria.'; err.classList.remove('hidden'); return; }

    if (!addMulti) {
      // ---- modo uno: lógica original intacta ----
      var body = {
        description: common.description,
        caja_id: common.caja_id,
        size_shoes: $('add-size-shoes').value.trim(),
        size_shirts: $('add-size-shirts').value.trim(),
        quantity: $('add-quantity').value,
        purchase_usd: common.purchase_usd,
        cost_lps: common.cost_lps,
        sale_lps: common.sale_lps,
        discount_pct: common.discount_pct,
        discount_lps: common.discount_lps,
        upload_id: addPhoto.getUploadId() || undefined
      };
      try {
        await api('/api/products', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        $('add-form').reset(); addPhoto.reset();
        notice('✅ Producto guardado.');
        loadProducts();
      } catch (e2) { err.textContent = e2.message; err.classList.remove('hidden'); }
      return;
    }

    // ---- modo multi: un producto por variante ----
    var variants = Array.prototype.map.call($('variant-list').children, function (div) {
      return {
        color: div.querySelector('.v-color').value.trim(),
        shoes: div.querySelector('.v-shoes').value.trim(),
        shirts: div.querySelector('.v-shirts').value.trim(),
        measures: div.querySelector('.v-measures').value.trim(),
        qty: div.querySelector('.v-qty').value || 1
      };
    }).filter(function (v) { return v.color || v.shoes || v.shirts || v.measures; });
    if (!variants.length) {
      err.textContent = 'Agrega al menos una variante con color, talla o medidas.';
      err.classList.remove('hidden');
      return;
    }
    var saved = 0;
    try {
      for (var i = 0; i < variants.length; i++) {
        var v = variants[i];
        var desc = common.description +
          (v.color ? ' ' + v.color : '') +
          (v.measures ? ' ' + v.measures : '');
        var uploadId = await uploadFreshPhoto();
        await api('/api/products', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            description: desc,
            caja_id: common.caja_id,
            size_shoes: v.shoes,
            size_shirts: v.shirts,
            quantity: v.qty,
            purchase_usd: common.purchase_usd,
            cost_lps: common.cost_lps,
            sale_lps: common.sale_lps,
            discount_pct: common.discount_pct,
        discount_lps: common.discount_lps,
            upload_id: uploadId || undefined
          })
        });
        saved++;
      }
      $('add-form').reset(); addPhoto.reset();
      $('variant-list').innerHTML = '';
      addVariantRow();
      notice('✅ ' + saved + ' productos guardados.');
      loadProducts();
    } catch (e2) {
      err.textContent = 'Se guardaron ' + saved + ' de ' + variants.length + ': ' + e2.message;
      err.classList.remove('hidden');
    }
  });

  /* ---------- Editar producto ---------- */
  async function openEdit(id) {
    try {
      var p = await api('/api/products/' + id);
    } catch (e) { notice(e.message, true); return; }
    $('edit-id').value = p.id;
    $('edit-desc').value = p.description;
    $('edit-caja').value = p.caja_id || '';
    $('edit-size-shoes').value = p.size_shoes || '';
    $('edit-size-shirts').value = p.size_shirts || '';
    $('edit-quantity').value = p.quantity || 1;
    $('edit-usd').value = p.purchase_usd;
    $('edit-cost').value = p.cost_lps;
    $('edit-sale').value = p.sale_lps;
    $('edit-discount').value = p.discount_pct || 0;
    $('edit-discount-lps').value = p.discount_lps || 0;
    $('edit-remove-photo').checked = false;
    var img = $('edit-photo-preview-img'), ph = document.querySelector('#edit-photo-preview .photo-placeholder');
    if (p.photo_url) {
      img.src = p.photo_url; img.classList.remove('hidden'); ph.classList.add('hidden');
    } else {
      img.src = ''; img.classList.add('hidden'); ph.classList.remove('hidden');
    }
    $('edit-error').classList.add('hidden');
    $('edit-modal').classList.remove('hidden');
  }
  $('edit-cancel').addEventListener('click', function () { $('edit-modal').classList.add('hidden'); });
  /* Modal de tipo de pérdida */
  $('lost-total-btn').addEventListener('click', function () {
    var id = lostChoiceId; closeLostChoice();
    if (id) toggleLost(id, 1);
  });
  $('lost-rec-btn').addEventListener('click', function () {
    var id = lostChoiceId; closeLostChoice();
    if (id) toggleLost(id, 2);
  });
  $('lost-cancel-btn').addEventListener('click', closeLostChoice);
  $('lost-modal').addEventListener('click', function (e) { if (e.target === $('lost-modal')) closeLostChoice(); });
  /* Descuento: % o monto fijo en L, excluyentes; al escribir en uno se limpia el otro. */
  function excluyeDescuento(pctId, lpsId) {
    var pct = $(pctId), lps = $(lpsId);
    pct.addEventListener('input', function () { if (Number(pct.value) > 0) lps.value = ''; });
    lps.addEventListener('input', function () { if (Number(lps.value) > 0) pct.value = ''; });
  }
  excluyeDescuento('add-discount', 'add-discount-lps');
  excluyeDescuento('edit-discount', 'edit-discount-lps');
  /* Modal de cobros */
  $('cobros-close').addEventListener('click', closeCobros);
  $('cobros-modal').addEventListener('click', function (e) { if (e.target === $('cobros-modal')) closeCobros(); });
  $('cobros-caja').addEventListener('change', loadCobros);
  $('cobros-list').addEventListener('click', async function (e) {
    var b = e.target && e.target.closest ? e.target.closest('.cobro-del') : null;
    if (!b) return;
    if (!confirm('¿Eliminar este cobro?')) return;
    try {
      await api('/api/cobros/' + b.getAttribute('data-id'), { method: 'DELETE' });
      loadCobros();
      loadSummary();
    } catch (err) { notice('No se pudo eliminar: ' + err.message, true); }
  });
  $('cobros-form').addEventListener('submit', async function (e) {
    e.preventDefault();
    var err = $('cobros-error');
    err.classList.add('hidden');
    var monto = Number($('cobro-monto').value) || 0;
    if (monto <= 0) { err.textContent = 'Escribe el monto recibido.'; err.classList.remove('hidden'); return; }
    var cajaId = $('cobros-caja').value;
    if (!cajaId) { err.textContent = 'Elige la caja.'; err.classList.remove('hidden'); return; }
    try {
      await api('/api/cobros', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          caja_id: Number(cajaId),
          amount_lps: monto,
          note: $('cobro-nota').value.trim(),
          fecha: $('cobro-fecha').value
        })
      });
      $('cobro-monto').value = '';
      $('cobro-nota').value = '';
      $('cobro-fecha').value = hoyISO();
      notice('💵 Cobro registrado.');
      loadCobros();
      loadSummary(); // refresca las tarjetas de Gráficas
    } catch (e2) { err.textContent = e2.message; err.classList.remove('hidden'); }
  });
  /* En "Similares", tocar el ⚠️ lleva al producto más caro del grupo. */
  $('product-list').addEventListener('click', function (e) {
    var b = e.target && e.target.closest ? e.target.closest('.sim-diff-btn') : null;
    if (!b) return;
    var card = document.querySelector('article.card[data-id="' + b.getAttribute('data-target') + '"]');
    if (!card) return;
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    card.classList.remove('flash');
    void card.offsetWidth; // reinicia la animación si se toca dos veces seguidas
    card.classList.add('flash');
    setTimeout(function () { card.classList.remove('flash'); }, 2400);
  });
  $('edit-modal').addEventListener('click', function (e) { if (e.target === $('edit-modal')) $('edit-modal').classList.add('hidden'); });

  $('edit-form').addEventListener('submit', async function (e) {
    e.preventDefault();
    var err = $('edit-error');
    err.classList.add('hidden');
    var id = $('edit-id').value;
    var body = {
      description: $('edit-desc').value.trim(),
      caja_id: $('edit-caja').value || undefined,
      size_shoes: $('edit-size-shoes').value.trim(),
      size_shirts: $('edit-size-shirts').value.trim(),
      quantity: $('edit-quantity').value,
      purchase_usd: $('edit-usd').value,
      cost_lps: $('edit-cost').value,
      sale_lps: $('edit-sale').value,
      discount_pct: $('edit-discount').value,
      discount_lps: $('edit-discount-lps').value,
      remove_photo: $('edit-remove-photo').checked
    };
    var up = editPhoto.getUploadId();
    if (up) body.upload_id = up;
    if (!body.description) { err.textContent = 'La descripción es obligatoria.'; err.classList.remove('hidden'); return; }
    try {
      await api('/api/products/' + id, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      $('edit-modal').classList.add('hidden');
      editPhoto.reset();
      notice('✅ Producto actualizado.');
      loadProducts();
    } catch (e2) { err.textContent = e2.message; err.classList.remove('hidden'); }
  });

  /* Crear / renombrar inversión desde la pestaña Productos */
  var invEditId = null;
  function resetInvForm() {
    invEditId = null;
    $('inv-create').classList.add('hidden');
    $('inv-name').value = '';
    $('inv-fecha-realizada').value = '';
    $('inv-fecha-entregada').value = '';
    $('inv-fecha-finalizada').value = '';
    $('inv-error').classList.add('hidden');
    $('inv-save').textContent = 'Crear';
  }
  function openInvCreate() {
    resetInvForm();
    $('inv-create').classList.remove('hidden');
    $('inv-name').focus();
    window.scrollTo(0, 0);
  }
  $('inv-cancel').addEventListener('click', resetInvForm);
  $('inv-save').addEventListener('click', async function () {
    var err = $('inv-error');
    err.classList.add('hidden');
    var name = $('inv-name').value.trim();
    if (!name) { err.textContent = 'Ponle un nombre a la inversión.'; err.classList.remove('hidden'); return; }
    var payload = {
      name: name,
      fecha_realizada: $('inv-fecha-realizada').value || '',
      fecha_entregada: $('inv-fecha-entregada').value || '',
      fecha_finalizada: $('inv-fecha-finalizada').value || ''
    };
    try {
      if (invEditId) {
        await api('/api/cajas/' + invEditId, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        notice('✅ Inversión actualizada.');
        resetInvForm();
        await loadCajas();
        followInvestment(productFilter);
        loadProducts();
        loadExpenses();
        return;
      }
      var c = await api('/api/cajas', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      resetInvForm();
      notice('✅ Inversión creada.');
      productFilter = String(c.id);
      await loadCajas();
      followInvestment(productFilter);
      loadProducts();
      loadExpenses();
    } catch (e) { err.textContent = e.message; err.classList.remove('hidden'); }
  });

  /* ---------- Gastos: filtro "Sin registrar" ---------- */
  var expChip = 'all'; // all | zero

  function setExpChip(f) {
    expChip = f;
    var chips = $('exp-filter-chips');
    if (chips) chips.querySelectorAll('.pchip').forEach(function (c) {
      c.classList.toggle('active', c.getAttribute('data-f') === f);
    });
    loadExpenses();
  }

  function resetExpChipSilent() {
    expChip = 'all';
    var chips = $('exp-filter-chips');
    if (chips) chips.querySelectorAll('.pchip').forEach(function (c) {
      c.classList.toggle('active', c.getAttribute('data-f') === 'all');
    });
  }

  async function loadExpenses() {
    var box = $('expense-list');
    try {
      var list = await api('/api/expenses');
      if (productFilter !== 'all') {
        list = list.filter(function (e) {
          return productFilter === 'none' ? !e.caja_id : String(e.caja_id) === String(productFilter);
        });
      }
      if (expChip === 'zero') {
        list = list.filter(function (e) {
          var isZero = !(Number(e.amount_usd) || 0) && !(Number(e.amount_lps) || 0);
          if (!isZero) return false;
          // El Tax de una caja exenta no cuenta como pendiente.
          if (/^tax$/i.test((e.name || '').trim()) && cajaExenta(e.caja_id, 'exenta_tax')) return false;
          return true;
        });
      }
      if (!list.length) {
        box.innerHTML = '<p class="hint">' + (productFilter === 'all'
          ? 'Aún no hay gastos. Agrega el primero abajo.'
          : 'Esta inversión aún no tiene gastos. Agrega el primero abajo.') + '</p>';
        return;
      }
      if (productFilter === 'all') {
        // Vista "Todas": una tarjeta por categoría que suma los montos de
        // todas las inversiones (primera, segunda, tercera y futuras).
        var groups = {}, order = [];
        list.forEach(function (e) {
          var key = (e.name || '').trim().toLowerCase();
          if (!groups[key]) { groups[key] = { name: (e.name || '').trim(), usd: 0, lps: 0 }; order.push(key); }
          groups[key].usd += Number(e.amount_usd) || 0;
          groups[key].lps += Number(e.amount_lps) || 0;
        });
        box.innerHTML = order.map(function (k) {
          var g = groups[k];
          return '<article class="card"><div class="card-body">' +
            '<h3 class="card-title">' + escapeHtml(g.name) + '</h3>' +
            '<p class="card-meta">🗂️ Suma de todas las inversiones</p>' +
            '<div class="nums">' +
            numRow('Monto en $', fmtD(g.usd), true) +
            numRow('Monto en LPS', fmtL(g.lps), true) +
            '</div></div></article>';
        }).join('');
        return;
      }
      box.innerHTML = list.map(function (e) {
        var meta = e.caja_name ? '<p class="card-meta">📁 ' + escapeHtml(e.caja_name) + '</p>' : '';
        var exBadge = (/^tax$/i.test((e.name || '').trim()) && cajaExenta(e.caja_id, 'exenta_tax'))
          ? ' <span class="sold-badge">EXENTO</span>' : '';
        return '<article class="card"><div class="card-body">' +
          '<h3 class="card-title">' + escapeHtml(e.name) + exBadge + '</h3>' + meta +
          '<div class="nums">' +
          numRow('Monto en $', fmtD(e.amount_usd)) +
          numRow('Monto en LPS', fmtL(e.amount_lps)) +
          '</div>' +
          '<div class="card-actions">' +
          '<button class="btn exp-edit" data-id="' + e.id + '">✏️ Editar</button>' +
          '<button class="btn danger exp-del" data-id="' + e.id + '">🗑️ Eliminar</button>' +
          '</div></div></article>';
      }).join('');
      box.querySelectorAll('.exp-edit').forEach(function (b) {
        b.addEventListener('click', function () { editExpense(Number(b.getAttribute('data-id'))); });
      });
      box.querySelectorAll('.exp-del').forEach(function (b) {
        b.addEventListener('click', function () { delExpense(Number(b.getAttribute('data-id'))); });
      });
    } catch (e) { notice('No se pudieron cargar los gastos: ' + e.message, true); }
  }

  async function editExpense(id) {
    var list = await api('/api/expenses');
    var e = list.find(function (x) { return x.id === id; });
    if (!e) return;
    $('expense-id').value = e.id;
    $('expense-name').value = e.name;
    $('expense-caja').value = e.caja_id || '';
    $('expense-usd').value = e.amount_usd;
    $('expense-lps').value = e.amount_lps;
    $('expense-error').classList.add('hidden');
    $('expense-modal').classList.remove('hidden');
  }

  $('expense-cancel').addEventListener('click', function () { $('expense-modal').classList.add('hidden'); });
  $('expense-modal').addEventListener('click', function (e) { if (e.target === $('expense-modal')) $('expense-modal').classList.add('hidden'); });
  $('expense-form').addEventListener('submit', async function (e) {
    e.preventDefault();
    var id = $('expense-id').value;
    var err = $('expense-error');
    err.classList.add('hidden');
    var name = $('expense-name').value.trim();
    if (!name) { err.textContent = 'El nombre del gasto es obligatorio.'; err.classList.remove('hidden'); return; }
    try {
      await api('/api/expenses/' + id, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name, caja_id: $('expense-caja').value || undefined, amount_usd: $('expense-usd').value, amount_lps: $('expense-lps').value })
      });
      $('expense-modal').classList.add('hidden');
      notice('✅ Gasto actualizado.');
      loadExpenses();
    } catch (e2) { err.textContent = e2.message; err.classList.remove('hidden'); }
  });

  async function delExpense(id) {
    if (!(await askConfirm('¿Eliminar este gasto?'))) return;
    try {
      await api('/api/expenses/' + id, { method: 'DELETE' });
      notice('Gasto eliminado.');
      loadExpenses();
    } catch (e) { notice(e.message, true); }
  }

  /* ---------- Gráficas (SVG puro, sin dependencias) ---------- */

  function legendHtml(rows) {
    return rows.map(function (r) {
      return '<div class="leg-row"><span class="sw" style="background:' + r.color + '"></span>' +
        '<span class="leg-label">' + escapeHtml(r.label) + '</span>' +
        '<span class="leg-val">' + r.amount +
        (r.pct !== undefined ? ' <em>(' + r.pct + '%)</em>' : '') + '</span></div>';
    }).join('');
  }

  function drawDonut(s) {
    var box = $('chart-donut'), leg = $('legend-donut');
    var inv = s.total_costo_lps || 0, prof = (s.total_venta_lps || 0) - inv;
    var total = inv + Math.max(prof, 0);
    if (total <= 0) {
      box.innerHTML = '<p class="hint">Aún no hay inventario con valor.</p>';
      leg.innerHTML = '';
      return;
    }
    var r = 62, circ = 2 * Math.PI * r;
    var invLen = inv / total * circ;
    box.innerHTML =
      '<svg viewBox="0 0 170 170" class="donut" role="img" aria-label="Inversión versus ganancia potencial">' +
      '<circle cx="85" cy="85" r="' + r + '" fill="none" stroke="#e5e7eb" stroke-width="28"/>' +
      '<circle cx="85" cy="85" r="' + r + '" fill="none" stroke="#0a2a5e" stroke-width="28"' +
      ' stroke-dasharray="' + invLen.toFixed(2) + ' ' + circ.toFixed(2) + '" transform="rotate(-90 85 85)"/>' +
      '<circle cx="85" cy="85" r="' + r + '" fill="none" stroke="#f0b429" stroke-width="28"' +
      ' stroke-dasharray="' + (circ - invLen).toFixed(2) + ' ' + circ.toFixed(2) + '"' +
      ' stroke-dashoffset="' + (-invLen).toFixed(2) + '" transform="rotate(-90 85 85)"/>' +
      '<text x="85" y="82" text-anchor="middle" class="donut-num">' + fmtL(total) + '</text>' +
      '<text x="85" y="100" text-anchor="middle" class="donut-lbl">Valor del inventario</text>' +
      '</svg>';
    leg.innerHTML = legendHtml([
      { color: '#0a2a5e', label: 'Inversión en productos', amount: fmtL(inv), pct: Math.round(inv / total * 100) },
      { color: '#f0b429', label: 'Ganancia potencial', amount: fmtL(prof), pct: Math.round(Math.max(prof, 0) / total * 100) }
    ]);
  }

  async function loadSummary() {
    var box = $('summary-cards');
    try {
      var url = '/api/summary';
      var cv = $('charts-caja') ? $('charts-caja').value : 'all';
      if (cv && cv !== 'all') url += '?caja_id=' + encodeURIComponent(cv);
      var s = await api(url);
      // Inversión = solo lo pagado en los productos (sin Tax/Envío);
      // la ganancia es el valor de venta menos esa inversión.
      var inversion = s.total_costo_lps || 0;
      var ganancia = (s.total_venta_lps || 0) - inversion;
      var margen = s.total_venta_lps > 0
        ? (ganancia / s.total_venta_lps * 100).toFixed(1) + '%'
        : '—';
      // Comisión: 45% tía Wendy y 55% Christian sobre la ganancia libre
      // (igual que en la Hoja: después de compra, Tax y Envío).
      var libre = s.ganancia_libre_total || 0;
      // Tax y Envío: suman lo pagado según los datos de la pestaña Gastos.
      var taxLps = 0, envLps = 0;
      (s.expenses || []).forEach(function (e) {
        var n = String(e.name || '').trim().toLowerCase();
        var v = Number(e.amount_lps) || 0;
        if (n === 'tax') taxLps += v;
        else if (n === 'envío' || n === 'envio') envLps += v;
      });
      box.innerHTML =
        profitCard('💰', 'Inversión en inventario', fmtL(inversion), 'productos') +
        profitCard('🏷️', 'Valor a precio de venta', fmtL(s.total_venta_lps), 'productos') +
        profitCard('📈', 'Ganancia potencial', fmtL(ganancia), 'hoja') +
        profitCard('🧾', 'Tax', fmtL(taxLps), 'gastos') +
        profitCard('🚚', 'Envío', fmtL(envLps), 'gastos') +
        profitCard('📊', 'Margen promedio', margen, 'hoja') +
        profitCard('🤝', 'Comisión tía Wendy (45%)', fmtL(libre * 0.45), 'hoja') +
        profitCard('👤', 'Christian (55%)', fmtL(libre * 0.55), 'hoja') +
        profitCard('📉', 'Pérdidas', negL(s.total_perdidas_lps), 'productos-lost') +
        profitCard('🔖', 'Descuentos (dejado de ganar)', negL(s.total_descuentos_lps), 'productos') +
        profitCard('💵', 'Cobrado', fmtL(s.total_cobrado_lps), 'cobros') +
        profitCard('📋', 'Falta por cobrar', fmtL(s.falta_por_cobrar_lps), 'cobros');
      drawDonut(s);
    } catch (e) { notice('No se pudo cargar el resumen: ' + e.message, true); }
    loadCompare();
    loadPending();
  }
  function switchTab(tab) {
    var btn = document.querySelector('.tabbtn[data-tab="' + tab + '"]');
    if (btn) btn.click();
  }
  function profitCard(ico, label, value, nav) {
    return '<button type="button" class="profit-card" data-nav="' + nav + '">' +
      '<span class="pc-ico">' + ico + '</span>' +
      '<span class="pc-label">' + label + '</span>' +
      '<span class="pc-value">' + value + '</span></button>';
  }

  /* Tocar un cuadro lleva a los datos de donde sale ese número,
     manteniendo la inversión seleccionada en Gráficas. */
  function gotoCard(nav) {
    var cv = ($('charts-caja') && $('charts-caja').value) || 'all';
    if (nav === 'cobros') { openCobros(); return; }
    if (nav === 'hoja') {
      var sc = $('sheet-caja');
      if (sc) sc.value = cv;
      switchTab('hoja');
      return;
    }
    productFilter = cv;
    prevBoxFilter = null; // la caja elegida en Gráficas manda sobre la anterior
    setProdChip(nav === 'productos-lost' ? 'lost' : 'all');
    resetExpChipSilent();
    switchTab(nav === 'gastos' ? 'gastos' : 'productos');
  }
  var summaryBox = $('summary-cards');
  if (summaryBox) summaryBox.addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('.profit-card') : null;
    if (b && b.getAttribute('data-nav')) gotoCard(b.getAttribute('data-nav'));
  });

  /* ---------- Comparar cajas ---------- */
  function cmpBar(label, val, max, color) {
    var pct = max > 0 ? Math.max(val, 0) / max * 100 : 0;
    return '<div class="cmp-bar"><span class="cmp-lbl">' + label + '</span>' +
      '<span class="cmp-track"><span class="cmp-fill" style="width:' + pct.toFixed(1) +
      '%;background:' + color + '"></span></span>' +
      '<span class="cmp-val">' + fmtL(val) + '</span></div>';
  }

  async function loadCompare() {
    var wrap = $('compare-box');
    if (!wrap) return;
    var cv = $('charts-caja') ? $('charts-caja').value : 'all';
    if (cv !== 'all' || !cajasCache.length) { wrap.classList.add('hidden'); return; }
    wrap.classList.remove('hidden');
    try {
      var rows = [];
      for (var i = 0; i < cajasCache.length; i++) {
        var s = await api('/api/summary?caja_id=' + cajasCache[i].id);
        rows.push({ name: cajasCache[i].name, inv: s.total_costo_lps || 0,
                    libre: s.ganancia_libre_total || 0 });
      }
      var max = 1;
      rows.forEach(function (r) { max = Math.max(max, r.inv, Math.max(r.libre, 0)); });
      $('compare-bars').innerHTML = rows.map(function (r) {
        return '<div class="cmp-row"><div class="cmp-name">📦 ' + escapeHtml(r.name) + '</div>' +
          cmpBar('Inversión', r.inv, max, '#0a2a5e') +
          cmpBar('Ganancia libre', r.libre, max, '#f0b429') + '</div>';
      }).join('');
    } catch (e) { $('compare-bars').innerHTML = '<p class="hint">No se pudo comparar.</p>'; }
  }

  /* ---------- Pendientes ---------- */
  async function loadPending() {
    var box = $('pending-rows');
    if (!box) return;
    try {
      var cv = $('charts-caja') ? $('charts-caja').value : 'all';
      var url = '/api/pending' + (cv && cv !== 'all' ? '?caja_id=' + encodeURIComponent(cv) : '');
      var p = await api(url);
      var rows = [
        { n: p.sin_foto, label: 'productos sin foto', tab: 'productos', chip: 'nophoto' },
        { n: p.sin_precio, label: 'productos sin precio de venta', tab: 'productos', chip: 'noprecio' },
        { n: p.gastos_pendientes, label: 'gastos sin registrar', tab: 'gastos', expZero: true }
      ].filter(function (r) { return r.n > 0; });
      if (!rows.length) {
        box.innerHTML = '<p class="hint">✅ Todo completo, sin pendientes.</p>';
        return;
      }
      box.innerHTML = rows.map(function (r, i) {
        return '<button type="button" class="pend-row" data-i="' + i + '">' +
          '<span class="pend-check"></span>' +
          '<span class="pend-label">' + r.n + ' ' + r.label + '</span>' +
          '<span class="pend-count">' + r.n + '</span>' +
          '<span class="pend-go">Completar →</span></button>';
      }).join('');
      box.querySelectorAll('.pend-row').forEach(function (b) {
        b.addEventListener('click', function () {
          var r = rows[Number(b.getAttribute('data-i'))];
          if (r.expZero) setExpChip('zero');
          else if (r.chip) { setExpChip('all'); setProdChip(r.chip); }
          switchTab(r.tab);
        });
      });
    } catch (e) { box.innerHTML = ''; }
  }

  /* ---------- Hoja ---------- */
  function fmtCell(v, isNum) {
    if (v === '' || v === null || v === undefined) return '<td></td>';
    if (isNum) return '<td class="num">' + Number(v).toLocaleString('es-HN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + '</td>';
    return '<td>' + escapeHtml(v) + '</td>';
  }

  function sheetTableHtml(sh) {
    var h = '<table class="sheet"><thead><tr>' + sh.columns.map(function (c) {
      return '<th>' + escapeHtml(c) + '</th>';
    }).join('') + '</tr></thead><tbody>';
    h += sh.rows.map(function (r) {
      return '<tr>' + r.map(function (v, i) { return fmtCell(v, i >= 1); }).join('') + '</tr>';
    }).join('');
    h += sh.summary_rows.map(function (r, idx) {
      var cls = idx === sh.summary_rows.length - 1 ? 'grand' : 'summary';
      return '<tr class="' + cls + '">' + r.map(function (v, i) { return fmtCell(v, i >= 1); }).join('') + '</tr>';
    }).join('');
    return h + '</tbody></table>';
  }

  async function loadSheet() {
    try {
      var cv = $('sheet-caja') ? $('sheet-caja').value : 'all';
      var url = '/api/sheet?caja_id=' + encodeURIComponent(cv || 'all');
      var s = await api(url);
      if (s.sheets) {
        // "Todas las cajas": una hoja por caja, colapsada; se expande al tocarla.
        $('sheet-wrap').innerHTML = s.sheets.map(function (sh) {
          var gan = '';
          for (var i = 0; i < sh.summary_rows.length; i++) {
            if (sh.summary_rows[i][0] === 'Total + envío' && sh.summary_rows[i][4] !== '') {
              gan = ' · ganancia ' + Number(sh.summary_rows[i][4]).toLocaleString('es-HN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
              break;
            }
          }
          return '<div class="sheet-card">' +
            '<button type="button" class="sheet-card-head">' +
            '<span class="sheet-card-name">📦 ' + escapeHtml(sh.caja_name) + '</span>' +
            '<span class="sheet-card-meta">' + sh.rows.length + ' productos' + gan + '</span>' +
            '<span class="chev">▼</span>' +
            '</button>' +
            '<div class="sheet-card-body hidden"><div class="table-scroll">' + sheetTableHtml(sh) + '</div></div>' +
            '</div>';
        }).join('');
        var heads = $('sheet-wrap').querySelectorAll('.sheet-card-head');
        for (var k = 0; k < heads.length; k++) {
          heads[k].addEventListener('click', function () {
            var body = this.parentNode.querySelector('.sheet-card-body');
            var chev = this.querySelector('.chev');
            var collapsed = body.classList.toggle('hidden');
            chev.textContent = collapsed ? '▼' : '▲';
          });
        }
      } else {
        $('sheet-wrap').innerHTML = '<table id="sheet-table" class="sheet">' +
          '<thead id="sheet-head"><tr>' + s.columns.map(function (c) {
            return '<th>' + escapeHtml(c) + '</th>';
          }).join('') + '</tr></thead>' +
          '<tbody id="sheet-body">' +
          s.rows.map(function (r) {
            return '<tr>' + r.map(function (v, i) { return fmtCell(v, i >= 1); }).join('') + '</tr>';
          }).join('') +
          s.summary_rows.map(function (r, idx) {
            var cls = idx === s.summary_rows.length - 1 ? 'grand' : 'summary';
            return '<tr class="' + cls + '">' + r.map(function (v, i) { return fmtCell(v, i >= 1); }).join('') + '</tr>';
          }).join('') +
          '</tbody></table>';
      }
    } catch (e) { notice('No se pudo cargar la hoja: ' + e.message, true); }
  }

  $('btn-print').addEventListener('click', function () { window.print(); });
  $('btn-csv').addEventListener('click', function () {
    var cv = $('sheet-caja') ? $('sheet-caja').value : 'all';
    window.location.href = '/api/sheet.csv?caja_id=' + encodeURIComponent(cv || 'all');
  });

  /* ---------- Compartir por WhatsApp ---------- */
  function selectedBoxName(selId) {
    var sel = $(selId);
    if (!sel) return 'Todas las inversiones';
    if (sel.value === 'all') return 'Todas las inversiones';
    if (sel.selectedOptions && sel.selectedOptions[0]) {
      return sel.selectedOptions[0].textContent.trim();
    }
    return 'Todas las inversiones';
  }
  function shareWhatsApp(text) {
    window.open('https://wa.me/?text=' + encodeURIComponent(text), '_blank');
  }

  var shareChartsBtn = $('btn-share-charts');
  if (shareChartsBtn) shareChartsBtn.addEventListener('click', async function () {
    try {
      var cv = $('charts-caja') ? $('charts-caja').value : 'all';
      var url = '/api/summary' + (cv && cv !== 'all' ? '?caja_id=' + encodeURIComponent(cv) : '');
      var s = await api(url);
      var inversion = s.total_costo_lps || 0;
      var venta = s.total_venta_lps || 0;
      var ganancia = venta - inversion;
      var margen = venta > 0 ? (ganancia / venta * 100).toFixed(1) + '%' : '—';
      var libre = s.ganancia_libre_total || 0;
      var lines = [
        '📦 Importaciones a Puerto Castilla',
        '📊 ' + selectedBoxName('charts-caja'),
        '',
        '💰 Inversión en inventario: ' + fmtL(inversion),
        '🏷️ Valor a precio de venta: ' + fmtL(venta),
        '📈 Ganancia potencial: ' + fmtL(ganancia),
        '📊 Margen promedio: ' + margen,
        '🤝 Comisión tía Wendy (45%): ' + fmtL(libre * 0.45),
        '👤 Christian (55%): ' + fmtL(libre * 0.55),
        '📉 Pérdidas: ' + fmtL(s.total_perdidas_lps || 0)
      ];
      shareWhatsApp(lines.join('\n'));
    } catch (e) { notice('No se pudo compartir: ' + e.message, true); }
  });

  function fmtSheetVal(v, prefix) {
    if (v === '' || v === null || v === undefined) return '';
    var n = Number(v);
    if (isNaN(n)) return '';
    return prefix + Math.abs(n).toLocaleString('es-HN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function sheetSummaryLine(r) {
    var vals = [
      fmtSheetVal(r[1], '$'), fmtSheetVal(r[2], 'L'),
      fmtSheetVal(r[3], 'L'), fmtSheetVal(r[4], 'L')
    ].filter(function (x) { return x !== ''; });
    return r[0] + (vals.length ? ': ' + vals.join(' · ') : '');
  }
  var shareSheetBtn = $('btn-share-sheet');
  if (shareSheetBtn) shareSheetBtn.addEventListener('click', async function () {
    try {
      var cv = $('sheet-caja') ? $('sheet-caja').value : 'all';
      var s = await api('/api/sheet?caja_id=' + encodeURIComponent(cv || 'all'));
      var out = ['📄 Hoja de cálculo — Importaciones a Puerto Castilla', ''];
      if (s.sheets) {
        // "Todas": por caja solo el resumen (los productos serían un mensaje gigante).
        s.sheets.forEach(function (sh) {
          out.push('📦 ' + sh.caja_name + ' (' + sh.rows.length + ' productos)');
          sh.summary_rows.forEach(function (r) { out.push(sheetSummaryLine(r)); });
          out.push('');
        });
      } else {
        var sh = { caja_name: selectedBoxName('sheet-caja'), rows: s.rows, summary_rows: s.summary_rows };
        out.push('📦 ' + sh.caja_name + ' (' + sh.rows.length + ' productos)');
        out.push('');
        sh.rows.forEach(function (r) {
          out.push('• ' + r[0] + ' — Pagado ' + fmtSheetVal(r[1], '$') + ' / ' +
            fmtSheetVal(r[2], 'L') + ' · Venta ' + fmtSheetVal(r[3], 'L') +
            ' · Ganancia ' + fmtSheetVal(r[4], 'L'));
        });
        out.push('');
        sh.summary_rows.forEach(function (r) { out.push(sheetSummaryLine(r)); });
      }
      shareWhatsApp(out.join('\n'));
    } catch (e) { notice('No se pudo compartir: ' + e.message, true); }
  });
  $('sheet-caja').addEventListener('change', loadSheet);
  $('charts-caja').addEventListener('change', loadSummary);

  /* ---------- inicio ---------- */
  loadCajas();
  loadProducts();
})();
