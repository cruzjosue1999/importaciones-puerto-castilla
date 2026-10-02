"""Pruebas de Importaciones a Puerto Castilla: CRUD, fotos, matemáticas,
hoja, CSV y persistencia de la base de datos."""
import io
import os
import sys
import tempfile

import pytest

TMP = tempfile.mkdtemp(prefix="inv_test_")
os.environ["INVENTARIO_DB_PATH"] = os.path.join(TMP, "test.db")

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import app as appmod  # noqa: E402
from app import app, init_db  # noqa: E402


@pytest.fixture()
def client():
    app.config["TESTING"] = True
    init_db()
    with app.test_client() as c:
        yield c


def _make_png(w=100, h=100, color=(200, 30, 30)):
    from PIL import Image
    img = Image.new("RGB", (w, h), color)
    buf = io.BytesIO()
    img.save(buf, "PNG")
    buf.seek(0)
    return buf


# ---------- productos ----------

def test_create_and_get_product(client):
    r = client.post("/api/products", json={
        "description": "Zapatos nautica 9.5", "purchase_usd": 29.99,
        "cost_lps": 801.03, "sale_lps": 1000,
    })
    assert r.status_code == 201, r.get_json()
    pid = r.get_json()["id"]
    r = client.get(f"/api/products/{pid}")
    assert r.status_code == 200
    p = r.get_json()
    assert p["description"] == "Zapatos nautica 9.5"
    assert p["purchase_usd"] == 29.99
    assert p["ganancia_libre"] == pytest.approx(1000 - 801.03)
    assert p["photo_url"] is None


def test_create_requires_description(client):
    r = client.post("/api/products", json={"purchase_usd": 5})
    assert r.status_code == 400


def test_create_rejects_negative(client):
    r = client.post("/api/products", json={"description": "X", "cost_lps": -1})
    assert r.status_code == 400


def test_update_product(client):
    pid = client.post("/api/products", json={"description": "A", "sale_lps": 500}).get_json()["id"]
    r = client.put(f"/api/products/{pid}", json={"description": "A editado", "sale_lps": 600})
    assert r.status_code == 200
    p = client.get(f"/api/products/{pid}").get_json()
    assert p["description"] == "A editado"
    assert p["ganancia_libre"] == pytest.approx(600)


def test_delete_product(client):
    pid = client.post("/api/products", json={"description": "Borrar"}).get_json()["id"]
    assert client.delete(f"/api/products/{pid}").status_code == 200
    assert client.get(f"/api/products/{pid}").status_code == 404


# ---------- fotos ----------

def test_photo_upload_and_resize(client):
    big = _make_png(2000, 1200)
    r = client.post("/api/upload", data={"file": (big, "foto.png")},
                    content_type="multipart/form-data")
    assert r.status_code == 201, r.get_json()
    uid = r.get_json()["upload_id"]
    # vista previa
    r = client.get(f"/api/photo/pending/{uid}")
    assert r.status_code == 200
    assert r.content_type == "image/jpeg"
    from PIL import Image
    img = Image.open(io.BytesIO(r.data))
    assert max(img.size) <= 1600  # se redujo


def test_photo_upload_rejects_non_image(client):
    r = client.post("/api/upload", data={"file": (io.BytesIO(b"no es imagen"), "x.png")},
                    content_type="multipart/form-data")
    assert r.status_code == 400


def test_create_product_with_photo_multipart(client):
    r = client.post("/api/products",
                    data={"description": "Con foto", "sale_lps": 700,
                          "file": (_make_png(), "foto.png")},
                    content_type="multipart/form-data")
    assert r.status_code == 201, r.get_json()
    pid = r.get_json()["id"]
    p = client.get(f"/api/products/{pid}").get_json()
    assert p["photo_url"] == f"/api/photo/{pid}"
    r = client.get(f"/api/photo/{pid}")
    assert r.status_code == 200
    assert r.content_type.startswith("image/")


def test_update_remove_photo(client):
    pid = client.post("/api/products",
                      data={"description": "Foto", "file": (_make_png(), "f.png")},
                      content_type="multipart/form-data").get_json()["id"]
    assert client.get(f"/api/products/{pid}").get_json()["photo_url"] is not None
    r = client.put(f"/api/products/{pid}",
                   json={"description": "Foto", "remove_photo": True})
    assert r.status_code == 200
    assert client.get(f"/api/products/{pid}").get_json()["photo_url"] is None


# ---------- gastos y matemáticas ----------

def _clean_products(client):
    for p in client.get("/api/products").get_json():
        client.delete(f"/api/products/{p['id']}")


