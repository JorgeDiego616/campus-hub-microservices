# Subir UlsaHub a una VM de Azure

La idea es hacer en una computadora de Azure lo mismo que hago en mi PC: las 5 BD en Docker y los 6 servicios de Node. La diferencia es que en la VM no se apaga, y la app Android le habla por HTTPS.

```
App Android ──HTTPS──► Caddy (443) ──► Gateway (4000) ──► 5 subgrafos (4001-4005)
                                                      └─► Mongo, Redis, Neo4j, Scylla, RabbitMQ (Docker, solo localhost)
```

Tiempo aproximado: de 1.5 a 3 horas. En mi PC no se instala nada nuevo.

## Archivos de esta carpeta

| Archivo | Dónde se corre | Para qué |
|---|---|---|
| `instalar-vm.sh` | VM, una vez | Instala Docker, Node 24, pm2 y Caddy; configura firewall, swap y el arranque automático |
| `generar-env.sh` | VM, una vez | Crea los 7 `.env` con contraseñas y `JWT_SECRET` nuevos |
| `levantar.sh` | VM, cuando haga falta | Prende las BD, espera a que respondan, instala dependencias y prende los 6 servicios |
| `docker-compose.nube.yml` | (lo usa `levantar.sh`) | BD solo en localhost, límites de memoria, reinicio automático |
| `ecosystem.config.cjs` | (lo usa `levantar.sh`) | Configuración de pm2 |
| `Caddyfile` | (lo usa `instalar-vm.sh`) | HTTPS automático |
| `respaldar-pc.sh` | Mi PC (Git Bash) | Respaldo de Mongo (opcional) |
| `restaurar-vm.sh` | VM | Carga ese respaldo (opcional) |

---

## Paso 0. Subir el código a GitHub (en mi PC)

La VM baja el código con `git clone`, así que tiene que estar en GitHub.

```bash
git add -A
git commit -m "Despliegue en Azure"
git push origin feature/correcciones-nube
```

## Paso 1. Crear la cuenta (navegador)

1. Ir a <https://azure.microsoft.com/free/students/> y darle **Start free**.
2. Entrar con el correo de la ULSA. No pide tarjeta.

## Paso 2. Crear la VM (portal.azure.com)

**Virtual machines → Create → Azure virtual machine**

| Campo | Valor |
|---|---|
| Resource group | Nuevo: `ulsahub` |
| Virtual machine name | `ulsahub-vm` |
| Region | La más cercana que deje la suscripción (ej. *Mexico Central* o *South Central US*) |
| Image | **Ubuntu Server 24.04 LTS - x64 Gen2** |
| Size | **Standard_B2ms (2 vCPU, 8 GB)**. Si no aparece: *Standard_B2s (4 GB)*, que funciona justo gracias al swap |
| Authentication type | **SSH public key** |
| Username | `azureuser` |
| SSH public key source | *Generate new key pair*, nombre `ulsahub-key` |
| Public inbound ports | **Allow selected ports**: marcar **SSH (22), HTTP (80), HTTPS (443)** |

En la pestaña **Disks**, poner *OS disk size* en **64 GiB** (las imágenes de Docker ocupan unos 6 GB).

**Review + create → Create → Download private key and create resource.**

Guardar el `ulsahub-key.pem` en `C:\Users\<yo>\.ssh\` y copiar la **Public IP address** que aparece al terminar (ej. `20.30.40.50`).

> Cuidado: no abras los puertos 4000-4005 ni los de las BD en Azure. Todo entra por el 443.

## Paso 3. Conectarme a la VM (Git Bash en mi PC)

```bash
chmod 600 ~/.ssh/ulsahub-key.pem
ssh -i ~/.ssh/ulsahub-key.pem azureuser@20.30.40.50
```

Todos los pasos que siguen son **dentro de la VM**.

## Paso 4. Bajar el código e instalar

```bash
git clone -b feature/correcciones-nube https://github.com/JorgeDiego616/campus-hub-microservices.git ulsahub
cd ulsahub
bash Despliegue/instalar-vm.sh 20.30.40.50      # mi IP pública
exit                                             # salir y volver a entrar (para usar docker sin sudo)
```

Si el repo es privado, `git clone` pide usuario y contraseña. La contraseña es un *Personal Access Token* de GitHub (Settings → Developer settings → Tokens), no la contraseña normal.

## Paso 5. Configurar y levantar

```bash
ssh -i ~/.ssh/ulsahub-key.pem azureuser@20.30.40.50
cd ulsahub
bash Despliegue/generar-env.sh
bash Despliegue/levantar.sh
```

La primera vez tarda entre 5 y 10 minutos, porque baja las imágenes de Docker y ScyllaDB es lento al arrancar. Al final muestra la tabla de pm2 con los 6 servicios **online** y la dirección `https://20-30-40-50.sslip.io/`.

