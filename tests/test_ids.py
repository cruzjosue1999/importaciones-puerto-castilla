"""Regresión: todo id que el JS busca con $('...') debe existir en el HTML.

El 2026-10-01 el botón "Guardar producto" moría en silencio porque el JS
leía $('add-quantity') pero el input tenía id="add-qty" (y lo mismo con
edit-quantity). Esta prueba lo detecta antes de publicar.
"""
import os
import re

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Solo literales: $('mi-id') o $("mi-id"). Las concatenaciones dinámicas
# como $('tab-' + tab) no se verifican aquí.
JS_ID_RE = re.compile(r"""\$\(\s*['"]([A-Za-z0-9_-]+)['"]\s*\)""")
HTML_ID_RE = re.compile(r"""\sid="([A-Za-z0-9_-]+)\"""")


def test_js_ids_existen_en_html():
    with open(os.path.join(BASE, "static", "app.js"), encoding="utf-8") as f:
        js = f.read()
    with open(os.path.join(BASE, "templates", "index.html"), encoding="utf-8") as f:
        html = f.read()
    usados = set(JS_ID_RE.findall(js))
    definidos = set(HTML_ID_RE.findall(html))
    # IDs creados dinámicamente en el JS (no están en el HTML estático).
    dinamicos = {"ptr-indicator"}
    faltantes = sorted(u for u in usados if u not in definidos and u not in dinamicos)
    assert not faltantes, "IDs usados en app.js pero ausentes en index.html: %s" % faltantes
