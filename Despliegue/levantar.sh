#!/usr/bin/env bash
# Levanta todo en la VM, en el mismo orden que en mi PC:
#   1) las 5 BD en Docker  2) espera a que estén listas  3) los 6 servicios.
#
# Uso:  bash Despliegue/levantar.sh
# Sirve para la primera vez, después de un "git pull" y al reiniciar la VM
# (instalar-vm.sh lo deja programado con @reboot). Se puede correr las veces
# que quiera: lo que ya está prendido se reinicia con el código nuevo.
set -euo pipefail

RAIZ="$(cd "$(dirname "$0")/.." && pwd)"
cd "$RAIZ"

if [[ ! -f Docker/.env ]]; then
  echo "Falta Docker/.env. Corre primero: bash Despliegue/generar-env.sh"
  exit 1
fi

# Saco las contraseñas para poder preguntarle a cada BD si ya responde.
set -a
# shellcheck disable=SC1091
source Docker/.env
set +a

echo "==> 1) Bases de datos (Docker)"
docker compose \
  --env-file Docker/.env \
  -f Docker/docker-compose.yml \
  -f Despliegue/docker-compose.nube.yml \
  up -d

# Pregunta cada 5 s hasta que la BD conteste (máximo ~5 min).
esperar() {
  local nombre="$1"; shift
  printf "    esperando %-10s" "$nombre"
  for _ in $(seq 1 60); do
    if "$@" >/dev/null 2>&1; then
      echo " lista"
      return 0
    fi
    printf "."
    sleep 5
  done
  echo " NO respondió. Revisa: docker logs ulsa-$nombre"
  exit 1
}

echo "==> 2) Esperando a que respondan"
esperar mongodb  docker exec ulsa-mongodb mongosh --quiet --eval 'db.runCommand({ ping: 1 }).ok'
esperar redis    sh -c "docker exec ulsa-redis-stack redis-cli -a \"$REDIS_PASSWORD\" --no-auth-warning ping | grep -q PONG"
esperar neo4j    docker exec ulsa-neo4j cypher-shell -u neo4j -p "$NEO4J_PASSWORD" 'RETURN 1'
esperar rabbitmq docker exec ulsa-rabbitmq rabbitmq-diagnostics -q ping
# Scylla es el que más tarda y auditoría solo intenta conectarse UNA vez al
# arrancar (si falla, su worker se queda apagado). Por eso lo espero sí o sí.
esperar scylladb docker exec ulsa-scylladb cqlsh -e 'SELECT now() FROM system.local'

echo "==> 3) Dependencias de Node (solo si faltan o cambió el package-lock)"
for carpeta in Proyecto/gateway Proyecto/services/*-service; do
  if [[ ! -f "$carpeta/node_modules/.package-lock.json" || "$carpeta/package-lock.json" -nt "$carpeta/node_modules/.package-lock.json" ]]; then
    echo "    npm ci en $carpeta"
    (cd "$carpeta" && npm ci --omit=dev --no-audit --no-fund)
  fi
done

echo "==> 4) Servicios (pm2)"
pm2 startOrRestart Despliegue/ecosystem.config.cjs --update-env
pm2 save >/dev/null

echo "==> 5) Revisando el Gateway"
for _ in $(seq 1 30); do
  if curl -fsS -X POST http://localhost:4000/ \
       -H 'content-type: application/json' \
       -d '{"query":"{ __typename }"}' >/dev/null 2>&1; then
    echo
    pm2 status
    echo
    echo "Todo arriba. Prueba desde tu PC:  https://$(grep -oE '[0-9-]+\.sslip\.io' /etc/caddy/Caddyfile 2>/dev/null || echo '<tu-dominio>')/"
    exit 0
  fi
  sleep 5
done

echo "El Gateway no respondió en 2.5 min. Revisa: pm2 logs gateway --lines 50"
exit 1
