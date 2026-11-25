#!/usr/bin/env bash
# Saca un respaldo de MongoDB de MI PC para llevarlo a la VM.
# Solo Mongo, porque:
#  - Neo4j (usuarios y roles) se reconstruye solo desde Mongo cuando arranca
#    seguridad-service (syncUsersToGraph), y el catálogo de rutas se siembra solo.
#  - Redis solo tiene sesiones y caché; en la nube hay otro JWT_SECRET, así
#    que esas sesiones ya no servirían de todos modos.
#  - La auditoría de Scylla no hace falta para que la app funcione.
#
# Uso (en Git Bash, en mi PC, con Docker prendido):
#   bash Despliegue/respaldar-pc.sh
# Deja el archivo en Despliegue/respaldo/mongo.gz (pesa ~1 MB).
set -euo pipefail

RAIZ="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$RAIZ/Despliegue/respaldo"

# En mi PC Mongo sigue con las credenciales de siempre (admin/password123).
# Nota para mí: mongodump NO tiene --nsExclude (solo mongorestore), así que
# aquí saco todo y el filtro de admin.* / config.* lo hace restaurar-vm.sh.
# MSYS_NO_PATHCONV=1 es para que Git Bash no convierta /tmp en C:\...\tmp.
MSYS_NO_PATHCONV=1 docker exec ulsa-mongodb mongodump \
  -u admin -p password123 --authenticationDatabase admin \
  --gzip --archive=/tmp/mongo.gz

# Ojo: con MSYS_NO_PATHCONV=1 Git Bash tampoco convierte MI ruta (/c/Users...)
# y docker no la encuentra; por eso me meto a la carpeta y copio a ".".
cd "$RAIZ/Despliegue/respaldo"
MSYS_NO_PATHCONV=1 docker cp ulsa-mongodb:/tmp/mongo.gz .
MSYS_NO_PATHCONV=1 docker exec ulsa-mongodb rm -f /tmp/mongo.gz

echo "Respaldo listo: Despliegue/respaldo/mongo.gz ($(du -h "$RAIZ/Despliegue/respaldo/mongo.gz" | cut -f1))"
echo "Ojo: trae emails y datos de usuarios. No se sube a git (está en .gitignore)."
echo "Pásalo a la VM con:"
echo "  scp Despliegue/respaldo/mongo.gz <usuario>@<IP_VM>:~/"
