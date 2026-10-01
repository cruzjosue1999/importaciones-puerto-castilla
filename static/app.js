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
    $('caja-error').classList.add('hidden');
    $('caja-save').textContent = 'Guardar inversión';
    $('caja-cancel').classList.add('hidden');
  }

  function startEditCaja(id) {
    var c = cajasCache.find(function (x) { return x.id === id; });
    if (!c) return;
    $('caja-edit-id').value = c.id;
    $('caja-name').value = c.name;
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

  /* ---------- Productos ---------- */
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
      '<span class="card-toggle-title">' + escapeHtml(p.description) + '</span>' +
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

  async function loadProducts() {
    var box = $('product-list');
    try {
      var url = '/api/products';
      if (productFilter !== 'all') url += '?caja_id=' + encodeURIComponent(productFilter);
      var list = await api(url);
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
        box.innerHTML = groups.map(function (g) { return productGroup(g.name, g.items); }).join('');
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
    } catch (e) { notice('No se pudieron cargar los productos: ' + e.message, true); }
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
      if (editId) {
        await api('/api/cajas/' + editId, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: name })
        });
        notice('✅ Inversión actualizada.');
      } else {
        var nc = await api('/api/cajas', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: name })
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

  async function loadExpenses() {
    var box = $('expense-list');
    try {
      var list = await api('/api/expenses');
      if (productFilter !== 'all') {
        list = list.filter(function (e) {
          return productFilter === 'none' ? !e.caja_id : String(e.caja_id) === String(productFilter);
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
        return '<article class="card"><div class="card-body">' +
          '<h3 class="card-title">' + escapeHtml(e.name) + '</h3>' + meta +
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
  var PIE_COLORS = ['#0a2a5e', '#c1121f', '#f0b429', '#1e4fa3', '#e05252',
                    '#f5c95c', '#06204a', '#8f0d16', '#b98a1f'];

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

  function piePath(cx, cy, r, a0, a1) {
    var x0 = (cx + r * Math.cos(a0)).toFixed(2), y0 = (cy + r * Math.sin(a0)).toFixed(2);
    var x1 = (cx + r * Math.cos(a1)).toFixed(2), y1 = (cy + r * Math.sin(a1)).toFixed(2);
    var large = (a1 - a0) > Math.PI ? 1 : 0;
    return 'M' + cx + ',' + cy + ' L' + x0 + ',' + y0 +
      ' A' + r + ',' + r + ' 0 ' + large + ' 1 ' + x1 + ',' + y1 + ' Z';
  }

  function drawPie(s) {
    var box = $('chart-pie'), leg = $('legend-pie');
    var items = (s.by_product || []).filter(function (p) { return p.ganancia_libre > 0; });
    var total = items.reduce(function (a, p) { return a + p.ganancia_libre; }, 0);
    if (!items.length || total <= 0) {
      box.innerHTML = '<p class="hint">Registra productos con precio de venta para ver la ganancia por producto.</p>';
      leg.innerHTML = '';
      return;
    }
    var top = items.slice(0, 8);
    var rest = items.slice(8).reduce(function (a, p) { return a + p.ganancia_libre; }, 0);
    var slices = top.map(function (p) { return { label: p.name, value: p.ganancia_libre }; });
    if (rest > 0) slices.push({ label: 'Otros', value: rest });
    var a = -Math.PI / 2, cx = 85, cy = 85, r = 72;
    var paths = slices.map(function (sl, i) {
      var a1 = a + sl.value / total * 2 * Math.PI;
      var d = piePath(cx, cy, r, a, a1);
      a = a1;
      return '<path d="' + d + '" fill="' + PIE_COLORS[i % PIE_COLORS.length] + '"/>';
    }).join('');
    box.innerHTML = '<svg viewBox="0 0 170 170" class="pie" role="img" aria-label="Ganancia libre por producto">' + paths + '</svg>';
    leg.innerHTML = legendHtml(slices.map(function (sl, i) {
      return { color: PIE_COLORS[i % PIE_COLORS.length], label: sl.label, amount: fmtL(sl.value), pct: Math.round(sl.value / total * 100) };
    }));
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
      box.innerHTML =
        profitCard('💰', 'Inversión en inventario', fmtL(inversion)) +
        profitCard('🏷️', 'Valor a precio de venta', fmtL(s.total_venta_lps)) +
        profitCard('📈', 'Ganancia potencial', fmtL(ganancia)) +
        profitCard('📊', 'Margen promedio', margen);
      drawDonut(s);
      drawPie(s);
    } catch (e) { notice('No se pudo cargar el resumen: ' + e.message, true); }
  }
  function profitCard(ico, label, value) {
    return '<div class="profit-card"><span class="pc-ico">' + ico + '</span>' +
      '<span class="pc-label">' + label + '</span>' +
      '<span class="pc-value">' + value + '</span></div>';
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
            '<div class="sheet-card-body hidden">' + sheetTableHtml(sh) + '</div>' +
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