def _clean_expenses(client):
    for e in client.get("/api/expenses").get_json():
        client.delete(f"/api/expenses/{e['id']}")


def test_expenses_seeded(client):
    names = [e["name"] for e in client.get("/api/expenses").get_json()]
    assert "Tax" in names and "Envío" in names


def test_summary_math_with_expenses(client):
    _clean_products(client)
    client.post("/api/products", json={"description": "A", "purchase_usd": 20, "cost_lps": 534.2, "sale_lps": 700})
    client.post("/api/products", json={"description": "B", "purchase_usd": 9.99, "cost_lps": 266.83, "sale_lps": 500})
    # fijar gastos: Tax 219.81 / 5871.13 y Envío 200 / 5308
    for e in client.get("/api/expenses").get_json():
        if e["name"] == "Tax":
            client.put(f"/api/expenses/{e['id']}", json={"name": "Tax", "amount_usd": 219.81, "amount_lps": 5871.13})
        elif e["name"] == "Envío":
            client.put(f"/api/expenses/{e['id']}", json={"name": "Envío", "amount_usd": 200, "amount_lps": 5308})
    s = client.get("/api/summary").get_json()
    assert s["n_products"] == 2
    assert s["total_usd"] == pytest.approx(29.99)
    assert s["total_costo_lps"] == pytest.approx(534.2 + 266.83)
    assert s["total_venta_lps"] == pytest.approx(1200)
    # inversión = costos + gastos LPS
    assert s["inversion_total_lps"] == pytest.approx(534.2 + 266.83 + 5871.13 + 5308)
    # ganancia libre = venta - inversión
    assert s["ganancia_libre_total"] == pytest.approx(1200 - (534.2 + 266.83 + 5871.13 + 5308))
    # top para la gráfica de pastel (ordenado por ganancia libre desc: B=233.17 > A=165.8)
    assert s["by_product"][0]["name"] == "B"
    assert s["by_product"][0]["ganancia_libre"] == pytest.approx(500 - 266.83)
    assert s["by_product"][1]["name"] == "A"


def test_expense_crud(client):
    r = client.post("/api/expenses", json={"name": "Flete", "amount_usd": 50, "amount_lps": 1300})
    assert r.status_code == 201
    eid = r.get_json()["id"]
    r = client.put(f"/api/expenses/{eid}", json={"name": "Flete", "amount_usd": 60, "amount_lps": 1500})
    assert r.status_code == 200
    assert client.delete(f"/api/expenses/{eid}").status_code == 200


# ---------- hoja y CSV ----------

def test_sheet_mirrors_spreadsheet(client):
    _clean_products(client)
    client.post("/api/products", json={"description": "Multi for him 150 ct",
                                       "purchase_usd": 20, "cost_lps": 534.2, "sale_lps": 700})
    s = client.get("/api/sheet").get_json()
    assert s["columns"] == ["Describcion",
                            "Total pagado $$", "Pagado en LPS",
                            "Ingresos", "Ganancia libre"]
    assert len(s["rows"]) == 1
    row = s["rows"][0]
    assert row[0] == "Multi for him 150 ct"
    assert row[1] == pytest.approx(-20)       # pagado, negativo
    assert row[2] == pytest.approx(-534.2)    # pagado LPS, negativo
    assert row[3] == pytest.approx(700)       # ingresos (precio de venta)
    assert row[4] == pytest.approx(700 - 534.2)  # ganancia libre
    # filas de resumen: Total, Tax, Envío, Total + envío, Comisión tía Wendy, Ganancia neta
    labels = [r[0] for r in s["summary_rows"]]
    assert labels[0].startswith("Total")
    assert "Total + envío" in labels
    assert any("Tax" in l for l in labels)
    assert any("Envío" in l for l in labels)
    assert labels[-2] == "Comisión tía Wendy (45%)"
    assert labels[-1] == "Christian (55%)"
    # la comisión se calcula sobre la ganancia libre DESPUÉS de todas las
    # deducciones (la fila "Total + envío" ya resta compra, Tax, Envío, etc.)
    libre = next(r for r in s["summary_rows"] if r[0] == "Total + envío")[4]
    com_row = s["summary_rows"][-2]
    neta_row = s["summary_rows"][-1]
    assert com_row[4] == pytest.approx(-libre * 0.45)
    assert neta_row[4] == pytest.approx(libre * 0.55)


