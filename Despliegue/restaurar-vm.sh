#!/usr/bin/env bash
# Carga en la VM el respaldo de Mongo que saqué en mi PC (respaldar-pc.sh).
#
# Uso (en la VM, DESPUÉS de que levantar.sh ya funcionó al menos una vez):
#   bash Despliegue/restaurar-vm.sh ~/mongo.gz
#
# Nota para mí: uso --drop, o sea que cada colección del respaldo REEMPLAZA a
# la que haya en la VM. Si ya registré gente directo en la nube, se pierde.
set -euo pipefail

ARCHIVO="${1:-}"
if [[ -z "$ARCHIVO" || ! -f "$ARCHIVO" ]]; then
  echo "Uso: bash Despliegue/restaurar-vm.sh <ruta-al-mongo.gz>"
  exit 1
fi

RAIZ="$(cd "$(dirname "$0")/.." && pwd)"
set -a
# shellcheck disable=SC1091
source "$RAIZ/Docker/.env"
set +a

echo "==> Restaurando Mongo (reemplaza las colecciones que vengan en el respaldo)"
docker cp "$ARCHIVO" ulsa-mongodb:/tmp/mongo.gz
docker exec ulsa-mongodb mongorestore \
  -u "$MONGO_ROOT_USER" -p "$MONGO_ROOT_PASSWORD" --authenticationDatabase admin \
  --nsExclude='admin.*' --nsExclude='config.*' \
  --drop --gzip --archive=/tmp/mongo.gz
# admin.* trae el usuario viejo admin/password123 de mi PC: no lo quiero en
# la nube. config.* es interna de Mongo.
docker exec ulsa-mongodb rm -f /tmp/mongo.gz

echo "==> Reiniciando servicios"
# seguridad copia los usuarios de Mongo a Neo4j al arrancar; sin esto el
# Gateway trataría a los usuarios restaurados como si no tuvieran rol.
# Los demás los reinicio para que recreen sus índices sobre los datos nuevos.
pm2 restart seguridad academico deportes mapa --update-env
sleep 10
pm2 restart gateway --update-env

echo "Listo. Ya puedes hacer login con los mismos usuarios y contraseñas que en tu PC."
