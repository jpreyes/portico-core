#!/usr/bin/env bash
# Regenera TODOS los PDF de verificación desde sus .md (con membrete del proyecto).
#   bash tools/build_verifs.sh            # todos
#   bash tools/build_verifs.sh 1-014      # sólo los que matcheen el patrón
set -e
cd "$(dirname "$0")/.."
LOGOS=""
pat="${1:-}"
for md in docs/verificaciones/*.md; do
  [ -e "$md" ] || continue
  case "$md" in *_preview*) continue;; esac
  if [ -n "$pat" ] && [[ "$md" != *"$pat"* ]]; then continue; fi
  node tools/md2pdf.mjs "$md" --logos "$LOGOS" >/dev/null && echo "✓ ${md%.md}.pdf"
done
echo "Listo."
