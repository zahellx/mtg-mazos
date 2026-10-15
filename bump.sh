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
# Cualquier .js/.css local referenciado en cualquier HTML, para no olvidarse
# de ninguna pagina al anadir una nueva (paso con escanear.html).
for f in *.html; do
  sed -i -E 's#((href|src)="[a-zA-Z0-9_-]+\.(css|js))(\?v=[0-9]+)?"#\1?v='"${new}"'"#g' "$f"
done

echo "Versión $cur -> $new"
grep -o 'mtg-mazos-v[0-9]*' sw.js | head -1
grep -o 'APP_VERSION = "v[0-9]*"' sync.js
echo "HTML apuntando a: $(grep -ho '?v=[0-9]*' ./*.html | sort -u | tr '\n' ' ')"