def test_commission_after_all_deductions(client):
    """La comisión de tía Wendy es 45% de la ganancia libre con TODAS las
    deducciones aplicadas, y se recalcula sola al agregar/quitar/editar."""
    _clean_products(client)
    _clean_expenses(client)
    client.post("/api/expenses", json={"name": "Envío", "amount_lps": 100})
    client.post("/api/products", json={"description": "P1", "cost_lps": 500,
                                       "sale_lps": 1000})
    s = client.get("/api/sheet").get_json()
    libre = 1000 - 500 - 100  # venta - costo - gasto
    assert s["summary_rows"][-2][4] == pytest.approx(-libre * 0.45)
    assert s["summary_rows"][-1][4] == pytest.approx(libre * 0.55)
    # al agregar otro producto, todo se recalcula dinámicamente
    client.post("/api/products", json={"description": "P2", "cost_lps": 200,
                                       "sale_lps": 600})
    s = client.get("/api/sheet").get_json()
    libre2 = libre + (600 - 200)
    assert s["summary_rows"][-2][4] == pytest.approx(-libre2 * 0.45)
    assert s["summary_rows"][-1][4] == pytest.approx(libre2 * 0.55)
    _clean_products(client)
    _clean_expenses(client)
    for name in ("Tax", "Envío"):  # dejar las categorías base como estaban
        client.post("/api/expenses", json={"name": name})


def test_sheet_csv_download(client):
    _clean_products(client)
    client.post("/api/products", json={"description": "A", "purchase_usd": 10,
                                       "cost_lps": 267, "sale_lps": 500})
    r = client.get("/api/sheet.csv")
    assert r.status_code == 200
    assert "text/csv" in r.content_type
    assert "attachment" in r.headers["Content-Disposition"]
    text = r.data.decode("utf-8-sig")
    assert "Describcion" in text
    assert "Total pagado $$" in text
    assert "Multi for him" not in text  # este producto no se agregó aquí
    assert "Total + envío" in text
    assert "Comisión tía Wendy (45%)" in text
    assert "Christian (55%)" in text


# ---------- cajas (grupos por enviada), tallas y cantidades ----------

def _clean_cajas(client):
    for c in client.get("/api/cajas").get_json():
        client.delete(f"/api/cajas/{c['id']}")


def test_sin_caja_semilla(client):
    # Ya no se crea ninguna "Segunda caja" automáticamente: el usuario
    # crea sus propias inversiones con el nombre que quiera.
    assert client.get("/api/cajas").get_json() == []


def test_limpieza_segunda_caja(client):
    # Si la vieja "Segunda caja" sigue en la base sin productos ni gastos,
    # init_db la elimina sola.
    import sqlite3
    db = sqlite3.connect(os.environ["INVENTARIO_DB_PATH"])
    db.execute("INSERT INTO cajas(name, created_at) VALUES('Segunda caja', 1)")
    db.commit()
    db.close()
    init_db()
    assert client.get("/api/cajas").get_json() == []


def test_cajas_crud(client):
    _clean_cajas(client)
    r = client.post("/api/cajas", json={"name": "Tercera caja"})
    assert r.status_code == 201
    cid = r.get_json()["id"]
    assert r.get_json()["name"] == "Tercera caja"
    r = client.post("/api/cajas", json={"name": "   "})
    assert r.status_code == 400  # nombre obligatorio
    lst = client.get("/api/cajas").get_json()
    assert any(c["id"] == cid and c["n_products"] == 0 for c in lst)
    r = client.put(f"/api/cajas/{cid}", json={"name": "Caja 3"})
    assert r.status_code == 200
    assert client.get("/api/cajas").get_json()[0]["name"] == "Caja 3"
    r = client.delete(f"/api/cajas/{cid}")
    assert r.status_code == 200
    assert client.get("/api/cajas").get_json() == []


def test_caja_no_se_borra_con_productos(client):
    _clean_cajas(client)
    _clean_products(client)
    cid = client.post("/api/cajas", json={"name": "Con cosas"}).get_json()["id"]
    client.post("/api/products", json={"description": "X", "caja_id": cid})
    r = client.delete(f"/api/cajas/{cid}")
    assert r.status_code == 400
    _clean_products(client)
    r = client.delete(f"/api/cajas/{cid}")
    assert r.status_code == 200


def test_producto_con_tallas_cantidad_y_caja(client):
    _clean_cajas(client)
    _clean_products(client)
    cid = client.post("/api/cajas", json={"name": "Segunda caja"}).get_json()["id"]
    r = client.post("/api/products", json={
        "description": "Zapatos náutica", "purchase_usd": 26.99,
        "cost_lps": 800, "sale_lps": 1000,
        "caja_id": cid, "size_shoes": "9.5", "size_shirts": "",
        "quantity": 3})
    assert r.status_code == 201
    p = r.get_json()
    assert p["caja_id"] == cid
    assert p["caja_name"] == "Segunda caja"
    assert p["size_shoes"] == "9.5"
    assert p["quantity"] == 3
    # la ganancia libre del producto multiplica por la cantidad
    assert p["ganancia_libre"] == pytest.approx((1000 - 800) * 3)
    # filtro por caja
    assert len(client.get(f"/api/products?caja_id={cid}").get_json()) == 1
    assert client.get("/api/products?caja_id=none").get_json() == []
    assert len(client.get("/api/products").get_json()) == 1
    # caja inexistente -> 400
    r = client.post("/api/products", json={"description": "Y", "caja_id": 99999})
    assert r.status_code == 400
    _clean_products(client)
    _clean_cajas(client)


