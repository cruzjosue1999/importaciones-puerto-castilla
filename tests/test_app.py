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
    assert s["columns"] == ["Describcion", "Total pagado $$", "Pagado en LPS",
                            "Ganancia", "Menos gastos ganancia libre"]
    assert len(s["rows"]) == 1
    row = s["rows"][0]
    assert row[0] == "Multi for him 150 ct"
    assert row[1] == pytest.approx(-20)       # pagado, negativo
    assert row[2] == pytest.approx(-534.2)    # pagado LPS, negativo
    assert row[3] == pytest.approx(700)       # ganancia (precio de venta)
    assert row[4] == pytest.approx(700 - 534.2)  # ganancia libre
    # filas de resumen: Total, Tax, Envío, Total + envío
    labels = [r[0] for r in s["summary_rows"]]
    assert labels[0].startswith("Total")
    assert labels[-1] == "Total + envío"
    assert any("Tax" in l for l in labels)
    assert any("Envío" in l for l in labels)


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