Para probar desde mi PC, abro esa dirección en el navegador: debe salir la página de Apollo.

## Paso 6. Datos: elegir A o B

### A) Pasar mis datos de la PC (usuarios, materias, espacios...)

```bash
# En mi PC (Git Bash, en la raíz del repo, con Docker prendido):
bash Despliegue/respaldar-pc.sh
scp -i ~/.ssh/ulsahub-key.pem Despliegue/respaldo/mongo.gz azureuser@20.30.40.50:~/

# En la VM:
cd ~/ulsahub
bash Despliegue/restaurar-vm.sh ~/mongo.gz
```

Los usuarios entran con la misma contraseña que en mi PC.

### B) Empezar en blanco y crear el primer ADMIN

```bash
# En la VM
URL=http://localhost:4000/
curl -s $URL -H 'content-type: application/json' \
  -d '{"query":"mutation { registrarUsuario(matricula:\"20260001\", nombre:\"Admin\", email:\"admin@ulsa.mx\", password:\"CambiaEsto123\") { id rol } }"}'

source Docker/.env
docker exec ulsa-mongodb mongosh -u admin -p "$MONGO_ROOT_PASSWORD" --authenticationDatabase admin seguridad \
  --quiet --eval "db.usuarios.updateOne({email:'admin@ulsa.mx'},{\$set:{rol:'ADMIN'}})"

pm2 restart seguridad      # copia el rol nuevo a Neo4j
```

## Paso 7. App Android (en Android Studio)

1. En estos **3** archivos, cambiar `http://10.0.2.2:4000/` por `https://20-30-40-50.sslip.io/`:
   - `AuthService.kt`
   - `QrApi.kt`
   - `MenuRepository.kt`
2. En `QrDependencies.kt`, poner `USE_MOCK = false`.
3. Compilar y probar: login → menú → crear QR → registrar asistente.

Como la dirección es HTTPS, no hace falta tocar `network_security_config.xml`.

---

## Día a día

| Quiero... | Comando (en la VM, dentro de `~/ulsahub`) |
|---|---|
| Ver si todo está arriba | `pm2 status` y `docker ps` |
| Ver errores de un servicio | `pm2 logs gateway --lines 50` (o `seguridad`, `deportes`...) |
| Subir cambios de código | En mi PC: `git push`. En la VM: `git pull && bash Despliegue/levantar.sh` |
| Reiniciar todo | `bash Despliegue/levantar.sh` |
| Apagar para no gastar crédito | En el portal de Azure: VM → **Stop**. Si solo hago `sudo poweroff`, Azure sigue cobrando |

Si reinicio la VM desde Azure, todo vuelve a levantarse solo (por el `@reboot` que deja `instalar-vm.sh`). El log queda en `~/levantar.log`.

**Ojo con la IP:** si detengo la VM desde el portal (Stop), Azure puede darle **otra IP** al prenderla, y la dirección de la app cambiaría. Para evitarlo: VM → Networking → Public IP → Configuration → **Static**.

## Si algo falla

| Síntoma | Causa probable | Qué hacer |
|---|---|---|
| `permission denied ... docker.sock` | No volví a entrar después de `instalar-vm.sh` | `exit` y volver a conectar por SSH |
| `$'\r': command not found` | Los `.sh` bajaron con finales de línea de Windows | `sed -i 's/\r$//' Despliegue/*.sh` (el `.gitattributes` de esta carpeta lo evita) |
| La dirección https no abre | Faltan los puertos 80/443 en Azure | VM → Networking → Add inbound port rule (80 y 443) |
| Caddy no saca el certificado | Lo mismo, o la IP cambió | `sudo systemctl status caddy`; si cambió la IP, volver a correr `instalar-vm.sh <IP nueva>` |
| Un servicio en `errored` | Lo dice su log | `pm2 logs <servicio> --lines 80` |
| Mongo/Neo4j dicen *authentication failed* | Corrí `generar-env.sh` de nuevo con las BD ya creadas | Las BD guardan la primera contraseña. Si los datos no importan: `docker compose -f Docker/docker-compose.yml down -v` y luego `levantar.sh` |
| Todo se pone lento | Falta RAM (VM de 4 GB) | `free -h`; si es posible, cambiar la VM a B2ms (VM → Size) |