def test_totales_multiplican_cantidad_y_filtran_caja(client):
    _clean_cajas(client)
    _clean_products(client)
    _clean_expenses(client)
    c1 = client.post("/api/cajas", json={"name": "Caja A"}).get_json()["id"]
    c2 = client.post("/api/cajas", json={"name": "Caja B"}).get_json()["id"]
    client.post("/api/products", json={"description": "A1", "cost_lps": 100,
                                       "sale_lps": 300, "quantity": 2, "caja_id": c1})
    client.post("/api/products", json={"description": "B1", "cost_lps": 50,
                                       "sale_lps": 150, "quantity": 1, "caja_id": c2})
    client.post("/api/expenses", json={"name": "Envío A", "amount_lps": 40, "caja_id": c1})
    client.post("/api/expenses", json={"name": "General", "amount_lps": 10})
    s = client.get(f"/api/summary?caja_id={c1}").get_json()
    assert s["n_products"] == 1
    assert s["total_costo_lps"] == pytest.approx(200)     # 100 x 2
    assert s["total_venta_lps"] == pytest.approx(600)     # 300 x 2
    assert s["exp_lps"] == pytest.approx(40)              # solo el gasto de la caja
    assert s["ganancia_libre_total"] == pytest.approx(600 - 200 - 40)
    s_all = client.get("/api/summary").get_json()
    assert s_all["n_products"] == 2
    assert s_all["exp_lps"] == pytest.approx(50)
    sh = client.get(f"/api/sheet?caja_id={c2}").get_json()
    assert len(sh["rows"]) == 1 and sh["rows"][0][0] == "B1"
    _clean_products(client)
    _clean_expenses(client)
    _clean_cajas(client)
    for name in ("Tax", "Envío"):
        client.post("/api/expenses", json={"name": name})


def test_gasto_con_caja(client):
    _clean_cajas(client)
    _clean_expenses(client)
    cid = client.post("/api/cajas", json={"name": "Caja G"}).get_json()["id"]
    r = client.post("/api/expenses", json={"name": "Flete", "amount_lps": 25,
                                           "caja_id": cid})
    assert r.status_code == 201
    assert r.get_json()["caja_id"] == cid
    lst = client.get("/api/expenses").get_json()
    g = next(e for e in lst if e["name"] == "Flete")
    assert g["caja_name"] == "Caja G"
    _clean_expenses(client)
    _clean_cajas(client)
    for name in ("Tax", "Envío"):
        client.post("/api/expenses", json={"name": name})


# ---------- persistencia ----------

def test_persistence_across_restarts(client):
    r = client.post("/api/products", json={"description": "Persiste", "sale_lps": 100})
    pid = r.get_json()["id"]
    # cerrar la conexión del request y reabrir el archivo directamente
    conn = appmod._connect_db()
    row = conn.execute("SELECT description FROM products WHERE id=?", (pid,)).fetchone()
    assert row["description"] == "Persiste"
    conn.close()
    # reabrir otra vez: los datos siguen ahí
    conn2 = appmod._connect_db()
    row2 = conn2.execute("SELECT COUNT(*) AS n FROM products").fetchone()
    assert row2["n"] >= 1
    conn2.close()


def test_index_and_manifest(client):
    r = client.get("/")
    assert r.status_code == 200
    assert b"Importaciones a Puerto Castilla" in r.data
    r = client.get("/manifest.json")
    assert r.status_code == 200
    m = r.get_json()
    assert m["name"] == "Importaciones a Puerto Castilla"
    assert m["short_name"] == "Importaciones"
    assert m["lang"] == "es"


def test_nueva_caja_nace_con_tax_y_envio_propios(client):
    _clean_cajas(client)
    cid = client.post("/api/cajas", json={"name": "Caja auto"}).get_json()["id"]
    exps = [e for e in client.get("/api/expenses").get_json() if e.get("caja_id") == cid]
    names = sorted(e["name"] for e in exps)
    assert names == ["Envío", "Tax"]
    assert all(e["amount_usd"] == 0 and e["amount_lps"] == 0 for e in exps)
    # Al borrar la carpeta se van también sus Tax/Envío
    assert client.delete(f"/api/cajas/{cid}").status_code == 200
    rest = [e for e in client.get("/api/expenses").get_json() if e.get("caja_id") == cid]
    assert rest == []


