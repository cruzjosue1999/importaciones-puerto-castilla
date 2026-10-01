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

  /* ---------- confirmación propia (el confirm() del navegador no funciona en la app de iOS) ---------- */ function askConfirm(msg, yesLabel) { return new Promise(function (resolve) { var m = $('confirm-modal'); $('confirm-msg').textContent = msg; $('confirm-yes').textContent = yesLabel || 'Sí, eliminar'; m.classList.remove('hidden'); function done(val) { m.classList.add('hidden'); $('confirm-yes').removeEventListener('click', onYes); $('confirm-no').removeEventListener('click', onNo); m.removeEventListener('click', onBg); resolve(val); } function onYes() { done(true); } function onNo() { done(false); } function onBg(e) { if (e.target === m) done(false); } $('confirm-yes').addEventListener('click', onYes); $('confirm-no').addEventListener('click', onNo); m.addEventListener('click', onBg); }); } /* ---------- navegación por pestañas ---------- */
  var tabLoaders = { graficas: loadSummary, hoja: loadSheet, productos: loadProducts, gastos: loadExpenses };
  document.querySelectorAll('.tabbtn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      document.querySelectorAll('.tabbtn').forEach(function (b) { b.classList.remove('active'); });
      document.querySelectorAll('.tab').forEach(function (t) { t.classList.remove('active'); });
      btn.classList.add('active');
      var tab = btn.getAttribute('data-tab');
      $('tab-' + tab).classList.add('active');
      if (tabLoaders[tab]) tabLoaders[tab]();
      window.scrollTo(0, 0);
    });
  });

  /* ---------- Productos ---------- */
  function productCard(p) {
    var photo = p.photo_url
      ? '<img class="card-photo" src="' + escapeHtml(p.photo_url) + '" alt="Foto de ' + escapeHtml(p.description) + '" loading="lazy">'
      : '<div class="card-photo placeholder">📦</div>';
    return '<article class="card" data-id="' + p.id + '">' + photo +
      '<div class="card-body">' +
      '<h3 class="card-title">' + escapeHtml(p.description) + '</h3>' +
      '<div class="nums">' +
      numRow('Precio compra $', fmtD(p.purchase_usd)) +
      numRow('Pagado en LPS', fmtL(p.cost_lps)) +
      numRow('Ganancia', fmtL(p.sale_lps)) +
      numRow('Ganancia libre', fmtL(p.ganancia_libre), true) +
      '</div>' +
      '<div class="card-actions">' +
      '<button class="btn edit-btn" data-id="' + p.id + '">✏️ Editar</button>' +
      '<button class="btn danger del-btn" data-id="' + p.id + '">🗑️ Eliminar</button>' +
      '</div></div></article>';
  }
  function numRow(label, value, isTotal) {
    return '<div class="num-row' + (isTotal ? ' total' : '') + '">' +
      '<span class="lbl">' + label + '</span><span class="val">' + value + '</span></div>';
  }

  async function loadProducts() {
    var box = $('product-list');
    try {
      var list = await api('/api/products');
      $('no-products').classList.toggle('hidden', list.length > 0);
      box.innerHTML = list.map(productCard).join('');
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

  /* ---------- Gastos ---------- */ async function editExpense(id) { var list = await api('/api/expenses'); var e = list.find(function (x) { return x.id === id; }); if (!e) return; $('expense-id').value = e.id; $('expense-name').value = e.name; $('expense-usd').value = e.amount_usd; $('expense-lps').value = e.amount_lps; $('expense-error').classList.add('hidden'); $('expense-modal').classList.remove('hidden'); } $('expense-cancel').addEventListener('click', function () { $('expense-modal').classList.add('hidden'); }); $('expense-modal').addEventListener('click', function (e) { if (e.target === $('expense-modal')) $('expense-modal').classList.add('hidden'); }); $('expense-form').addEventListener('submit', async function (e) { e.preventDefault(); var id = $('expense-id').value; var err = $('expense-error'); err.classList.add('hidden'); var name = $('expense-name').value.trim(); if (!name) { err.textContent = 'El nombre del gasto es obligatorio.'; err.classList.remove('hidden'); return; } try { await api('/api/expenses/' + id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name, amount_usd: $('expense-usd').value, amount_lps: $('expense-lps').value }) }); $('expense-modal').classList.add('hidden'); notice('✅ Gasto actualizado.'); loadExpenses(); } catch (e2) { err.textContent = e2.message; err.classList.remove('hidden'); } }); async function delExpense(id) { if (!(await askConfirm('¿Eliminar este gasto?'))) return; try { await api('/api/expenses/' + id, { method: 'DELETE' }); notice('Gasto eliminado.'); loadExpenses(); } catch (e) { notice(e.message, true); } }
  async function loadExpenses() {
    var box = $('expense-list');
    try {
      var list = await api('/api/expenses');
      box.innerHTML = list.map(function (e) {
        return '<article class="card"><div class="card-body">' +
          '<h3 class="card-title">' + escapeHtml(e.name) + '</h3>' +
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

  async function editExpense_OLD(id) {
    var list = await api('/api/expenses');
    var e = list.find(function (x) { return x.id === id; });
    if (!e) return;
    var name = prompt('Nombre del gasto:', e.name);
    if (name === null) return;
    name = name.trim();
    if (!name) { notice('El nombre es obligatorio.', true); return; }
    var usd = prompt('Monto en $:', e.amount_usd);
    if (usd === null) return;
    var lps = prompt('Monto en LPS:', e.amount_lps);
    if (lps === null) return;
    try {
      await api('/api/expenses/' + id, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name, amount_usd: usd, amount_lps: lps })
      });
      notice('✅ Gasto actualizado.');
      loadExpenses();
    } catch (err) { notice(err.message, true); }
  }

  async function delExpense_OLD(id) {
    if (!confirm('¿Eliminar este gasto?')) return;
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
    var inv = s.inversion_total_lps, prof = s.ganancia_libre_total;
    var total = inv + Math.max(prof, 0);
    if (total <= 0) {
      box.innerHTML = '<p class="hint">Aún no hay inventario con valor.</p>';
      leg.innerHTML = '';
      return;
    }
    var r = 62, circ = 2 * Math.PI * r;
    var invLen = inv / total * circ;
    box.innerHTML =
      '<svg viewBox="0 0 170 170" class="donut" role="img" aria-label="Inversión versus ganancia libre">' +
      '<circle cx="85" cy="85" r="' + r + '" fill="none" stroke="#e5e7eb" stroke-width="28"/>' +
      '<circle cx="85" cy="85" r="' + r + '" fill="none" stroke="#0a2a5e" stroke-width="28"' +
      ' stroke-dasharray="' + invLen.toFixed(2) + ' ' + circ.toFixed(2) + '" transform="rotate(-90 85 85)"/>' +
      '<circle cx="85" cy="85" r="' + r + '" fill="none" stroke="#f0b429" stroke-width="28"' +
      ' stroke-dasharray="' + (circ - invLen).toFixed(2) + ' ' + circ.toFixed(2) + '"' +
      ' stroke-dashoffset="' + (-invLen).toFixed(2) + '" transform="rotate(-90 85 85)"/>' +
      '<text x="85" y="82" text-anchor="middle" class="donut-num">' + fmtL(total) + '</text>' +
      '<text x="85" y="100" text-anchor="middle" class="donut-lbl">valor del inventario</text>' +
      '</svg>';
    leg.innerHTML = legendHtml([
      { color: '#0a2a5e', label: 'Inversión (costos + gastos)', amount: fmtL(inv), pct: Math.round(inv / total * 100) },
      { color: '#f0b429', label: 'Ganancia libre', amount: fmtL(prof), pct: Math.round(Math.max(prof, 0) / total * 100) }
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
      var s = await api('/api/summary');
      box.innerHTML =
        profitCard('💰', 'Inversión total', fmtL(s.inversion_total_lps)) +
        profitCard('🏷️', 'Valor a precio de venta', fmtL(s.total_venta_lps)) +
        profitCard('📈', 'Ganancia libre', fmtL(s.ganancia_libre_total)) +
        profitCard('📦', 'Productos', s.n_products);
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

  async function loadSheet() {
    try {
      var s = await api('/api/sheet');
      $('sheet-head').innerHTML = '<tr>' + s.columns.map(function (c) {
        return '<th>' + escapeHtml(c) + '</th>';
      }).join('') + '</tr>';
      var html = s.rows.map(function (r) {
        return '<tr>' + r.map(function (v, i) { return fmtCell(v, i > 0); }).join('') + '</tr>';
      }).join('');
      html += s.summary_rows.map(function (r, idx) {
        var cls = idx === s.summary_rows.length - 1 ? 'grand' : 'summary';
        return '<tr class="' + cls + '">' + r.map(function (v, i) { return fmtCell(v, i > 0); }).join('') + '</tr>';
      }).join('');
      $('sheet-body').innerHTML = html;
    } catch (e) { notice('No se pudo cargar la hoja: ' + e.message, true); }
  }

  $('btn-print').addEventListener('click', function () { window.print(); });
  $('btn-csv').addEventListener('click', function () { window.location.href = '/api/sheet.csv'; });

  /* ---------- inicio ---------- */
  loadProducts();
})();
