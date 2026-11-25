#!/usr/bin/env bash
# Instala en la VM (Ubuntu 24.04) lo mismo que tengo en mi PC: Docker, Node 24,
# pm2 y Caddy (este último para el HTTPS). Se corre UNA vez.
#
# Uso (desde la carpeta del repo, en la VM):
#   bash Despliegue/instalar-vm.sh <IP_PUBLICA_DE_LA_VM>
#
# Nota para mí: lo hice para que se pueda volver a correr sin romper nada
# (si algo ya está instalado, lo salta).
set -euo pipefail

IP="${1:-}"
if [[ ! "$IP" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]]; then
  echo "Uso: bash Despliegue/instalar-vm.sh <IP_PUBLICA_DE_LA_VM>   (ej. 20.30.40.50)"
  exit 1
fi

RAIZ="$(cd "$(dirname "$0")/.." && pwd)"
# sslip.io convierte "20-30-40-50.sslip.io" en la IP 20.30.40.50 sin comprar
# dominio, y así Caddy puede sacar un certificado HTTPS gratis.
DOMINIO="${IP//./-}.sslip.io"

echo "==> Paquetes base"
sudo apt-get update -y
sudo apt-get install -y ca-certificates curl gnupg git ufw build-essential python3 \
  debian-keyring debian-archive-keyring apt-transport-https

echo "==> Docker"
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sudo sh
fi
# Para usar docker sin sudo. Ojo: aplica hasta que cierre y vuelva a abrir SSH.
sudo usermod -aG docker "$USER"

echo "==> Node 24 (la misma versión mayor que en mi PC)"
if ! command -v node >/dev/null 2>&1 || [[ "$(node -v)" != v24* ]]; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

echo "==> pm2 (mantiene vivos los 6 servicios y los reinicia si se caen)"
if ! command -v pm2 >/dev/null 2>&1; then
  sudo npm install -g pm2@6
fi

echo "==> Caddy (HTTPS automático)"
if ! command -v caddy >/dev/null 2>&1; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | sudo gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  sudo apt-get update -y
  sudo apt-get install -y caddy
fi

# Pongo mi dominio en el Caddyfile del repo y lo copio a donde lo lee Caddy.
sed "s/DOMINIO_AQUI/$DOMINIO/" "$RAIZ/Despliegue/Caddyfile" | sudo tee /etc/caddy/Caddyfile >/dev/null
sudo systemctl enable caddy
sudo systemctl restart caddy

echo "==> Firewall: solo SSH, HTTP y HTTPS"
# Los puertos 4000-4005 (Node) quedan cerrados hacia afuera: a la app solo
# le hablo por Caddy (443). Las BD ni siquiera escuchan afuera de la VM
# (en docker-compose.nube.yml están pegadas a 127.0.0.1).
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw --force enable

echo "==> Swap de 2 GB (colchón por si ScyllaDB o Neo4j se pasan de memoria)"
if ! sudo swapon --show | grep -q '/swapfile'; then
  sudo fallocate -l 2G /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile
  sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
fi

echo "==> Arranque automático si la VM se reinicia"
# Uso @reboot en vez de "pm2 startup" porque levantar.sh primero espera a que
# las BD estén listas (auditoría solo intenta conectarse a Scylla una vez).
LINEA="@reboot bash $RAIZ/Despliegue/levantar.sh >> $HOME/levantar.log 2>&1"
( crontab -l 2>/dev/null | grep -v 'Despliegue/levantar.sh' || true; echo "$LINEA" ) | crontab -

echo
echo "Listo. Tu dirección será: https://$DOMINIO/"
echo "IMPORTANTE: cierra la sesión SSH (exit) y vuelve a entrar para poder usar docker sin sudo."
echo "Después: bash Despliegue/generar-env.sh  y luego  bash Despliegue/levantar.sh"