# ---------- hoja por caja (vista "Todas las cajas") ----------

def test_sheet_all_mode_returns_per_caja_sheets(client):
    """?caja_id=all en /api/sheet: una hoja por caja, cada una con SUS
    propios datos (no un solo total sumado de todas las cajas)."""
    _clean_cajas(client)
    _clean_products(client)
    _clean_expenses(client)
    c1 = client.post("/api/cajas", json={"name": "Caja Uno"}).get_json()["id"]
    c2 = client.post("/api/cajas", json={"name": "Caja Dos"}).get_json()["id"]
    client.post("/api/products", json={"description": "A1", "purchase_usd": 10,
                                      "cost_lps": 100, "sale_lps": 300,
                                      "quantity": 1, "caja_id": c1})
    client.post("/api/products", json={"description": "B1", "purchase_usd": 20,
                                      "cost_lps": 50, "sale_lps": 150,
                                      "quantity": 1, "caja_id": c2})
    client.post("/api/expenses", json={"name": "Tax", "amount_usd": 5, "caja_id": c1})
    client.post("/api/expenses", json={"name": "Envío", "amount_lps": 40, "caja_id": c2})

    s = client.get("/api/sheet?caja_id=all").get_json()
    assert s["mode"] == "per_caja"
    assert [sh["caja_name"] for sh in s["sheets"]] == ["Caja Uno", "Caja Dos"]
    sh1, sh2 = s["sheets"]
    # Cada hoja trae solo sus productos/gastos, con su propio resumen
    assert [r[0] for r in sh1["rows"]] == ["A1"]
    assert [r[0] for r in sh1["summary_rows"] if r[0] == "Tax"][0] == "Tax"
    assert sh1["rows"][0][1] == pytest.approx(-10)     # solo su USD
    assert [r[0] for r in sh2["rows"]] == ["B1"]
    assert sh2["rows"][0][1] == pytest.approx(-20)
    # Ganancia libre por caja: venta - costo - gastos DE ESA caja
    t1 = next(r for r in sh1["summary_rows"] if r[0] == "Total + envío")
    t2 = next(r for r in sh2["summary_rows"] if r[0] == "Total + envío")
    assert t1[4] == pytest.approx(300 - 100)        # sin gastos LPS en caja 1
    assert t2[4] == pytest.approx(150 - 50 - 40)    # con su Envío de 40
    # Comisión por caja, no sobre el total sumado
    assert sh1["summary_rows"][-2][0] == "Comisión tía Wendy (45%)"
    assert sh1["summary_rows"][-2][4] == pytest.approx(-t1[4] * 0.45)
    assert sh2["summary_rows"][-2][4] == pytest.approx(-t2[4] * 0.45)

    # /api/sheet sin parámetro sigue devolviendo la hoja combinada (una sola)
    s_comb = client.get("/api/sheet").get_json()
    assert "sheets" not in s_comb
    assert len(s_comb["rows"]) == 2

    _clean_products(client)
    _clean_expenses(client)
    _clean_cajas(client)


def test_sheet_all_mode_includes_unassigned(client):
    """Los productos/gastos sin caja no se pierden en el modo por caja:
    van en una hoja 'Sin caja asignada'."""
    _clean_cajas(client)
    _clean_products(client)
    _clean_expenses(client)
    c1 = client.post("/api/cajas", json={"name": "Caja Sola"}).get_json()["id"]
    client.post("/api/products", json={"description": "Suelto", "cost_lps": 100,
                                      "sale_lps": 200, "caja_id": c1})
    client.post("/api/expenses", json={"name": "General", "amount_lps": 10})
    s = client.get("/api/sheet?caja_id=all").get_json()
    names = [sh["caja_name"] for sh in s["sheets"]]
    assert names == ["Caja Sola", "Sin caja asignada"]
    suelta = s["sheets"][1]
    general = next(r for r in suelta["summary_rows"] if r[0] == "General")
    assert general[2] == pytest.approx(-10)  # el gasto general, en LPS negativo
    _clean_products(client)
    _clean_expenses(client)
    _clean_cajas(client)


