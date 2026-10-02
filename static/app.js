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

  /* ---------- Cajas (grupos por enviada) ---------- */
  var cajasCache = [];
  var productFilter = 'all'; // 'all' | 'none' | <id>

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
    if (keepValues) ['add-caja', 'edit-caja', 'exp-caja', 'expense-caja', 'sheet-caja', 'charts-caja'].forEach(function (id) {
      var el = $(id); if (el) keep[id] = el.value;
    });
    var sc = $('sheet-caja'), cc = $('charts-caja');
    if (sc) sc.innerHTML = '<option value="all">Todas las cajas</option>' + cajasCache.map(function (c) {
      return '<option value="' + c.id + '">' + escapeHtml(c.name) + '</option>';
    }).join('');
    if (cc) cc.innerHTML = sc ? sc.innerHTML : '';
    var ac = $('add-caja'); if (ac) ac.innerHTML = '<option value="">Sin inversión</option>' + cajaOptionsHTML('');
    var ec = $('edit-caja'); if (ec) ec.innerHTML = '<option value="">Sin inversión</option>' + cajaOptionsHTML('');
    var xc = $('exp-caja'); if (xc) xc.innerHTML = cajaOptionsHTML('', true);
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
    ['add-caja', 'exp-caja', 'sheet-caja', 'charts-caja'].forEach(function (sid) {
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
  function renderChips() {
    var boxes = [{ f: 'all', icon: '🗂️', name: 'Todas', sub: '' }];
    cajasCache.forEach(function (c) {
      boxes.push({
        f: String(c.id), icon: '📦', name: c.name,
        sub: c.n_products + ' prod.'
      });
    });
    boxes.push({ f: 'none', icon: '🏷️', name: 'Sin inversión', sub: '' });
    var h = boxes.map(function (b) {
      return '<button class="caja-box' + (String(productFilter) === b.f ? ' active' : '') +
        '" data-f="' + b.f + '">' +
        '<span class="caja-box-icon" aria-hidden="true">' + b.icon + '</span>' +
        '<span class="caja-box-name">' + escapeHtml(b.name) + '</span>' +
        (b.sub ? '<span class="caja-box-sub">' + escapeHtml(b.sub) + '</span>' : '') +
        '</button>';
    }).join('');
    ['caja-chips', 'expense-chips'].forEach(function (boxId) {
      var box = $(boxId);
      if (!box) return;
      box.innerHTML = h;
      box.querySelectorAll('.caja-box').forEach(function (btn) {
        btn.addEventListener('click', function () {
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
  }

  async function loadCajas() {
    try {
      cajasCache = await api('/api/cajas');
      renderChips();
      refreshCajaSelects(true);
      renderCajaList();
    } catch (e) { /* sin cajas no se bloquea nada */ }
  }

  function renderCajaList() {
    var box = $('caja-list');
    if (!box) return;
    box.innerHTML = cajasCache.map(function (c) {
      return '<div class="caja-item"><span class="caja-name">' + escapeHtml(c.name) + '</span>' +
        '<span class="caja-count">' + c.n_products + ' prod.</span>' +
        '<button class="btn caja-edit" data-id="' + c.id + '">✏️</button>' +
        '<button class="btn danger caja-del" data-id="' + c.id + '">🗑️</button></div>';
    }).join('') || '<p class="hint">Aún no hay inversiones. Toca &laquo;＋ Crear inversión&raquo; para empezar.</p>';
    box.querySelectorAll('.caja-edit').forEach(function (b) {
      b.addEventListener('click', function () { startEditCaja(Number(b.getAttribute('data-id'))); });
    });
    box.querySelectorAll('.caja-del').forEach(function (b) {
      b.addEventListener('click', function () { delCaja(Number(b.getAttribute('data-id'))); });
    });
  }

  function resetCajaForm() {
    $('caja-edit-id').value = '';
    $('caja-name').value = '';
    $('caja-exenta-fotos').checked = false;
    $('caja-exenta-tax').checked = false;
    $('caja-error').classList.add('hidden');
    $('caja-save').textContent = 'Guardar inversión';
    $('caja-cancel').classList.add('hidden');
  }

  function startEditCaja(id) {
    var c = cajasCache.find(function (x) { return x.id === id; });
    if (!c) return;
    $('caja-edit-id').value = c.id;
    $('caja-name').value = c.name;
    $('caja-exenta-fotos').checked = !!c.exenta_fotos;
    $('caja-exenta-tax').checked = !!c.exenta_tax;
    $('caja-save').textContent = 'Guardar cambios';
    $('caja-cancel').classList.remove('hidden');
    $('caja-name').focus();
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
    return '<article class="card" data-id="' + p.id + '">' +
      '<button type="button" class="card-toggle">' +
      '<span class="card-toggle-title">' + escapeHtml(p.description) +
      (p.sold ? '<span class="sold-badge">VENDIDO</span>' : '') +
      (p.lost ? '<span class="lost-badge">PÉRDIDA</span>' : '') + '</span>' +
      '<span class="chev">▼</span>' +
      '</button>' +
      '<div class="card-detail hidden">' + photo +
      '<div class="card-body">' + metaHtml +
      '<div class="nums">' +
      numRow('Precio compra $', fmtD(p.purchase_usd)) +
      numRow('Pagado en LPS', fmtL(p.cost_lps)) +
      numRow('Ganancia', fmtL(p.sale_lps)) +
      numRow('Ganancia libre', fmtL(p.ganancia_libre), true) +
      '</div>' +
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
  var prodChip = 'all'; // all | sold | pending | nophoto | noprecio | lost

  function filteredProducts() {
    var q = prodSearch.trim().toLowerCase();
    return productListCache.filter(function (p) {
      if (q && String(p.description || '').toLowerCase().indexOf(q) < 0) return false;
      if (prodChip === 'sold') return !!p.sold;
      if (prodChip === 'pending') return !p.sold && !p.lost;
      if (prodChip === 'nophoto') return !p.photo_url && !cajaExenta(p.caja_id, 'exenta_fotos');
      if (prodChip === 'noprecio') return !p.sale_lps;
      if (prodChip === 'lost') return !!p.lost;
      return true;
    });
  }

  function renderSalesStrip() {
    var strip = $('sales-strip');
    if (!strip) return;
    var v = productListCache.filter(function (p) { return p.sold; });
    var l = productListCache.filter(function (p) { return p.lost; });
    var real = v.reduce(function (a, p) { return a + (p.ganancia_libre || 0); }, 0);
    var perd = l.reduce(function (a, p) {
      return a + (Number(p.cost_lps) || 0) * (Number(p.quantity) || 1);
    }, 0);
    strip.innerHTML = '<span>Vendidos: <b>' + v.length + '</b></span> · ' +
      '<span>Pérdidas: <b>' + l.length + '</b></span> · ' +
      '<span>Pendientes: <b>' + (productListCache.length - v.length - l.length) + '</b></span> · ' +
      '<span>Ganancia real: <b>' + fmtL(real - perd) + '</b></span>';
    strip.classList.toggle('hidden', productListCache.length === 0);
  }

  function setProdChip(f) {
    prodChip = f;
    var chips = $('prod-chips');
    if (chips) chips.querySelectorAll('.pchip').forEach(function (c) {
      c.classList.toggle('active', c.getAttribute('data-f') === f);
    });
    renderProducts();
  }

  function renderProducts() {
    var box = $('product-list');
    if (!box) return;
    var list = filteredProducts();
    $('no-products').classList.toggle('hidden', list.length > 0);
    if (productFilter === 'all') {
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
        toggleLost(Number(b.getAttribute('data-id')), b.getAttribute('data-lost') !== '1');
      });
    });
  }

  /* Pinta botones e insignias de vendido/pérdida de una tarjeta en su lugar. */
  function paintStatus(card, p) {
    var sbtn = card.querySelector('.sold-btn');
    sbtn.setAttribute('data-sold', p.sold ? '1' : '0');
    sbtn.textContent = p.sold ? '↩ Quitar vendido' : '✓ Marcar como vendido';
    var lbtn = card.querySelector('.lost-btn');
    lbtn.setAttribute('data-lost', p.lost ? '1' : '0');
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
    if (p.lost && !lbadge) {
      var l = document.createElement('span');
      l.className = 'lost-badge';
      l.textContent = 'PÉRDIDA';
      title.appendChild(l);
    } else if (!p.lost && lbadge) {
      title.removeChild(lbadge);
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
      refreshCardStatus(id);
      notice(toLost ? '📉 Marcado como pérdida.' : '↩ Pérdida quitada.');
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
      if (productFilter !== 'all') url += '?caja_id=' + encodeURIComponent(productFilter);
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

  /* ---------- Agregar producto ---------- */
  $('add-form').addEventListener('submit', async function (e) {
    e.preventDefault();
    var err = $('add-error');
    err.classList.add('hidden');
    var body = {
      description: $('add-desc').value.trim(),
      caja_id: $('add-caja').value || undefined,
      size_shoes: $('add-size-shoes').value.trim(),
      size_shirts: $('add-size-shirts').value.trim(),
      quantity: $('add-quantity').value,
      purchase_usd: $('add-usd').value,
      cost_lps: $('add-cost').value,
      sale_lps: $('add-sale').value,
      upload_id: addPhoto.getUploadId() || undefined
    };
    if (!body.description) { err.textContent = 'La descripción es obligatoria.'; err.classList.remove('hidden'); return; }
    try {
      await api('/api/products', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      $('add-form').reset(); addPhoto.reset();
      notice('✅ Producto guardado.');
      loadProducts();
    } catch (e2) { err.textContent = e2.message; err.classList.remove('hidden'); }
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

  /* ---------- Gastos ---------- */
  $('caja-save').addEventListener('click', async function () {
    var err = $('caja-error');
    err.classList.add('hidden');
    var name = $('caja-name').value.trim();
    var editId = $('caja-edit-id').value;
    if (!name) { err.textContent = 'El nombre de la inversión es obligatorio.'; err.classList.remove('hidden'); return; }
    try {
      var flags = {
        exenta_fotos: $('caja-exenta-fotos').checked ? 1 : 0,
        exenta_tax: $('caja-exenta-tax').checked ? 1 : 0
      };
      if (editId) {
        await api('/api/cajas/' + editId, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: name, exenta_fotos: flags.exenta_fotos, exenta_tax: flags.exenta_tax })
        });
        notice('✅ Inversión actualizada.');
      } else {
        var nc = await api('/api/cajas', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: name, exenta_fotos: flags.exenta_fotos, exenta_tax: flags.exenta_tax })
        });
        notice('✅ Inversión creada.');
        productFilter = String(nc.id);
      }
      resetCajaForm();
      await loadCajas();
      followInvestment(productFilter);
      loadProducts();
      loadExpenses();
    } catch (e) { err.textContent = e.message; err.classList.remove('hidden'); }
  });
  $('caja-cancel').addEventListener('click', resetCajaForm);

  /* Crear inversión rápido desde la pestaña Productos */
  $('btn-new-inversion').addEventListener('click', function () {
    var f = $('inv-create');
    f.classList.toggle('hidden');
    if (!f.classList.contains('hidden')) $('inv-name').focus();
  });
  $('inv-cancel').addEventListener('click', function () {
    $('inv-create').classList.add('hidden');
    $('inv-name').value = '';
    $('inv-error').classList.add('hidden');
  });
  $('inv-save').addEventListener('click', async function () {
    var err = $('inv-error');
    err.classList.add('hidden');
    var name = $('inv-name').value.trim();
    if (!name) { err.textContent = 'Ponle un nombre a la inversión.'; err.classList.remove('hidden'); return; }
    try {
      var c = await api('/api/cajas', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name })
      });
      $('inv-create').classList.add('hidden');
      $('inv-name').value = '';
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

  $('add-expense-form').addEventListener('submit', async function (e) {
    e.preventDefault();
    var err = $('exp-error');
    err.classList.add('hidden');
    var body = {
      name: $('exp-name').value.trim(),
      caja_id: $('exp-caja').value || undefined,
      amount_usd: $('exp-usd').value,
      amount_lps: $('exp-lps').value
    };
    if (!body.name) { err.textContent = 'El nombre del gasto es obligatorio.'; err.classList.remove('hidden'); return; }
    try {
      await api('/api/expenses', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      $('add-expense-form').reset();
      notice('✅ Gasto guardado.');
      loadExpenses();
    } catch (e2) { err.textContent = e2.message; err.classList.remove('hidden'); }
  });

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
      box.innerHTML =
        profitCard('💰', 'Inversión en inventario', fmtL(inversion)) +
        profitCard('🏷️', 'Valor a precio de venta', fmtL(s.total_venta_lps)) +
        profitCard('📈', 'Ganancia potencial', fmtL(ganancia)) +
        profitCard('📊', 'Margen promedio', margen) +
        profitCard('🤝', 'Comisión tía Wendy (45%)', fmtL(libre * 0.45)) +
        profitCard('👤', 'Christian (55%)', fmtL(libre * 0.55)) +
        profitCard('📉', 'Pérdidas', fmtL(s.total_perdidas_lps || 0));
      drawDonut(s);
    } catch (e) { notice('No se pudo cargar el resumen: ' + e.message, true); }
    loadCompare();
    loadPending();
  }
  function switchTab(tab) {
    var btn = document.querySelector('.tabbtn[data-tab="' + tab + '"]');
    if (btn) btn.click();
  }
  function profitCard(ico, label, value) {
    return '<div class="profit-card"><span class="pc-ico">' + ico + '</span>' +
      '<span class="pc-label">' + label + '</span>' +
      '<span class="pc-value">' + value + '</span></div>';
  }

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
  $('sheet-caja').addEventListener('change', loadSheet);
  $('charts-caja').addEventListener('change', loadSummary);

  /* ---------- inicio ---------- */
  loadCajas();
  loadProducts();
})();
