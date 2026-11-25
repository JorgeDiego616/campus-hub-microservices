#!/usr/bin/env bash
# Crea todos los .env de la nube con contraseñas nuevas y aleatorias:
#   Docker/.env  +  el .env del gateway y de los 5 servicios.
#
# Uso (en la VM, una sola vez, ANTES del primer levantar.sh):
#   bash Despliegue/generar-env.sh
#
# Nota para mí: Mongo, Neo4j y Rabbit solo leen su contraseña la PRIMERA vez
# que se crea su volumen. Por eso esto va antes del primer docker compose up.
# Si ya existe algún .env no lo piso (podría dejar las BD con una contraseña
# y los servicios con otra); para regenerar a propósito: FORZAR=1.
set -euo pipefail

RAIZ="$(cd "$(dirname "$0")/.." && pwd)"
P="$RAIZ/Proyecto"

ARCHIVOS=(
  "$RAIZ/Docker/.env"
  "$P/gateway/.env"
  "$P/services/seguridad-service/.env"
  "$P/services/academico-service/.env"
  "$P/services/deportes-service/.env"
  "$P/services/mapa-service/.env"
  "$P/services/auditoria-service/.env"
)

if [[ "${FORZAR:-0}" != "1" ]]; then
  for archivo in "${ARCHIVOS[@]}"; do
    if [[ -f "$archivo" ]]; then
      echo "Ya existe $archivo y no lo voy a sobrescribir."
      echo "Si de verdad quieres generar todo de nuevo: FORZAR=1 bash Despliegue/generar-env.sh"
      exit 1
    fi
  done
fi

# Hex para que no salgan caracteres como / @ : que rompen las URIs.
MONGO_PASS="$(openssl rand -hex 24)"
REDIS_PASS="$(openssl rand -hex 24)"
NEO4J_PASS="$(openssl rand -hex 24)"
RABBIT_PASS="$(openssl rand -hex 24)"
# El mismo JWT_SECRET para los 6 (el Gateway y los subgrafos validan el mismo token).
JWT_SECRET="$(openssl rand -hex 48)"

# Los servicios corren en la VM (no en Docker), igual que en mi PC, así que
# se conectan a las BD por localhost y los puertos de siempre.
MONGO_BASE="mongodb://admin:${MONGO_PASS}@localhost:27018"
REDIS_URL="redis://default:${REDIS_PASS}@localhost:6380"
RABBIT_URL="amqp://ulsa:${RABBIT_PASS}@localhost:5673"

umask 077 # que solo mi usuario pueda leer los .env

cat > "$RAIZ/Docker/.env" <<EOF
MONGO_ROOT_USER=admin
MONGO_ROOT_PASSWORD=${MONGO_PASS}
REDIS_PASSWORD=${REDIS_PASS}
NEO4J_PASSWORD=${NEO4J_PASS}
RABBITMQ_USER=ulsa
RABBITMQ_PASSWORD=${RABBIT_PASS}
EOF

cat > "$P/gateway/.env" <<EOF
NODE_ENV=production
PORT_GATEWAY=4000
JWT_SECRET=${JWT_SECRET}
# Caddy va delante: la IP real del cliente sale de X-Forwarded-For.
TRUST_PROXY=true
SEGURIDAD_URL=http://localhost:4005/
ACADEMICO_URL=http://localhost:4004/
DEPORTES_URL=http://localhost:4001/
MAPA_URL=http://localhost:4002/
AUDITORIA_URL=http://localhost:4003/
REDIS_URL=${REDIS_URL}
NEO4J_URI=bolt://localhost:7688
NEO4J_USER=neo4j
NEO4J_PASSWORD=${NEO4J_PASS}
RABBITMQ_URL=${RABBIT_URL}
EOF

cat > "$P/services/seguridad-service/.env" <<EOF
NODE_ENV=production
INFRASTRUCTURE_MODE=local
PORT_SEGURIDAD=4005
JWT_SECRET=${JWT_SECRET}
MONGODB_URI=${MONGO_BASE}/seguridad?authSource=admin
REDIS_URL=${REDIS_URL}
NEO4J_URI=bolt://localhost:7688
NEO4J_USER=neo4j
NEO4J_PASSWORD=${NEO4J_PASS}
RABBITMQ_URL=${RABBIT_URL}
EOF

cat > "$P/services/academico-service/.env" <<EOF
NODE_ENV=production
INFRASTRUCTURE_MODE=local
PORT_ACADEMICO=4004
JWT_SECRET=${JWT_SECRET}
MONGODB_URI=${MONGO_BASE}/academico?authSource=admin
REDIS_URL=${REDIS_URL}
HORARIO_TTL_SECONDS=86400
RABBITMQ_URL=${RABBIT_URL}
EOF

cat > "$P/services/deportes-service/.env" <<EOF
NODE_ENV=production
INFRASTRUCTURE_MODE=local
PORT_DEPORTES=4001
JWT_SECRET=${JWT_SECRET}
MONGODB_URI=${MONGO_BASE}/deportes?authSource=admin
RABBITMQ_URL=${RABBIT_URL}
EOF

cat > "$P/services/mapa-service/.env" <<EOF
NODE_ENV=production
INFRASTRUCTURE_MODE=local
PORT_MAPA=4002
JWT_SECRET=${JWT_SECRET}
MONGODB_URI=${MONGO_BASE}/mapa?authSource=admin
REDIS_URL=${REDIS_URL}
REDIS_CACHE_TTL_SECONDS=60
RABBITMQ_URL=${RABBIT_URL}
EOF

cat > "$P/services/auditoria-service/.env" <<EOF
NODE_ENV=production
INFRASTRUCTURE_MODE=local
PORT_AUDITORIA=4003
JWT_SECRET=${JWT_SECRET}
SCYLLADB_CONTACT_POINTS=127.0.0.1
SCYLLADB_PORT=9043
RABBITMQ_URL=${RABBIT_URL}
EOF

echo "Listo: se crearon ${#ARCHIVOS[@]} archivos .env con contraseñas nuevas (no se muestran)."
echo "Las contraseñas viven en Docker/.env; no lo subas a git (ya está en .gitignore)."
echo "Siguiente: bash Despliegue/levantar.sh"