def test_sheet_csv_all_mode_has_per_caja_sections(client):
    """/api/sheet.csv?caja_id=all: una sección por caja con su nombre."""
    _clean_cajas(client)
    _clean_products(client)
    _clean_expenses(client)
    c1 = client.post("/api/cajas", json={"name": "Caja CSV1"}).get_json()["id"]
    client.post("/api/products", json={"description": "P1", "cost_lps": 100,
                                      "sale_lps": 250, "caja_id": c1})
    r = client.get("/api/sheet.csv?caja_id=all")
    assert r.status_code == 200
    assert "text/csv" in r.content_type
    text = r.data.decode("utf-8-sig")
    assert "Caja: Caja CSV1" in text
    assert "P1" in text
    assert "Comisión tía Wendy (45%)" in text
    _clean_products(client)
    _clean_expenses(client)
    _clean_cajas(client)


# ---------- gráficas: inversión solo de productos ----------

def test_summary_inversion_es_solo_productos(client):
    """Contrato para la pestaña Gráficas: 'Inversión en inventario' usa
    total_costo_lps (solo productos) y la ganancia es venta menos eso,
    sin importar los gastos (Tax/Envío)."""
    _clean_cajas(client)
    _clean_products(client)
    _clean_expenses(client)
    c1 = client.post("/api/cajas", json={"name": "Caja G"}).get_json()["id"]
    client.post("/api/products", json={"description": "P1", "cost_lps": 800,
                                      "sale_lps": 1000, "caja_id": c1})
    client.post("/api/expenses", json={"name": "Tax", "amount_lps": 86, "caja_id": c1})
    client.post("/api/expenses", json={"name": "Envío", "amount_lps": 5300, "caja_id": c1})
    s = client.get("/api/summary").get_json()
    assert s["total_costo_lps"] == pytest.approx(800)   # sin gastos
    assert s["total_venta_lps"] == pytest.approx(1000)
    assert s["exp_lps"] == pytest.approx(86 + 5300)    # los gastos siguen aparte
    # Lo que muestra Gráficas: inversión 800, ganancia 1000-800=200
    ganancia = s["total_venta_lps"] - s["total_costo_lps"]
    assert ganancia == pytest.approx(200)
    _clean_products(client)
    _clean_expenses(client)
    _clean_cajas(client)


# ---------- vendido: marcar/desmarcar ----------

def test_sold_toggle_y_json(client):
    _clean_cajas(client)
    _clean_products(client)
    c1 = client.post("/api/cajas", json={"name": "Caja V"}).get_json()["id"]
    pid = client.post("/api/products", json={"description": "PV", "cost_lps": 100,
                                           "sale_lps": 300, "caja_id": c1}).get_json()["id"]
    assert client.get("/api/products/%d" % pid).get_json()["sold"] is False
    r = client.put("/api/products/%d/sold" % pid, json={"sold": True})
    assert r.status_code == 200 and r.get_json()["sold"] is True
    assert client.get("/api/products/%d" % pid).get_json()["sold"] is True
    lst = client.get("/api/products?caja_id=%d" % c1).get_json()
    assert [p for p in lst if p["id"] == pid][0]["sold"] is True
    r = client.put("/api/products/%d/sold" % pid, json={"sold": False})
    assert r.get_json()["sold"] is False
    assert client.put("/api/products/999999/sold", json={"sold": True}).status_code == 404
    _clean_products(client)
    _clean_cajas(client)


# ---------- pendientes ----------

def test_pending_counts(client):
    _clean_cajas(client)
    _clean_products(client)
    _clean_expenses(client)
    c1 = client.post("/api/cajas", json={"name": "Caja P"}).get_json()["id"]
    client.post("/api/products", json={"description": "Sin foto ni precio",
                                    "caja_id": c1})  # sale_lps 0 -> sin precio
    client.post("/api/products", json={"description": "Completo", "cost_lps": 50,
                                    "sale_lps": 120, "caja_id": c1})
    p = client.get("/api/pending").get_json()
    assert p["sin_foto"] == 2
    assert p["sin_precio"] == 1
    # Tax y Envío en $0 de la caja nueva cuentan como pendientes
    assert p["gastos_pendientes"] == 2
    p1 = client.get("/api/pending?caja_id=%d" % c1).get_json()
    assert p1["sin_foto"] == 2 and p1["sin_precio"] == 1
    assert client.get("/api/pending?caja_id=nope").status_code == 400
    _clean_products(client)
    _clean_expenses(client)
    _clean_cajas(client)


# ---------- regresión: _Row de producción debe tener .keys() ----------

