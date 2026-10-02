#!/usr/bin/env python3
"""
Importaciones a Puerto Castilla - inventario personal.

Una PWA de una sola página para llevar el inventario de compras:
- Productos con foto (tomada con la cámara del teléfono), precio de compra en
  USD, costo en LPS, precio de venta en LPS y ganancia libre calculada.
- Gastos (Tax, Envío y los que agregue) que se restan de la ganancia.
- Gráficas circulares (SVG puro, sin dependencias externas).
- Hoja auto-generada que refleja la planilla del usuario: se puede imprimir
  y descargar en CSV.
- Base de datos en la nube (Turso, réplica embebida libsql): nada se pierde
  con despliegues ni reinicios. Sin esas variables de entorno usa SQLite local.

Interfaz 100% en español, mobile-first. Sin contraseña: la app abre directo.

Rutas principales:
    GET /              -> la app (PWA instalable)
    GET /manifest.json -> manifiesto PWA
    GET /api/products            -> lista de productos
    POST /api/products           -> crear producto
    GET/PUT/DELETE /api/products/<id>
    GET /api/photo/<id>          -> foto del producto
    POST /api/upload             -> subir foto temporal (vista previa)
    GET /api/photo/pending/<uid> -> vista previa de subida pendiente
    GET /api/expenses            -> categorías de gasto
    POST /api/expenses           -> crear gasto
    PUT/DELETE /api/expenses/<id>
    GET /api/cajas               -> grupos por enviada (cajas)
    POST /api/cajas              -> crear caja
    PUT/DELETE /api/cajas/<id>
    GET /api/summary             -> totales + datos para gráficas
    GET /api/sheet               -> hoja tipo planilla (JSON)
    GET /api/sheet.csv           -> hoja en CSV (descargable)
"""

# Nombre de la app: úsalo para renombrarla en el futuro.
APP_NAME = "Importaciones a Puerto Castilla"
APP_SHORT = "Importaciones"

import os
import io
import csv
import json
import sqlite3
import time
import uuid

from flask import (
    Flask, request, jsonify, render_template, g, Response,
)

try:
    from PIL import Image
    _HAS_PIL = True
except ImportError:  # pragma: no cover
    Image = None
    _HAS_PIL = False

try:
    import libsql
    _HAS_LIBSQL = True
except ImportError:  # pragma: no cover
    libsql = None
    _HAS_LIBSQL = False

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, "data")
DB_PATH = os.environ.get("INVENTARIO_DB_PATH") or os.path.join(DATA_DIR, "inventario.db")
os.makedirs(DATA_DIR, exist_ok=True)

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 5 * 1024 * 1024  # 5 MB por foto

ALLOWED_EXT = {"png", "jpg", "jpeg", "webp", "gif"}
MAGIC_BYTES = {
    b"\xff\xd8\xff": "jpg",
    b"\x89PNG\r\n\x1a\n": "png",
    b"GIF87a": "gif",
    b"GIF89a": "gif",
    b"RIFF": "webp",  # se valida WEBP después
}

PHOTO_MAX_SIDE = 1600  # píxeles máximos del lado más largo


# ---------------- Base de datos ----------------
# En Render (plan gratuito) el disco es temporal: cada despliegue borra el
# archivo SQLite local. Si existen TURSO_URL y TURSO_TOKEN, la app usa Turso
# (réplica embebida libsql, compatible con SQLite) y los datos sobreviven a
# los despliegues. Sin esas variables, usa SQLite local como antes.


class _Row:
    """Fila compatible con sqlite3.Row: acceso por índice y por nombre."""
    __slots__ = ("_cols", "_vals")

    def __init__(self, cols, vals):
        self._cols = cols
        self._vals = tuple(vals)

    def __getitem__(self, key):
        if isinstance(key, str):
            key = self._cols.index(key)
        return self._vals[key]

    def __iter__(self):
        return iter(self._vals)

    def __len__(self):
        return len(self._vals)

    def keys(self):
        return list(self._cols)


class _Cursor:
    def __init__(self, cur):
        self._cur = cur
        self._cols = [d[0] for d in (cur.description or [])]

    def _wrap(self, row):
        return _Row(self._cols, row) if row is not None else None

    def fetchone(self):
        return self._wrap(self._cur.fetchone())

    def fetchall(self):
        return [self._wrap(r) for r in self._cur.fetchall()]

    def __iter__(self):
        # No iterar el cursor crudo directamente: el Cursor de libsql
        # (producción) no es iterable, a diferencia del de sqlite3.
        for r in self._cur.fetchall():
            yield self._wrap(r)

    @property
    def lastrowid(self):
        return self._cur.lastrowid

    @property
    def rowcount(self):
        return self._cur.rowcount


class _TursoConn:
    """Conexión libsql con la misma interfaz que la app espera de sqlite3."""

    def __init__(self, conn):
        self._conn = conn

    def execute(self, sql, params=()):
        return _Cursor(self._conn.execute(sql, params))

    def executemany(self, sql, seq):
        return self._conn.executemany(sql, seq)

    def executescript(self, sql):
        return self._conn.executescript(sql)

    def commit(self):
        return self._conn.commit()

    def close(self):
        return self._conn.close()

    def sync(self):
        return self._conn.sync()


def _turso_sync_url():
    """URL de sincronización normalizada (libsql:// -> https://)."""
    url = (os.environ.get("TURSO_URL") or "").strip().rstrip("/")
    if url.startswith("libsql://"):
        url = "https://" + url[len("libsql://"):]
    return url


def _turso_enabled():
    return (
        _HAS_LIBSQL
        and bool(_turso_sync_url())
        and bool(os.environ.get("TURSO_TOKEN"))
    )


