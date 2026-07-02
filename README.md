# Mis Mazos MTG

PWA móvil: entras en un mazo y te dice **qué cartas le faltan** y **en qué otro mazo están** (o si no están en ninguno).

- **Mazos**: se sacan de Archidekt automáticamente con un GitHub Action (sin problema de CORS porque corre en servidor) y se publican en GitHub Pages.
- **Colección**: la importas tú desde el móvil con el CSV que exporta ManaBox. Se guarda solo en el dispositivo (localStorage), no se sube a ningún sitio.

## Cómo funciona el cálculo

Para un mazo, una carta **falta** si tienes menos copias en tu colección que el total que piden todos tus mazos juntos. De cada carta que falta:

- 📍 **Está en: X, Y** — tienes copia(s), pero están en esos mazos: sácala de ahí.
- 🛒 **No la tienes** — no está en ningún mazo (hay que conseguirla).
- ⚠️ **Te faltan N copias** — solo este mazo la usa pero no tienes suficientes.

Las tierras básicas se ocultan por defecto (toggle para mostrarlas).

## Otras vistas

- **Cambios vs Archidekt** (pestaña dentro de cada mazo): compara la carpeta física del mazo en ManaBox (`Binder Type = deck`) con la lista de Archidekt y dice qué **meter** (➕) y qué **sacar** (➖) para dejarlo igual. Para las cartas a meter, avisa si las tienes sueltas en tu pool.
- **Movimientos de precio** (botón en la portada): guarda "fotos" de precio de tu colección desde Scryfall (EUR) y muestra las que más han subido/bajado. El histórico se construye desde que empiezas a usarla (necesita ≥2 fotos en días distintos). Requiere que el CSV de ManaBox incluya la columna `Scryfall ID`.

## Puesta en marcha (una vez)

1. Crea un repo **público** en GitHub y sube este contenido.
2. En el repo: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. Ve a **Actions → "Actualizar mazos y publicar" → Run workflow**. Generará `data/decks-data.json` y publicará el sitio.
4. Abre la URL de Pages en el móvil y **Añadir a pantalla de inicio**.

## Uso diario

- **Actualizar colección**: en ManaBox, *Exportar colección → CSV*, compártelo al móvil y dale a *Importar colección* en la app.
- **Actualizar mazos**: el Action corre solo cada día. Para forzarlo desde el móvil: app de GitHub → Actions → Run workflow. (O edita un mazo en Archidekt y espera al cron.)

## Mantener mazos sincronizados

La lista de mazos está en [`config.js`](config.js). Mantenla igual que `deck_builder/config.js` del repo privado.

## Local

```bash
node fetch-decks.js          # genera data/decks-data.json
python3 -m http.server 8080  # y abre http://localhost:8080
```