def test_row_produccion_tiene_keys():
    """El 2026-10-01 /api/products dio 500 en producción porque _Row
    (libsql) no tenía .keys() y _product_json lo usa; en local sqlite3.Row
    sí lo tiene y los tests no lo detectaron."""
    from app import _Row, _product_json
    cols = ["id", "description", "purchase_usd", "cost_lps", "sale_lps",
            "ganancia_libre", "photo_url", "created_at", "caja_id",
            "caja_name", "size_shoes", "size_shirts", "quantity", "sold",
            "photo"]
    row = _Row(cols, [1, "P", 10, 265, 400, 135, None, 0, None, None, "", "", 1, 1, None])
    assert "sold" in row.keys()
    j = _product_json(row)
    assert j["sold"] is True
    row2 = _Row(cols, [2, "Q", 10, 265, 400, 135, None, 0, None, None, "", "", 1, 0, None])
    assert _product_json(row2)["sold"] is False


# ---------- regresión: Tax y Envío automáticos en cada inversión ----------

def test_tax_envio_automaticos_en_caja_nueva_y_anterior(client):
    # Al crear una caja nacen Tax y Envío en $0
    r = client.post("/api/cajas", json={"name": "Caja prueba auto"})
    assert r.status_code == 201
    cid = r.get_json()["id"]
    exps = [e for e in client.get("/api/expenses").get_json() if e["caja_id"] == cid]
    assert {e["name"] for e in exps} == {"Tax", "Envío"}
    # Aunque se borren, el arranque los restaura (caja "anterior")
    for e in exps:
        assert client.delete("/api/expenses/%d" % e["id"]).status_code == 200
    assert [e for e in client.get("/api/expenses").get_json() if e["caja_id"] == cid] == []
    init_db()  # respaldo al arrancar
    exps2 = [e for e in client.get("/api/expenses").get_json() if e["caja_id"] == cid]
    assert {e["name"] for e in exps2} == {"Tax", "Envío"}
    # _ensure_caja_expenses es idempotente: no duplica
    init_db()
    exps3 = [e for e in client.get("/api/expenses").get_json() if e["caja_id"] == cid]
    assert len(exps3) == 2
    # y no toca los montos que el usuario ya editó
    tax = [e for e in exps3 if e["name"] == "Tax"][0]
    assert client.put("/api/expenses/%d" % tax["id"],
                      json={"name": "Tax", "amount_usd": 50, "amount_lps": 1300,
                            "caja_id": cid}).status_code == 200
    init_db()
    tax2 = [e for e in client.get("/api/expenses").get_json() if e["id"] == tax["id"]][0]
    assert tax2["amount_usd"] == 50 and tax2["amount_lps"] == 1300
    _clean_expenses(client)
    _clean_cajas(client)


# ---------- vendido masivo ----------

def test_sold_all_marca_solo_los_ids_recibidos(client):
    _clean_products(client)
    ids = []
    for d in ("A uno", "B dos", "C tres"):
        r = client.post("/api/products", json={"description": d})
        assert r.status_code == 201
        ids.append(r.get_json()["id"])
    # sin ids no marca nada
    assert client.post("/api/products/sold_all", json={"ids": []}).get_json()["marcados"] == 0
    # marca solo los enviados
    r = client.post("/api/products/sold_all", json={"ids": ids[:2]})
    assert r.get_json()["marcados"] == 2
    lst = {p["id"]: p for p in client.get("/api/products").get_json()}
    assert lst[ids[0]]["sold"] is True and lst[ids[1]]["sold"] is True
    assert lst[ids[2]]["sold"] is False
    # ids inexistentes no rompen nada
    assert client.post("/api/products/sold_all", json={"ids": [999999]}).get_json()["marcados"] == 0
    _clean_products(client)


# ---------- pérdida ----------

def test_lost_toggle_excluye_sold_y_afecta_totales(client):
    _clean_products(client)
    r = client.post("/api/products", json={
        "description": "Zapato perdido", "purchase_usd": 20,
        "cost_lps": 500, "sale_lps": 800})
    pid = r.get_json()["id"]
    assert r.get_json()["lost"] is False
    # marcar pérdida
    r = client.put("/api/products/%d/lost" % pid, json={"lost": True})
    assert r.get_json()["lost"] is True
    j = client.get("/api/products/%d" % pid).get_json()
    assert j["lost"] is True and j["sold"] is False
    # vender quita la pérdida (exclusión mutua)
    client.put("/api/products/%d/sold" % pid, json={"sold": True})
    j = client.get("/api/products/%d" % pid).get_json()
    assert j["sold"] is True and j["lost"] is False
    # marcar pérdida quita el vendido
    client.put("/api/products/%d/lost" % pid, json={"lost": True})
    j = client.get("/api/products/%d" % pid).get_json()
    assert j["lost"] is True and j["sold"] is False
    assert client.put("/api/products/999999/lost", json={"lost": True}).status_code == 404
    # resumen: excluido de la venta potencial, contado como pérdida
    s = client.get("/api/summary").get_json()
    assert s["n_lost"] == 1
    assert s["total_perdidas_lps"] == 500
    assert s["total_venta_lps"] == 0  # la pérdida no genera ingresos
    # hoja: fila con ingresos 0 y ganancia negativa + fila resumen Pérdidas
    sh = client.get("/api/sheet?caja_id=all").get_json()
    hojas = sh["sheets"] if "sheets" in sh else [sh]
    fila = [r for h in hojas for r in h["rows"] if r[0] == "Zapato perdido"][0]
    assert fila[3] == 0 and fila[4] == -500
    resumen = [r for h in hojas for r in h["summary_rows"] if r[0] == "Pérdidas"]
    assert resumen and resumen[0][2] == -500
    _clean_products(client)


