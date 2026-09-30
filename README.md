# Importaciones a Puerto Castilla

Inventario personal de importaciones: foto por producto (tomada con la
cámara del teléfono), precio de compra en USD, costo en LPS, precio de venta
en LPS y ganancia libre calculada. Incluye gastos (Tax, Envío…), gráficas
circulares y una hoja auto-generada que se puede imprimir y descargar en
CSV. Interfaz 100% en español, pensada para el teléfono.

> **Esta app es un proyecto totalmente independiente.** No tiene nada que ver
> con ninguna otra aplicación: no comparte base de datos, repositorio ni
> servicio con ningún otro proyecto.

## Lo que hace

- **📦 Productos:** tarjetas con la foto arriba y, debajo de la foto, los
  números con sus descripciones: Precio compra $, Pagado en LPS, Ganancia y
  Ganancia libre. Editar y eliminar (pide confirmación).
- **＋ Agregar:** primero la foto (el teléfono abre la cámara), luego la
  descripción, el precio en $, el costo en LPS y el precio de venta en LPS.
- **🧾 Gastos:** categorías de gasto (viene con *Tax* y *Envío*, editables),
  con montos en $ y en LPS. Se pueden agregar más y eliminar.
- **📊 Gráficas:** dona *Inversión vs Ganancia libre* y pastel *Ganancia por
  producto (top 8 + Otros)*, dibujadas con SVG puro (sin internet), se
  recalculan cada vez que se abre la pestaña.
- **📄 Hoja:** genera automáticamente la tabla como la planilla (Describcion |
  Total pagado $$ | Pagado en LPS | Ganancia | Menos gastos ganancia libre),
  con filas de resumen Total, Tax, Envío y Total + envío. Botones para
  **Imprimir** (formato limpio para papel) y **Descargar CSV**.
- **💾 Base de datos en la nube:** los datos viven en Turso (base de datos
  **importaciones**). Nada se borra con despliegues ni reinicios. La app abre
  directo, sin contraseña.

## Matemáticas

- Por producto: `ganancia_libre = precio_venta_lps − costo_lps`
- Totales: `inversion_total_lps = Σ costos_lps + Σ gastos_lps`;
  `ganancia_libre_total = Σ ventas_lps − inversion_total_lps`

## Correr en local

```bash
./start.sh
# o con otro puerto: PORT=9000 ./start.sh
```

Abre http://localhost:8080. (El script crea un entorno virtual e instala las
dependencias la primera vez.)

## Publicarla en Render (paso a paso)

1. **Crear la base de datos en Turso.** Entra a tu cuenta de Turso
   (dashboard.turso.tech) y crea una base de datos nueva llamada
   exactamente **`importaciones`**. Copia su URL (`libsql://…`) y crea un
   token de acceso (auth token).
2. **Crear el repositorio en GitHub.** Crea un repositorio nuevo llamado
   **`importaciones-puerto-castilla`** y sube esta carpeta:
   ```bash
   git init
   git add .
   git commit -m "Importaciones a Puerto Castilla"
   git branch -M main
   git remote add origin https://github.com/TU-USUARIO/importaciones-puerto-castilla.git
   git push -u origin main
   ```
3. **Crear el servicio en Render.** En dashboard.render.com → *New +* →
   *Web Service* → conecta el repositorio `importaciones-puerto-castilla`.
   Ponle de nombre **`importaciones`**. Render detecta el `render.yaml` y
   configura el arranque solo.
4. **Variables de entorno.** En el servicio de Render → *Environment*, agrega:
   - `TURSO_URL` = la URL de tu base de datos `importaciones`
     (ej. `libsql://importaciones-TU-USUARIO.turso.io`)
   - `TURSO_TOKEN` = el token que creaste en Turso
5. **Desplegar.** Dale a *Deploy*. Al arrancar, la app crea las tablas y las
   categorías Tax/Envío automáticamente.

> ⚠️ Sin `TURSO_URL` y `TURSO_TOKEN` la app funciona, pero los datos se
> guardan solo en el disco temporal de Render y **se pierden con cada
> despliegue**. Con Turso configurado, nada se pierde.

## Instalarla en el teléfono

1. Abre la dirección de tu app en el navegador del teléfono (la que te da
   Render, ej. `https://importaciones.onrender.com`).
2. En iPhone (Safari): toca *Compartir* → *Agregar a pantalla de inicio*.
3. En Android (Chrome): toca el menú ⋮ → *Instalar app* / *Agregar a pantalla
   de inicio*.
4. Se instala como **Importaciones** con su icono de caja. Abre a pantalla
   completa, como una app nativa.

## Estructura

```
app.py               → servidor Flask + base de datos (Turso/SQLite)
templates/index.html → la app de una sola página (5 pestañas)
static/style.css     → estilos mobile-first + CSS de impresión
static/app.js        → lógica: productos, fotos, gastos, gráficas, hoja
static/sw.js         → service worker (funciona sin internet para lo básico)
static/manifest.json → (se genera en /manifest.json con el nombre de la app)
static/icon-*.png    → iconos de la app
render.yaml          → configuración del servicio "importaciones" en Render
start.sh             → arranque local
tests/test_app.py    → 16 pruebas (pytest)
```

## Pruebas

```bash
python3 -m venv venv
./venv/bin/pip install -r requirements.txt
./venv/bin/python -m pytest tests/ -q
```
