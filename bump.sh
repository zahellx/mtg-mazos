#!/usr/bin/env bash
# Sube la versión de la app en TODOS los sitios a la vez, para que los
# dispositivos no se queden con ficheros viejos cacheados.
#   ./bump.sh          -> siguiente versión
#   ./bump.sh 60       -> fija la versión 60
set -euo pipefail
cd "$(dirname "$0")"

cur=$(grep -o 'mtg-mazos-v[0-9]*' sw.js | head -1 | sed 's/.*-v//')
new=${1:-$((cur + 1))}

sed -i "s/mtg-mazos-v[0-9]*/mtg-mazos-v${new}/" sw.js
sed -i "s/const APP_VERSION = \"v[0-9]*\"/const APP_VERSION = \"v${new}\"/" sync.js
# ?v=N en los assets del HTML: obliga al navegador a pedir URLs nuevas.
for f in index.html deck-builder.html; do
  sed -i -E 's#(href="styles\.css)(\?v=[0-9]+)?"#\1?v='"${new}"'"#' "$f"
  sed -i -E 's#(src="(img|card-modal|sync|app|deck-builder)\.js)(\?v=[0-9]+)?"#\1?v='"${new}"'"#g' "$f"
done

echo "Versión $cur -> $new"
grep -o 'mtg-mazos-v[0-9]*' sw.js | head -1
grep -o 'APP_VERSION = "v[0-9]*"' sync.js
grep -o 'src="[a-z-]*\.js?v=[0-9]*"' index.html | head -4