# ---------- desmarcar todos + exenciones ----------

def test_sold_all_con_sold_false_desmarca(client):
    _clean_products(client)
    ids = []
    for d in ("X uno", "Y dos"):
        ids.append(client.post("/api/products", json={"description": d}).get_json()["id"])
    assert client.post("/api/products/sold_all", json={"ids": ids}).get_json()["marcados"] == 2
    r = client.post("/api/products/sold_all", json={"ids": ids, "sold": False})
    assert r.get_json()["marcados"] == 2
    lst = {p["id"]: p for p in client.get("/api/products").get_json()}
    assert all(not lst[i]["sold"] for i in ids)
    _clean_products(client)


def test_caja_exenciones_en_pending(client):
    _clean_products(client)
    _clean_cajas(client)
    _clean_expenses(client)
    cid = client.post("/api/cajas", json={"name": "Caja exenta"}).get_json()["id"]
    # la caja nace con Tax y Envío en $0 -> 2 gastos pendientes
    assert client.get("/api/pending").get_json()["gastos_pendientes"] == 2
    # flags via PUT y visibles en GET
    assert client.put("/api/cajas/%d" % cid,
                      json={"name": "Caja exenta", "exenta_fotos": 1, "exenta_tax": 1}).status_code == 200
    cajas = {c["id"]: c for c in client.get("/api/cajas").get_json()}
    assert cajas[cid]["exenta_fotos"] == 1 and cajas[cid]["exenta_tax"] == 1
    # producto sin foto en caja exenta: no cuenta como pendiente de foto
    client.post("/api/products", json={"description": "Sin foto exenta", "caja_id": cid})
    assert client.get("/api/pending").get_json()["sin_foto"] == 0
    # Tax exento en $0: ya no cuenta como gasto pendiente (queda solo Envío)
    assert client.get("/api/pending").get_json()["gastos_pendientes"] == 1
    # al quitar la exención vuelve a contar
    client.put("/api/cajas/%d" % cid,
               json={"name": "Caja exenta", "exenta_fotos": 0, "exenta_tax": 0})
    p = client.get("/api/pending").get_json()
    assert p["sin_foto"] == 1 and p["gastos_pendientes"] == 2
    _clean_products(client)
    _clean_expenses(client)
    _clean_cajas(client)


# ---------- pérdida masiva + pérdida fuera de "sin precio" ----------

def test_lost_all_marca_perdida_y_quita_vendido(client):
    _clean_products(client)
    ids = []
    for d in ("P uno", "P dos", "P tres"):
        ids.append(client.post("/api/products", json={"description": d}).get_json()["id"])
    # uno vendido de antemano: la pérdida debe quitarle el vendido
    client.put("/api/products/%d/sold" % ids[0], json={"sold": True})
    assert client.post("/api/products/lost_all", json={"ids": []}).get_json()["marcados"] == 0
    r = client.post("/api/products/lost_all", json={"ids": ids})
    assert r.get_json()["marcados"] == 3
    lst = {p["id"]: p for p in client.get("/api/products").get_json()}
    assert all(lst[i]["lost"] is True and lst[i]["sold"] is False for i in ids)
    assert client.post("/api/products/lost_all", json={"ids": [999999]}).get_json()["marcados"] == 0
    _clean_products(client)


def test_perdida_no_cuenta_como_sin_precio(client):
    _clean_products(client)
    pid = client.post("/api/products", json={"description": "Sin precio"}).get_json()["id"]
    assert client.get("/api/pending").get_json()["sin_precio"] == 1
    # al marcarlo como pérdida sale de los pendientes de precio
    client.put("/api/products/%d/lost" % pid, json={"lost": True})
    assert client.get("/api/pending").get_json()["sin_precio"] == 0
    # al quitar la pérdida vuelve a contar
    client.put("/api/products/%d/lost" % pid, json={"lost": False})
    assert client.get("/api/pending").get_json()["sin_precio"] == 1
    _clean_products(client)