def _connect_db():
    if _turso_enabled():
        try:
            conn = libsql.connect(
                DB_PATH,
                sync_url=_turso_sync_url(),
                auth_token=os.environ.get("TURSO_TOKEN"),
            )
            wrapped = _TursoConn(conn)
            try:
                wrapped.sync()  # traer lo último de la nube
            except Exception as e:
                print(f"[DB] Turso sync inicial falló: {e}", flush=True)
            return wrapped
        except Exception as e:
            print(f"[DB] No se pudo conectar a Turso, usando SQLite local: {e}", flush=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def get_db():
    if "db" not in g:
        g.db = _connect_db()
    return g.db


@app.teardown_appcontext
def close_db(exc=None):
    db = g.pop("db", None)
    if db is not None:
        try:
            if isinstance(db, _TursoConn):
                db.sync()  # subir los cambios a la nube
        except Exception as e:
            print(f"[DB] Turso sync final falló: {e}", flush=True)
        db.close()


def init_db():
    print(
        "[DB] modo=%s libsql=%s TURSO_URL=%s TURSO_TOKEN=%s"
        % (
            "turso" if _turso_enabled() else "local",
            _HAS_LIBSQL,
            "definida" if os.environ.get("TURSO_URL") else "ausente",
            "definido" if os.environ.get("TURSO_TOKEN") else "ausente",
        ),
        flush=True,
    )
    db = _connect_db()
    db.executescript(
        """
        CREATE TABLE IF NOT EXISTS products (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            description TEXT NOT NULL DEFAULT '',
            photo BLOB,
            photo_mime TEXT DEFAULT '',
            purchase_usd REAL NOT NULL DEFAULT 0,
            cost_lps REAL NOT NULL DEFAULT 0,
            sale_lps REAL NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS expenses (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL DEFAULT '',
            amount_usd REAL NOT NULL DEFAULT 0,
            amount_lps REAL NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS pending_uploads (
            id TEXT PRIMARY KEY,
            data BLOB,
            mime TEXT DEFAULT '',
            created_at INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS cajas (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL DEFAULT '',
            created_at INTEGER NOT NULL DEFAULT 0
        );
        """
    )
    # Migración: columnas nuevas en products y expenses (idempotente)
    pcols = [r["name"] for r in db.execute("PRAGMA table_info(products)").fetchall()]
    if "caja_id" not in pcols:
        db.execute("ALTER TABLE products ADD COLUMN caja_id INTEGER")
    if "size_shoes" not in pcols:
        db.execute("ALTER TABLE products ADD COLUMN size_shoes TEXT DEFAULT ''")
    if "size_shirts" not in pcols:
        db.execute("ALTER TABLE products ADD COLUMN size_shirts TEXT DEFAULT ''")
    if "quantity" not in pcols:
        db.execute("ALTER TABLE products ADD COLUMN quantity REAL NOT NULL DEFAULT 1")
    if "sold" not in pcols:
        db.execute("ALTER TABLE products ADD COLUMN sold INTEGER NOT NULL DEFAULT 0")
    if "lost" not in pcols:
        db.execute("ALTER TABLE products ADD COLUMN lost INTEGER NOT NULL DEFAULT 0")
    ecols = [r["name"] for r in db.execute("PRAGMA table_info(expenses)").fetchall()]
    if "caja_id" not in ecols:
        db.execute("ALTER TABLE expenses ADD COLUMN caja_id INTEGER")
    # Orden manual de inversiones: sort_order (menor = primero). Al agregar
    # la columna, se conserva el orden actual (por id) como punto de partida.
    ccols = [r["name"] for r in db.execute("PRAGMA table_info(cajas)").fetchall()]
    if "sort_order" not in ccols:
        db.execute("ALTER TABLE cajas ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0")
        db.execute("UPDATE cajas SET sort_order = id")
    if "exenta_fotos" not in ccols:
        db.execute("ALTER TABLE cajas ADD COLUMN exenta_fotos INTEGER NOT NULL DEFAULT 0")
    if "exenta_tax" not in ccols:
        db.execute("ALTER TABLE cajas ADD COLUMN exenta_tax INTEGER NOT NULL DEFAULT 0")
    # Respaldo: toda inversión anterior o nueva tiene sus tarjetas Tax y Envío.
    # Va DESPUÉS de la limpieza para no revivir la vieja "Segunda caja".
    # Semillas: categorías de gasto de la planilla (solo si la tabla está vacía)
    n = db.execute("SELECT COUNT(*) AS n FROM expenses").fetchone()["n"]
    if n == 0:
        db.execute(
            "INSERT INTO expenses(name, amount_usd, amount_lps) VALUES(?,?,?)",
            ("Tax", 0, 0),
        )
        db.execute(
            "INSERT INTO expenses(name, amount_usd, amount_lps) VALUES(?,?,?)",
            ("Envío", 0, 0),
        )
    # Limpieza: la "Segunda caja" inicial se retiró del diseño; si sigue
    # existiendo y no tiene productos ni gastos asociados, se elimina.
    # El usuario ahora crea sus propias inversiones con el nombre que quiera.
    db.execute(
        "DELETE FROM cajas WHERE name='Segunda caja'"
        " AND NOT EXISTS (SELECT 1 FROM products WHERE products.caja_id=cajas.id)"
        " AND NOT EXISTS (SELECT 1 FROM expenses WHERE expenses.caja_id=cajas.id)"
    )
    for (cid,) in db.execute("SELECT id FROM cajas").fetchall():
        _ensure_caja_expenses(db, cid)
    db.commit()
    db.close()


# ---------------- Fotos ----------------

def _is_image(head: bytes) -> bool:
    for magic in MAGIC_BYTES:
        if head.startswith(magic):
            if magic == b"RIFF":
                return head[8:12] == b"WEBP"
            return True
    return False


def _process_image(data: bytes) -> tuple:
    """Valida y reduce la imagen: lado máximo 1600px, sale como JPEG.

    Devuelve (bytes, mime). Lanza ValueError si no es una imagen válida.
    """
    if not _is_image(data[:12]):
        raise ValueError("El archivo no es una imagen válida.")
    if not _HAS_PIL:
        raise ValueError("No se puede procesar la imagen en el servidor.")
    img = Image.open(io.BytesIO(data))
    img = img.convert("RGB")
    if max(img.size) > PHOTO_MAX_SIDE:
        img.thumbnail((PHOTO_MAX_SIDE, PHOTO_MAX_SIDE), Image.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=82)
    return buf.getvalue(), "image/jpeg"


# ---------------- Validación ----------------

def _num(value, field):
    """Convierte a número >= 0. Devuelve (valor, error)."""
    if value is None or value == "":
        return 0.0, None
    try:
        v = float(value)
    except (TypeError, ValueError):
        return None, f"«{field}» debe ser un número."
    if v < 0:
        return None, f"«{field}» no puede ser negativo."
    return v, None


def _product_from_request():
    """Lee description + números del POST (multipart o JSON). Devuelve (dict, error)."""
    if request.is_json:
        data = request.get_json(silent=True) or {}
    else:
        data = request.form.to_dict()
    description = (data.get("description") or "").strip()
    if not description:
        return None, "La descripción es obligatoria."
    p = {"description": description}
    for key, label in (("purchase_usd", "Precio de compra $"),
                       ("cost_lps", "Costo en LPS"),
                       ("sale_lps", "Precio de venta en LPS")):
        v, err = _num(data.get(key), label)
        if err:
            return None, err
        p[key] = v
    # Campos del catálogo: caja (grupo/enviada), tallas y cantidad
    raw_caja = data.get("caja_id")
    caja_id = None
    if raw_caja not in (None, "", "none", "null"):
        try:
            caja_id = int(raw_caja)
        except (TypeError, ValueError):
            return None, "«Caja» no es válida."
    p["caja_id"] = caja_id
    p["size_shoes"] = (data.get("size_shoes") or "").strip()[:40]
    p["size_shirts"] = (data.get("size_shirts") or "").strip()[:40]
    qty, err = _num(data.get("quantity"), "Cantidad")
    if err:
        return None, err
    p["quantity"] = qty if (data.get("quantity") not in (None, "")) else 1
    return p, None


def _photo_bytes_from_request(db):
    """Foto del POST: archivo directo (multipart) o upload_id temporal."""
    upload_id = None
    if request.is_json:
        upload_id = (request.get_json(silent=True) or {}).get("upload_id")
    else:
        upload_id = request.form.get("upload_id")
    if upload_id:
        row = db.execute(
            "SELECT data, mime FROM pending_uploads WHERE id=?", (upload_id,)
        ).fetchone()
        if row and row["data"]:
            data, mime = bytes(row["data"]), row["mime"] or "image/jpeg"
            db.execute("DELETE FROM pending_uploads WHERE id=?", (upload_id,))
            return data, mime
        return None, None
    if "file" in request.files:
        f = request.files["file"]
        if f and f.filename:
            ext = f.filename.rsplit(".", 1)[-1].lower() if "." in f.filename else ""
            if ext not in ALLOWED_EXT:
                raise ValueError("Solo se permiten imágenes (PNG, JPG, WEBP, GIF).")
            data = f.stream.read()
            try:
                return _process_image(data)
            except ValueError as e:
                raise ValueError(str(e))
    return None, None


# ---------------- Matemáticas ----------------

def _ganancia_libre(cost_lps, sale_lps):
    return (sale_lps or 0) - (cost_lps or 0)


def _compute_totals(db, caja_id=None, unassigned=False):
    """Totales como la planilla: inversión, venta y ganancia libre neta.

    caja_id=None -> todo; si se indica, solo esa caja (y sus gastos).
    unassigned=True -> solo productos/gastos sin caja asignada.
    Las cantidades multiplican los montos unitarios.
    """
    psql = ("SELECT id, description, purchase_usd, cost_lps, sale_lps,"
            " quantity, caja_id, size_shoes, size_shirts, lost FROM products")
    pparams: list = []
    if unassigned:
        psql += " WHERE caja_id IS NULL"
    elif caja_id is not None:
        psql += " WHERE caja_id=?"
        pparams.append(caja_id)
    psql += " ORDER BY id"
    products = db.execute(psql, pparams).fetchall()
    esql = "SELECT id, name, amount_usd, amount_lps, caja_id FROM expenses"
    eparams: list = []
    if unassigned:
        esql += " WHERE caja_id IS NULL"
    elif caja_id is not None:
        esql += " WHERE caja_id=?"
        eparams.append(caja_id)
    esql += " ORDER BY id"
    expenses = db.execute(esql, eparams).fetchall()

    def _qty(p):
        q = p["quantity"]
        return q if q not in (None, "") else 1

    total_usd = sum((p["purchase_usd"] or 0) * _qty(p) for p in products)
    total_costo_lps = sum((p["cost_lps"] or 0) * _qty(p) for p in products)
    # Las pérdidas no generan ingresos: se excluyen de la venta potencial,
    # pero su costo ya pagado sigue en la inversión (es dinero perdido).
    vendidos_o_pend = [p for p in products if not p["lost"]]
    total_venta_lps = sum((p["sale_lps"] or 0) * _qty(p) for p in vendidos_o_pend)
    perdidos = [p for p in products if p["lost"]]
    total_perdidas_usd = sum((p["purchase_usd"] or 0) * _qty(p) for p in perdidos)
    total_perdidas_lps = sum((p["cost_lps"] or 0) * _qty(p) for p in perdidos)
    exp_usd = sum(e["amount_usd"] or 0 for e in expenses)
    exp_lps = sum(e["amount_lps"] or 0 for e in expenses)
    inversion_total_lps = total_costo_lps + exp_lps
    ganancia_libre_total = total_venta_lps - inversion_total_lps
    by_product = sorted(
        (
            {
                "id": p["id"],
                "name": p["description"],
                "ganancia_libre": _ganancia_libre(p["cost_lps"], p["sale_lps"]) * _qty(p),
            }
            for p in products
        ),
        key=lambda x: x["ganancia_libre"],
        reverse=True,
    )
    return {
        "products": products,
        "expenses": expenses,
        "total_usd": total_usd,
        "total_costo_lps": total_costo_lps,
        "total_venta_lps": total_venta_lps,
        "exp_usd": exp_usd,
        "exp_lps": exp_lps,
        "inversion_total_lps": inversion_total_lps,
        "ganancia_libre_total": ganancia_libre_total,
        "by_product": by_product,
        "n_products": len(products),
        "n_lost": len(perdidos),
        "total_perdidas_usd": total_perdidas_usd,
        "total_perdidas_lps": total_perdidas_lps,
    }


def _parse_caja_param(value):
    """?caja_id= -> None (todas); número -> int; otro -> (None, error)."""
    if value in (None, "", "all"):
        return None, None
    try:
        return int(value), None
    except (TypeError, ValueError):
        return None, "caja_id no válido."


# ---------------- Vistas ----------------

@app.route("/")
def index():
    return render_template("index.html", app_name=APP_NAME)


@app.route("/manifest.json")
def manifest():
    return jsonify(
        {
            "name": APP_NAME,
            "short_name": APP_SHORT,
            "start_url": "/",
            "scope": "/",
            "display": "standalone",
            "orientation": "portrait",
            "background_color": "#ffffff",
            "theme_color": "#0a2a5e",
            "lang": "es",
            "icons": [
                {"src": "/static/icon-192.png", "sizes": "192x192", "type": "image/png"},
                {"src": "/static/icon-512.png", "sizes": "512x512", "type": "image/png"},
                {
                    "src": "/static/icon-maskable-512.png",
                    "sizes": "512x512",
                    "type": "image/png",
                    "purpose": "maskable",
                },
            ],
        }
    )


@app.route("/apple-touch-icon.png")
def apple_touch_icon():
    return app.send_static_file("apple-touch-icon.png")


# ---------------- API: productos ----------------

_PRODUCT_COLS = (
    "id, description, photo, purchase_usd, cost_lps, sale_lps, created_at,"
    " caja_id, size_shoes, size_shirts, quantity"
)


def _caja_name(db, caja_id):
    if not caja_id:
        return None
    r = db.execute("SELECT name FROM cajas WHERE id=?", (caja_id,)).fetchone()
    return r["name"] if r else None


def _product_json(row, caja_name=None):
    has_photo = bool(row["photo"])
    qty = row["quantity"] if row["quantity"] not in (None, "") else 1
    return {
        "id": row["id"],
        "description": row["description"],
        "purchase_usd": row["purchase_usd"],
        "cost_lps": row["cost_lps"],
        "sale_lps": row["sale_lps"],
        "ganancia_libre": _ganancia_libre(row["cost_lps"], row["sale_lps"]) * qty,
        "photo_url": f"/api/photo/{row['id']}" if has_photo else None,
        "created_at": row["created_at"],
        "caja_id": row["caja_id"],
        "caja_name": caja_name,
        "size_shoes": row["size_shoes"] or "",
        "size_shirts": row["size_shirts"] or "",
        "quantity": qty,
        "sold": bool(row["sold"]) if "sold" in row.keys() else False,
        "lost": bool(row["lost"]) if "lost" in row.keys() else False,
    }


def _check_caja(db, caja_id):
    if caja_id is None:
        return None
    ok = db.execute("SELECT id FROM cajas WHERE id=?", (caja_id,)).fetchone()
    return None if ok else "La inversión no existe."


@app.route("/api/products", methods=["GET"])
def api_list_products():
    db = get_db()
    caja = request.args.get("caja_id", "")
    sql = (
        "SELECT p.id, p.description, p.photo, p.purchase_usd, p.cost_lps, p.sale_lps,"
        " p.created_at, p.caja_id, p.size_shoes, p.size_shirts, p.quantity, p.sold, p.lost,"
        " c.name AS caja_name FROM products p LEFT JOIN cajas c ON c.id=p.caja_id"
    )
    params: list = []
    if caja == "none":
        sql += " WHERE p.caja_id IS NULL"
    elif caja not in ("", "all"):
        try:
            cid = int(caja)
        except (TypeError, ValueError):
            return jsonify({"error": "caja_id no válido."}), 400
        sql += " WHERE p.caja_id=?"
        params.append(cid)
    sql += " ORDER BY p.id"
    rows = db.execute(sql, params).fetchall()
    return jsonify([_product_json(r, r["caja_name"]) for r in rows])


@app.route("/api/products", methods=["POST"])
def api_create_product():
    db = get_db()
    p, err = _product_from_request()
    if err:
        return jsonify({"error": err}), 400
    err = _check_caja(db, p["caja_id"])
    if err:
        return jsonify({"error": err}), 400
    try:
        photo, mime = _photo_bytes_from_request(db)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    cur = db.execute(
        "INSERT INTO products(description, photo, photo_mime, purchase_usd, cost_lps,"
        " sale_lps, created_at, caja_id, size_shoes, size_shirts, quantity)"
        " VALUES(?,?,?,?,?,?,?,?,?,?,?)",
        (
            p["description"], photo, mime or "",
            p["purchase_usd"], p["cost_lps"], p["sale_lps"], int(time.time()),
            p["caja_id"], p["size_shoes"], p["size_shirts"], p["quantity"],
        ),
    )
    db.commit()
    row = db.execute(
        "SELECT p.id, p.description, p.photo, p.purchase_usd, p.cost_lps, p.sale_lps,"
        " p.created_at, p.caja_id, p.size_shoes, p.size_shirts, p.quantity, p.sold, p.lost,"
        " c.name AS caja_name FROM products p LEFT JOIN cajas c ON c.id=p.caja_id"
        " WHERE p.id=?", (cur.lastrowid,)
    ).fetchone()
    return jsonify(_product_json(row, row["caja_name"])), 201


@app.route("/api/products/<int:pid>", methods=["GET"])
def api_get_product(pid):
    db = get_db()
    row = db.execute(
        "SELECT p.id, p.description, p.photo, p.purchase_usd, p.cost_lps, p.sale_lps,"
        " p.created_at, p.caja_id, p.size_shoes, p.size_shirts, p.quantity, p.sold, p.lost,"
        " c.name AS caja_name FROM products p LEFT JOIN cajas c ON c.id=p.caja_id"
        " WHERE p.id=?", (pid,)
    ).fetchone()
    if not row:
        return jsonify({"error": "Producto no encontrado."}), 404
    return jsonify(_product_json(row, row["caja_name"]))


@app.route("/api/products/<int:pid>", methods=["PUT"])
def api_update_product(pid):
    db = get_db()
    row = db.execute("SELECT id FROM products WHERE id=?", (pid,)).fetchone()
    if not row:
        return jsonify({"error": "Producto no encontrado."}), 404
    p, err = _product_from_request()
    if err:
        return jsonify({"error": err}), 400
    err = _check_caja(db, p["caja_id"])
    if err:
        return jsonify({"error": err}), 400
    try:
        photo, mime = _photo_bytes_from_request(db)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    remove_photo = False
    if request.is_json:
        remove_photo = bool((request.get_json(silent=True) or {}).get("remove_photo"))
    elif "remove_photo" in request.form:
        remove_photo = True
    new_vals = (
        p["description"], p["purchase_usd"], p["cost_lps"], p["sale_lps"],
        p["caja_id"], p["size_shoes"], p["size_shirts"], p["quantity"],
    )
    if photo is not None:
        db.execute(
            "UPDATE products SET description=?, photo=?, photo_mime=?,"
            " purchase_usd=?, cost_lps=?, sale_lps=?,"
            " caja_id=?, size_shoes=?, size_shirts=?, quantity=? WHERE id=?",
            (p["description"], photo, mime or "") + new_vals[1:] + (pid,),
        )
    elif remove_photo:
        db.execute(
            "UPDATE products SET description=?, photo=NULL, photo_mime='',"
            " purchase_usd=?, cost_lps=?, sale_lps=?,"
            " caja_id=?, size_shoes=?, size_shirts=?, quantity=? WHERE id=?",
            new_vals + (pid,),
        )
    else:
        db.execute(
            "UPDATE products SET description=?,"
            " purchase_usd=?, cost_lps=?, sale_lps=?,"
            " caja_id=?, size_shoes=?, size_shirts=?, quantity=? WHERE id=?",
            new_vals + (pid,),
        )
    db.commit()
    return jsonify({"ok": True})


@app.route("/api/products/<int:pid>", methods=["DELETE"])
def api_delete_product(pid):
    db = get_db()
    row = db.execute("SELECT id FROM products WHERE id=?", (pid,)).fetchone()
    if not row:
        return jsonify({"error": "Producto no encontrado."}), 404
    db.execute("DELETE FROM products WHERE id=?", (pid,))
    db.commit()
    return jsonify({"ok": True})


@app.route("/api/products/<int:pid>/sold", methods=["PUT"])
def api_mark_sold(pid):
    """Marca o desmarca un producto como vendido: {"sold": true|false}."""
    db = get_db()
    row = db.execute("SELECT id FROM products WHERE id=?", (pid,)).fetchone()
    if not row:
        return jsonify({"error": "Producto no encontrado."}), 404
    data = request.get_json(silent=True) or {}
    sold = 1 if data.get("sold") in (True, 1, "1", "true", "sí", "si") else 0
    if sold:
        db.execute("UPDATE products SET sold=1, lost=0 WHERE id=?", (pid,))
    else:
        db.execute("UPDATE products SET sold=0 WHERE id=?", (pid,))
    db.commit()
    return jsonify({"ok": True, "sold": bool(sold)})


@app.route("/api/products/<int:pid>/lost", methods=["PUT"])
def api_mark_lost(pid):
    """Marca o desmarca un producto como pérdida: {"lost": true|false}.

    Una pérdida es excluyente con la venta: al marcar pérdida se quita
    el vendido, y al vender se quita la pérdida.
    """
    db = get_db()
    row = db.execute("SELECT id FROM products WHERE id=?", (pid,)).fetchone()
    if not row:
        return jsonify({"error": "Producto no encontrado."}), 404
    data = request.get_json(silent=True) or {}
    lost = 1 if data.get("lost") in (True, 1, "1", "true", "sí", "si") else 0
    if lost:
        db.execute("UPDATE products SET lost=1, sold=0 WHERE id=?", (pid,))
    else:
        db.execute("UPDATE products SET lost=0 WHERE id=?", (pid,))
    db.commit()
    return jsonify({"ok": True, "lost": bool(lost)})


@app.route("/api/products/sold_all", methods=["POST"])
def api_mark_sold_all():
    """Marca vendidos todos los ids recibidos: {"ids": [1,2,3]}.

    El frontend envía los ids de los productos visibles (respeta la
    inversión, el buscador y los filtros activos). Devuelve cuántos marcó.
    """
    db = get_db()
    data = request.get_json(silent=True) or {}
    ids = data.get("ids") or []
    ids = [int(i) for i in ids if str(i).isdigit()]
    sold = 0 if data.get("sold") in (False, 0, "0", "false", "no") else 1
    if not ids:
        return jsonify({"ok": True, "marcados": 0})
    # Lotes para no exceder el límite de variables de SQLite
    marcados = 0
    for j in range(0, len(ids), 500):
        lote = ids[j:j + 500]
        ph = ",".join("?" for _ in lote)
        cur = db.execute(
            "UPDATE products SET sold=? WHERE id IN (%s)" % ph, [sold] + lote)
        marcados += cur.rowcount
    db.commit()
    return jsonify({"ok": True, "marcados": marcados})


@app.route("/api/products/lost_all", methods=["POST"])
def api_mark_lost_all():
    """Marca como pérdida todos los ids recibidos: {"ids": [1,2,3]}.

    La pérdida es excluyente con la venta: también quita el vendido.
    Devuelve cuántos marcó.
    """
    db = get_db()
    data = request.get_json(silent=True) or {}
    ids = data.get("ids") or []
    ids = [int(i) for i in ids if str(i).isdigit()]
    if not ids:
        return jsonify({"ok": True, "marcados": 0})
    marcados = 0
    for j in range(0, len(ids), 500):
        lote = ids[j:j + 500]
        ph = ",".join("?" for _ in lote)
        cur = db.execute(
            "UPDATE products SET lost=1, sold=0 WHERE id IN (%s)" % ph, lote)
        marcados += cur.rowcount
    db.commit()
    return jsonify({"ok": True, "marcados": marcados})


@app.route("/api/pending", methods=["GET"])
def api_pending():
    """Conteo de pendientes: sin foto, sin precio de venta y gastos en $0."""
    db = get_db()
    caja_id, err = _parse_caja_param(request.args.get("caja_id", ""))
    if err:
        return jsonify({"error": err}), 400
    pf = "WHERE p.caja_id=?" if caja_id is not None else ""
    pp = [caja_id] if caja_id is not None else []
    and_pf = (pf + " AND") if pf else "WHERE"
    # Las cajas exentas de fotos no cuentan como pendientes de foto.
    sin_foto = db.execute(
        "SELECT COUNT(*) AS n FROM products p LEFT JOIN cajas c ON c.id=p.caja_id"
        " %s p.photo IS NULL AND COALESCE(c.exenta_fotos, 0)=0" % and_pf, pp
    ).fetchone()["n"]
    sin_precio = db.execute(
        "SELECT COUNT(*) AS n FROM products p %s (p.sale_lps IS NULL OR p.sale_lps=0)"
        " AND COALESCE(p.lost, 0)=0" % and_pf, pp
    ).fetchone()["n"]
    ef = "WHERE e.caja_id=?" if caja_id is not None else ""
    epp = [caja_id] if caja_id is not None else []
    and_ef = (ef + " AND") if ef else "WHERE"
    # El Tax de una caja exenta no cuenta como gasto pendiente.
    gastos = db.execute(
        "SELECT COUNT(*) AS n FROM expenses e LEFT JOIN cajas c ON c.id=e.caja_id"
        " %s ((e.amount_usd IS NULL OR e.amount_usd=0) AND (e.amount_lps IS NULL OR e.amount_lps=0))"
        " AND NOT (lower(trim(e.name))='tax' AND COALESCE(c.exenta_tax, 0)=1)" % and_ef, epp
    ).fetchone()["n"]
    return jsonify({"sin_foto": sin_foto, "sin_precio": sin_precio,
                    "gastos_pendientes": gastos})


# ---------------- API: fotos ----------------

@app.route("/api/upload", methods=["POST"])
def api_upload():
    """Sube una foto y devuelve un upload_id temporal (para la vista previa)."""
    if "file" not in request.files:
        return jsonify({"error": "No se envió ningún archivo."}), 400
    f = request.files["file"]
    if not f.filename:
        return jsonify({"error": "Archivo sin nombre."}), 400
    ext = f.filename.rsplit(".", 1)[-1].lower() if "." in f.filename else ""
    if ext not in ALLOWED_EXT:
        return jsonify({"error": "Solo se permiten imágenes (PNG, JPG, WEBP, GIF)."}), 400
    try:
        data, mime = _process_image(f.stream.read())
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    uid = uuid.uuid4().hex
    db = get_db()
    db.execute(
        "DELETE FROM pending_uploads WHERE created_at < ?",
        (int(time.time()) - 86400,),
    )
    db.execute(
        "INSERT INTO pending_uploads(id, data, mime, created_at) VALUES(?,?,?,?)",
        (uid, data, mime, int(time.time())),
    )
    db.commit()
    return jsonify({"url": f"/api/photo/pending/{uid}", "upload_id": uid}), 201


@app.route("/api/photo/pending/<uid>")
def photo_pending(uid):
    """Sirve una foto recién subida (vista previa antes de guardar)."""
    db = get_db()
    row = db.execute(
        "SELECT data, mime FROM pending_uploads WHERE id=?", (uid,)
    ).fetchone()
    if not row or not row["data"]:
        return jsonify({"error": "No encontrado."}), 404
    return app.response_class(bytes(row["data"]), mimetype=row["mime"] or "image/jpeg")


@app.route("/api/photo/<int:pid>")
def photo_product(pid):
    """Sirve la foto guardada de un producto."""
    db = get_db()
    row = db.execute(
        "SELECT photo, photo_mime FROM products WHERE id=?", (pid,)
    ).fetchone()
    if not row or not row["photo"]:
        return jsonify({"error": "No encontrado."}), 404
    return app.response_class(
        bytes(row["photo"]), mimetype=row["photo_mime"] or "image/jpeg"
    )


# ---------------- API: gastos ----------------

@app.route("/api/expenses", methods=["GET"])
def api_list_expenses():
    db = get_db()
    rows = db.execute(
        "SELECT e.id, e.name, e.amount_usd, e.amount_lps, e.caja_id, c.name AS caja_name"
        " FROM expenses e LEFT JOIN cajas c ON c.id=e.caja_id ORDER BY e.id"
    ).fetchall()
    return jsonify([dict(zip(
        ["id", "name", "amount_usd", "amount_lps", "caja_id", "caja_name"], r)) for r in rows])


def _expense_caja_id(db, data):
    raw = data.get("caja_id")
    if raw in (None, "", "none", "null"):
        return None, None
    try:
        cid = int(raw)
    except (TypeError, ValueError):
        return None, "«Caja» no es válida."
    err = _check_caja(db, cid)
    return (None, err) if err else (cid, None)


@app.route("/api/expenses", methods=["POST"])
def api_create_expense():
    data = request.get_json(silent=True) or {}
    name = (data.get("name") or "").strip()
    if not name:
        return jsonify({"error": "El nombre del gasto es obligatorio."}), 400
    usd, err = _num(data.get("amount_usd"), "Monto en $")
    if err:
        return jsonify({"error": err}), 400
    lps, err = _num(data.get("amount_lps"), "Monto en LPS")
    if err:
        return jsonify({"error": err}), 400
    db = get_db()
    caja_id, err = _expense_caja_id(db, data)
    if err:
        return jsonify({"error": err}), 400
    cur = db.execute(
        "INSERT INTO expenses(name, amount_usd, amount_lps, caja_id) VALUES(?,?,?,?)",
        (name, usd, lps, caja_id),
    )
    db.commit()
    return jsonify({"id": cur.lastrowid, "name": name, "amount_usd": usd,
                    "amount_lps": lps, "caja_id": caja_id}), 201


@app.route("/api/expenses/<int:eid>", methods=["PUT"])
def api_update_expense(eid):
    db = get_db()
    row = db.execute("SELECT id FROM expenses WHERE id=?", (eid,)).fetchone()
    if not row:
        return jsonify({"error": "Gasto no encontrado."}), 404
    data = request.get_json(silent=True) or {}
    name = (data.get("name") or "").strip()
    if not name:
        return jsonify({"error": "El nombre del gasto es obligatorio."}), 400
    usd, err = _num(data.get("amount_usd"), "Monto en $")
    if err:
        return jsonify({"error": err}), 400
    lps, err = _num(data.get("amount_lps"), "Monto en LPS")
    if err:
        return jsonify({"error": err}), 400
    caja_id, err = _expense_caja_id(db, data)
    if err:
        return jsonify({"error": err}), 400
    db.execute(
        "UPDATE expenses SET name=?, amount_usd=?, amount_lps=?, caja_id=? WHERE id=?",
        (name, usd, lps, caja_id, eid),
    )
    db.commit()
    return jsonify({"ok": True})


@app.route("/api/expenses/<int:eid>", methods=["DELETE"])
def api_delete_expense(eid):
    db = get_db()
    row = db.execute("SELECT id FROM expenses WHERE id=?", (eid,)).fetchone()
    if not row:
        return jsonify({"error": "Gasto no encontrado."}), 404
    db.execute("DELETE FROM expenses WHERE id=?", (eid,))
    db.commit()
    return jsonify({"ok": True})


# ---------------- API: cajas (grupos por enviada) ----------------

@app.route("/api/cajas", methods=["GET"])
def api_list_cajas():
    db = get_db()
    rows = db.execute(
        "SELECT c.id, c.name, COUNT(p.id) AS n_products,"
        " COALESCE(c.exenta_fotos, 0) AS exenta_fotos,"
        " COALESCE(c.exenta_tax, 0) AS exenta_tax FROM cajas c"
        " LEFT JOIN products p ON p.caja_id=c.id"
        " GROUP BY c.id ORDER BY c.sort_order, c.id"
    ).fetchall()
    return jsonify([dict(zip(
        ["id", "name", "n_products", "exenta_fotos", "exenta_tax"], r))
        for r in rows])


def _ensure_caja_expenses(db, caja_id):
    """Cada inversión debe tener siempre sus tarjetas Tax y Envío.

    Crea en $0 las que falten (idempotente). Se usa al crear una caja,
    en el arranque (para cajas anteriores) y donde se listen gastos.
    """
    for exp_name in ("Tax", "Envío"):
        row = db.execute(
            "SELECT id FROM expenses WHERE caja_id=? AND lower(trim(name))=lower(?)",
            (caja_id, exp_name),
        ).fetchone()
        if not row:
            db.execute(
                "INSERT INTO expenses(name, amount_usd, amount_lps, caja_id)"
                " VALUES(?,?,?,?)",
                (exp_name, 0, 0, caja_id),
            )


@app.route("/api/cajas", methods=["POST"])
def api_create_caja():
    data = request.get_json(silent=True) or {}
    name = (data.get("name") or "").strip()[:80]
    if not name:
        return jsonify({"error": "El nombre de la inversión es obligatorio."}), 400
    db = get_db()
    mx = db.execute("SELECT COALESCE(MAX(sort_order), 0) FROM cajas").fetchone()[0]
    cur = db.execute(
        "INSERT INTO cajas(name, created_at, sort_order) VALUES(?,?,?)",
        (name, int(time.time()), mx + 1),
    )
    new_id = cur.lastrowid
    # Cada inversión nace con sus propios Tax y Envío en $0, sin mezclarse
    # con los de otras carpetas; él solo edita los montos.
    _ensure_caja_expenses(db, new_id)
    for flag in ("exenta_fotos", "exenta_tax"):
        if data.get(flag) in (True, 1, "1", "true"):
            db.execute("UPDATE cajas SET %s=1 WHERE id=?" % flag, (new_id,))
    db.commit()
    return jsonify({"id": new_id, "name": name}), 201


@app.route("/api/cajas/<int:cid>", methods=["PUT"])
def api_update_caja(cid):
    db = get_db()
    row = db.execute("SELECT id FROM cajas WHERE id=?", (cid,)).fetchone()
    if not row:
        return jsonify({"error": "Caja no encontrada."}), 404
    data = request.get_json(silent=True) or {}
    name = (data.get("name") or "").strip()[:80]
    if not name:
        return jsonify({"error": "El nombre de la inversión es obligatorio."}), 400
    db.execute("UPDATE cajas SET name=? WHERE id=?", (name, cid))
    for flag in ("exenta_fotos", "exenta_tax"):
        if flag in data:
            db.execute("UPDATE cajas SET %s=? WHERE id=?" % flag,
                       (1 if data[flag] in (True, 1, "1", "true") else 0, cid))
    if "sort_order" in data:
        try:
            so = int(data["sort_order"])
        except (TypeError, ValueError):
            return jsonify({"error": "sort_order no válido."}), 400
        db.execute("UPDATE cajas SET sort_order=? WHERE id=?", (so, cid))
    db.commit()
    return jsonify({"ok": True})


@app.route("/api/cajas/<int:cid>", methods=["DELETE"])
def api_delete_caja(cid):
    db = get_db()
    row = db.execute("SELECT id FROM cajas WHERE id=?", (cid,)).fetchone()
    if not row:
        return jsonify({"error": "Caja no encontrada."}), 404
    n = db.execute(
        "SELECT COUNT(*) AS n FROM products WHERE caja_id=?", (cid,)
    ).fetchone()["n"]
    if n:
        return jsonify(
            {"error": f"Esta caja tiene {n} producto(s). Muévelos o elimínalos primero."}
        ), 400
    db.execute("DELETE FROM expenses WHERE caja_id=?", (cid,))
    db.execute("DELETE FROM cajas WHERE id=?", (cid,))
    db.commit()
    return jsonify({"ok": True})


# ---------------- API: resumen y hoja ----------------

@app.route("/api/summary")
def api_summary():
    """Totales y datos para las gráficas (recalculados cada vez)."""
    db = get_db()
    caja_id, err = _parse_caja_param(request.args.get("caja_id", ""))
    if err:
        return jsonify({"error": err}), 400
    t = _compute_totals(db, caja_id)
    return jsonify(
        {
            "n_products": t["n_products"],
            "total_usd": t["total_usd"],
            "total_costo_lps": t["total_costo_lps"],
            "total_venta_lps": t["total_venta_lps"],
            "exp_usd": t["exp_usd"],
            "exp_lps": t["exp_lps"],
            "inversion_total_lps": t["inversion_total_lps"],
            "ganancia_libre_total": t["ganancia_libre_total"],
            "n_lost": t["n_lost"],
            "total_perdidas_usd": t["total_perdidas_usd"],
            "total_perdidas_lps": t["total_perdidas_lps"],
            "expenses": [
                {"id": e["id"], "name": e["name"], "amount_usd": e["amount_usd"],
                 "amount_lps": e["amount_lps"]}
                for e in t["expenses"]
            ],
            "by_product": t["by_product"],
        }
    )


SHEET_COLUMNS = ["Describcion",
                 "Total pagado $$", "Pagado en LPS", "Ingresos",
                 "Ganancia libre"]

COMMISSION_NAME = "Comisión tía Wendy"
COMMISSION_RATE = 0.45  # 45% de la ganancia libre (después de compra, envío e impuestos)


def _sheet_data(db, caja_id=None, unassigned=False):
    """Filas de la hoja como la planilla: por producto + resumen."""
    t = _compute_totals(db, caja_id, unassigned)
    products = t["products"]

    def _qty(p):
        q = p["quantity"]
        return q if q not in (None, "") else 1

    rows = []
    for p in products:
        q = _qty(p)
        if p["lost"]:
            # Pérdida: sin ingresos y el costo como número negativo.
            rows.append(
                [
                    p["description"],
                    -float(p["purchase_usd"] or 0) * q,
                    -float(p["cost_lps"] or 0) * q,
                    0,
                    -float(p["cost_lps"] or 0) * q,
                ]
            )
        else:
            rows.append(
                [
                    p["description"],
                    -float(p["purchase_usd"] or 0) * q,
                    -float(p["cost_lps"] or 0) * q,
                    float(p["sale_lps"] or 0) * q,
                    _ganancia_libre(p["cost_lps"], p["sale_lps"]) * q,
                ]
            )
    pad = []
    summary_rows = [
        ["Total :"] + pad + [-t["total_usd"], -t["total_costo_lps"], t["total_venta_lps"],
         t["total_venta_lps"] - t["total_costo_lps"]],
    ]
    if t["total_perdidas_lps"]:
        summary_rows.append(
            ["Pérdidas"] + pad + [-t["total_perdidas_usd"], -t["total_perdidas_lps"], "", ""]
        )
    for e in t["expenses"]:
        summary_rows.append(
            [e["name"]] + pad + [-float(e["amount_usd"] or 0), -float(e["amount_lps"] or 0),
             "", ""]
        )
    summary_rows.append(
        ["Total + envío"] + pad + [-(t["total_usd"] + t["exp_usd"]),
         -(t["total_costo_lps"] + t["exp_lps"]), t["total_venta_lps"],
         t["ganancia_libre_total"]]
    )
    comision = t["ganancia_libre_total"] * COMMISSION_RATE
    summary_rows.append(
        [f"{COMMISSION_NAME} (45%)"] + pad + ["", "", "", -comision]
    )
    summary_rows.append(
        ["Christian (55%)"] + pad + ["", "", "",
         t["ganancia_libre_total"] - comision]
    )
    return {"columns": SHEET_COLUMNS, "rows": rows, "summary_rows": summary_rows}


def _fmt_num(v):
    if v == "" or v is None:
        return ""
    try:
        return f"{float(v):.2f}"
    except (TypeError, ValueError):
        return str(v)


def _per_caja_sheets(db):
    """Hojas individuales por caja (vista 'Todas las cajas' en Hoja):
    cada caja con su propia hoja, sin sumar los totales entre cajas.
    Los productos/gastos sin caja asignada van en una hoja aparte
    ('Sin caja asignada') para que nada se pierda."""
    sheets = []
    cajas = db.execute("SELECT id, name FROM cajas ORDER BY sort_order, id").fetchall()
    for c in cajas:
        d = _sheet_data(db, c["id"])
        sheets.append({"caja_id": c["id"], "caja_name": c["name"],
                       "columns": d["columns"], "rows": d["rows"],
                       "summary_rows": d["summary_rows"]})
    n_loose = db.execute(
        "SELECT (SELECT COUNT(*) FROM products WHERE caja_id IS NULL)"
        " + (SELECT COUNT(*) FROM expenses WHERE caja_id IS NULL)"
    ).fetchone()[0]
    if n_loose:
        d = _sheet_data(db, unassigned=True)
        sheets.append({"caja_id": None, "caja_name": "Sin caja asignada",
                       "columns": d["columns"], "rows": d["rows"],
                       "summary_rows": d["summary_rows"]})
    return sheets


@app.route("/api/sheet")
def api_sheet():
    db = get_db()
    raw = request.args.get("caja_id", "")
    if raw == "all":
        # Vista "Todas las cajas": una hoja por caja, sin sumar entre cajas.
        return jsonify({"mode": "per_caja", "sheets": _per_caja_sheets(db)})
    caja_id, err = _parse_caja_param(raw)
    if err:
        return jsonify({"error": err}), 400
    return jsonify(_sheet_data(db, caja_id))


@app.route("/api/sheet.csv")
def api_sheet_csv():
    """Descarga la hoja en CSV (con BOM para que Excel lo abra bien)."""
    db = get_db()
    raw = request.args.get("caja_id", "")
    if raw == "all":
        # Una sección por caja, cada una con su propia hoja.
        sheets = _per_caja_sheets(db)
        out = io.StringIO()
        w = csv.writer(out)
        for i, sh in enumerate(sheets):
            if i:
                w.writerow([])
            w.writerow([f"Caja: {sh['caja_name']}"])
            w.writerow(sh["columns"])
            for r in sh["rows"]:
                w.writerow([r[0]] + [_fmt_num(v) for v in r[1:]])
            w.writerow([])
            for r in sh["summary_rows"]:
                w.writerow([r[0]] + [_fmt_num(v) for v in r[1:]])
        data = "\ufeff" + out.getvalue()  # BOM para Excel
        return Response(
            data,
            mimetype="text/csv; charset=utf-8",
            headers={"Content-Disposition": "attachment; filename=inventario-todas.csv"},
        )
    caja_id, err = _parse_caja_param(raw)
    if err:
        return jsonify({"error": err}), 400
    sheet = _sheet_data(db, caja_id)
    out = io.StringIO()
    w = csv.writer(out)
    w.writerow(sheet["columns"])
    for r in sheet["rows"]:
        w.writerow([r[0]] + [_fmt_num(v) for v in r[1:]])
    w.writerow([])
    for r in sheet["summary_rows"]:
        w.writerow([r[0]] + [_fmt_num(v) for v in r[1:]])
    data = "\ufeff" + out.getvalue()  # BOM para Excel
    fname = "inventario.csv"
    if caja_id:
        cname = _caja_name(db, caja_id) or f"caja-{caja_id}"
        safe = "".join(ch if ch.isalnum() else "-" for ch in cname).strip("-")[:40] or f"caja-{caja_id}"
        fname = f"inventario-{safe}.csv"
    return Response(
        data,
        mimetype="text/csv; charset=utf-8",
        headers={"Content-Disposition": f"attachment; filename={fname}"},
    )


if __name__ == "__main__":
    init_db()
    port = int(os.environ.get("PORT", "8080"))
    print(f"{APP_NAME} listo en http://localhost:{port}")
    from waitress import serve
    serve(app, host="0.0.0.0", port=port)
