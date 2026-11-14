# Migración a la nube: backend UlsaHub + app Android Deportes ULSA

> Documento de contexto para retomar el trabajo más adelante.
> Última actualización: 10/nov/2026.

---

## 1. Objetivo

Subir a la nube el backend **UlsaHub** (hoy corriendo en Docker local) para que la app Android **Deportes ULSA** funcione desde cualquier lugar, no solo desde el emulador o la red local.

Requisitos clave:

- Conservar los datos existentes (MongoDB, Neo4j, ScyllaDB, RabbitMQ; Redis es solo sesiones/caché).
- Que la app Android siga autenticando y, a futuro, usando el módulo QR.
- Poder aceptar una ventana de mantenimiento de unas horas durante la migración.

---

## 2. Los dos repositorios

| Parte | Ruta | Tecnología |
|---|---|---|
| Backend | `C:\Users\jorge\Documents\ULSA\7mo\Base de datos avanzada\1er parcial\UlsaHub` | Node.js, Apollo Federation, Docker |
| App Android | `C:\Users\jorge\Documents\ULSAapp\Deportes_ULSA` | Kotlin, Jetpack Compose, MVVM, Retrofit |

Son repos separados. **No comparten código ni módulos Gradle**; se comunican únicamente por HTTP/GraphQL.

Documento puente ya existente en la app: `Deportes_ULSA/QR-CONTEXTO.md`.

---

## 3. Arquitectura actual del backend

### 3.1 Servicios (Node)

| Servicio | Puerto | Responsabilidad | DB |
|---|---:|---|---|
| `gateway` | 4000 | Apollo Federation, valida JWT + sesión Redis, enruta a subgraphs | Redis |
| `seguridad-service` | 4005 | Login, registro, usuarios, roles, sesiones | MongoDB `seguridad`, Redis, Neo4j |
| `academico-service` | 4004 | Carreras, materias, inscripciones, calificaciones, horarios | MongoDB `academico`, Redis |
| `deportes-service` | 4001 | Equipos, prácticas (sin eventos/QR todavía) | MongoDB `deportes` |
| `mapa-service` | 4002 | Espacios físicos | MongoDB `mapa`, Redis |
| `auditoria-service` | 4003 | Logs inmutables (event sourcing) | ScyllaDB |

Broker: RabbitMQ (eventos de dominio asíncronos).

> El gateway **sí registra** `auditoria` (`Proyecto/gateway/src/index.js:48-51`), aunque `QR-CONTEXTO.md` diga lo contrario (documento desactualizado).

### 3.2 Infraestructura Docker actual

Archivo: `Docker/docker-compose.yml`.

| Servicio | Imagen | Puerto host | Credenciales actuales |
|---|---|---:|---|
| MongoDB | `mongo:8.0` | 27018 → 27017 | `admin/password123` |
| Redis Stack | `redis/redis-stack:latest` | 6380 → 6379, 8002 → 8001 | `password123` |
| Neo4j | `neo4j:5.26` | 7475 → 7474, 7688 → 7687 | `neo4j/password123` |
| ScyllaDB | `scylladb/scylla:5.4` | 9043 → 9042 | sin auth |
| RabbitMQ | `rabbitmq:3.13-management` | 5673 → 5672, 15673 → 15672 | `guest/guest` |

**Importante:** el compose **solo contiene las bases de datos y RabbitMQ**. Los 6 microservicios **no están dockerizados** (no existen Dockerfiles propios) y se ejecutan en la máquina host con `node src/index.js`.

### 3.3 Perfiles de infraestructura ya previstos

Los `runtime-config.js` de los servicios ya tienen perfiles `local` y `docker`:

- `academico-service`: `mongodb:27017`, `redis-stack:6379`, `rabbitmq:5672`.
- `seguridad-service`: `mongodb:27017`, `rabbitmq:5672` (Redis se lee de `REDIS_URL`).
- `deportes-service`, `mapa-service`, `auditoria-service`: equivalentes.

Para la nube basta con `INFRASTRUCTURE_MODE=docker` y las variables correctas.

---

## 4. Relación entre backend y app Android

```
App Android (Kotlin + Compose, MVVM)
  │
  ├─ POST http://10.0.2.2:4000/  (GraphQL) ──► Gateway Apollo (UlsaHub :4000)
  │     login / registrarUsuario                  │
  │                                               ├─► seguridad-service :4005 ─► MongoDB "seguridad"
  │                                               │                              + Redis (sesiones)
  │                                               │                              + Neo4j (roles)
  │                                               └─► deportes-service :4001 (QR futuro)
  │
  ├─ GET https://androidbasics-auth-api.onrender.com/ (REST Django) ─► Home/Partidos/Noticias
  └─ GET gist.githubusercontent.com (REST) ─► Equipos
```

### 4.1 Qué usa la app de UlsaHub

| Función | Archivo Android | Backend |
|---|---|---|
| Login | `ui/auth/domain/AuthRepositoryImpl.kt:24` | mutation `login` → seguridad |
| Registro | `ui/auth/domain/AuthRepositoryImpl.kt:38` | mutation `registrarUsuario` → seguridad |
| QR | `ui/qrSection/qrHome/network/QrApi.kt:22` | **mock** (`QrDependencies.USE_MOCK = true`) |

### 4.2 Qué NO usa UlsaHub

- Home, partidos y noticias: `HomeService.kt:16` → `https://androidbasics-auth-api.onrender.com/` (Django REST).
- Equipos: `GistService.kt:71` → GitHub Gist.

Por eso, si UlsaHub se cae, esas secciones siguen funcionando; lo que falla es login/registro (y el QR cuando deje de ser mock).

### 4.3 Flujo de sesión

1. Login exitoso → `SessionPreferences.saveSession(...)` guarda el JWT en `SharedPreferences` (`ui/auth/data/SessionPreferences.kt:25`).
2. Se guarda el mismo token como access y refresh (no hay refresh real).
3. La app valida localmente el `exp` del JWT (`SessionPreferences.kt:43`).
4. El gateway valida firma JWT **y** que exista `session:<jti>` en Redis (`gateway/src/authentication.js:57-75`).
5. Logout en la app solo borra local (`ui/auth/viewmodel/LogoutViewModel.kt:28`); no llama al backend.

### 4.4 URLs y red en Android

- `AuthService.kt:53` → `BASE_URL = "http://10.0.2.2:4000/"`.
- `QrApi.kt:36` → `BASE_URL = "http://10.0.2.2:4000/"`.
- `res/xml/network_security_config.xml:3-5` → permite cleartext **solo** a `10.0.2.2`.
- `10.0.2.2` es el localhost del PC visto desde el emulador; en un dispositivo físico o en la nube no sirve.

---

## 5. Inventario de datos actual

Según `docker system df -v` (volúmenes con prefijo `docker_ulsa_*`):

| Volumen | Tamaño |
|---|---:|
| `docker_ulsa_mongodb_data` | 223.2 MB |
| `docker_ulsa_neo4j_data` | 541.2 MB |
| `docker_ulsa_neo4j_plugins` | 3.08 MB |
| `docker_ulsa_scylla_data` | 883 kB |
| `docker_ulsa_rabbitmq_data` | 773 kB |
| `docker_ulsa_redis_data` | 243 B |
| **Total** | **~769 MB (< 1 GB)** |

Notas:

- Redis está prácticamente vacío: sesiones/caché, **no vale la pena migrarlo**.
- Los contenedores estaban detenidos; los datos persisten en disco.
- Migrar con **dumps lógicos**, no copiando carpetas de volúmenes:
  - MongoDB: `mongodump` / `mongorestore`.
  - Neo4j: `neo4j-admin database dump` / `load`.
  - ScyllaDB: snapshot con `nodetool` o `cqlsh COPY`.
  - RabbitMQ: `rabbitmqctl export_definitions` / `import_definitions`.

---

## 6. Brechas e inconsistencias detectadas

1. **El registro está roto contra el backend actual.**
   - El schema exige `rol: String!` y devuelve `Usuario!` (`seguridad-service/src/schema.graphql:13-19`).
   - La app no envía `rol` y espera `{ token, usuario }` (`AuthRepositoryImpl.kt:38-50`, `AuthModel.kt:84-92`).
   - Resultado: `registrarUsuario` fallaría por validación GraphQL.

2. **QR es REST contra un gateway GraphQL.**
   - `QrApi` define `POST /qr` y `GET /events/{id}/capacity`.
   - UlsaHub no tiene eventos/tickets/QR en `deportes-service` (`schema.graphql:1-48`).
   - Hoy está en mock. El contrato futuro está en `QR-CONTEXTO.md` sección 12.

3. **Logout no revoca sesión.**
   - El backend tiene mutation `logout` (`schema.graphql:23`) que borra `session:<jti>`.
   - La app no la llama; la sesión dura hasta 1 h.

4. **TTL real = 1 hora, no 8.**
   - `SESSION_TTL_SECONDS = 3600` (`seguridad-service/src/index.js:50`).
   - Los comentarios de la app dicen 8 h.

5. **`.env` mal formado en académico.**
   - `academico-service/.env` tiene `HORARIO_TTL_SECONDS=86400JWT_SECRET=...` (líneas concatenadas). Corregir antes de desplegar.

6. **Contraseñas débiles y puertos de BD publicados.**
   - `password123`, `guest/guest`.
   - En el compose los puertos de BD se publican al host; en la nube deben quedar privados.

7. **Scylla en modo desarrollador.**
   - `--developer-mode=1` no debe usarse en producción.

---

## 7. Decisiones pendientes (responder antes de migrar)

1. **¿Suben también los microservicios o solo las BD?**
   - Recomendación: **todo**. Si solo suben las BD y el gateway queda local, la app solo funciona en la red del PC.
   - Implica crear Dockerfiles para gateway y los 5 servicios.

2. **¿Qué proveedor?**
   - **Azure for Students**: requiere correo institucional ULSA activo; ~$100 USD de crédito; normalmente sin tarjeta.
   - **Oracle Cloud Always Free**: 4 OCPU ARM + 24 GB RAM + 200 GB; requiere tarjeta para verificación; a veces no hay capacidad ARM.
   - Las 5 imágenes (`mongo`, `redis-stack`, `neo4j`, `scylla`, `rabbitmq`) tienen build `arm64`, así que Oracle ARM es viable.
   - **VPS barato** (Hetzner/Contabo/DigitalOcean): ~$12-25 USD/mes por 8-16 GB, sin trámites de estudiante.

3. **¿Dominio estable o IP?**
   - Muy recomendable usar un dominio (aunque sea gratuito) desde el inicio, para no recompilar la app si cambia la IP.

4. **¿Ventana de mantenimiento?**
   - Aceptable de unas horas. Avisar a usuarios y hacerla en horario de baja uso.

---

## 8. Tamaño de VM recomendado

Con 5 motores + RabbitMQ + 6 servicios Node en una sola máquina:

| Recurso | Mínimo | Recomendado |
|---|---|---|
| RAM | 8 GB | 16 GB |
| vCPU | 2 | 4 |
| Disco | 30 GB | 50 GB |

Los consumos más altos son ScyllaDB y Neo4j. Ajustar límites de memoria y heap de Neo4j si se usa una VM de 8 GB.

Alternativa: separar BD y aplicación en dos VMs, o usar servicios gestionados (Mongo Atlas, Neo4j Aura, Redis Cloud, CloudAMQP). ScyllaDB no tiene un tier gratuito equivalente cómodo.

---

## 9. Plan de migración paso a paso

### Fase 0 — Preparación local

- [ ] Verificar que los datos están completos levantando el compose y revisando cada BD.
- [ ] Corregir `academico-service/.env`.
- [ ] Decidir proveedor y crear la VM/instancia.
- [ ] Definir dominio (o IP fija) y DNS.
- [ ] Cambiar contraseñas débiles por variables de entorno seguras.

### Fase 1 — Dockerizar los servicios

- [ ] Crear Dockerfile para `gateway` y para cada servicio de `node_modules-v2/services`.
- [ ] Añadir los 6 servicios al compose (o a un compose de aplicación).
- [ ] Usar red interna; exponer solo el puerto 4000 del gateway.
- [ ] Quitar la publicación de puertos de BD al host (o bind a `127.0.0.1`).
- [ ] Configurar `INFRASTRUCTURE_MODE=docker`.
- [ ] Variables clave:
  - `MONGODB_URI=mongodb://<user>:<pass>@mongodb:27017/<db>?authSource=admin`
  - `REDIS_URL=redis://:<pass>@redis-stack:6379`
  - `NEO4J_URI=bolt://neo4j:7687`
  - `SCYLLADB_CONTACT_POINTS=scylladb`, `SCYLLADB_PORT=9042`
  - `RABBITMQ_URL=amqp://<user>:<pass>@rabbitmq:5672`
  - `JWT_SECRET=<el mismo en gateway y seguridad>`
  - `SEGURIDAD_URL=http://seguridad-service:4005/`, etc.

### Fase 2 — Migrar datos

- [ ] Detener servicios para congelar escrituras.
- [ ] Dump de MongoDB, Neo4j, Scylla y definiciones de RabbitMQ.
- [ ] Transferir dumps a la VM (scp/rsync).
- [ ] Restaurar en el orden: Mongo, Neo4j, Scylla, RabbitMQ.
- [ ] Redis: **no migrar**; aceptar re-login.
- [ ] Validar conteos y datos de prueba.

### Fase 3 — Desplegar backend

- [ ] `docker compose up -d` en la VM.
- [ ] Verificar logs de gateway y subgraphs.
- [ ] Probar `login` con un usuario existente.
- [ ] Probar una query GraphQL autenticada.
- [ ] Configurar HTTPS (Caddy/Nginx/Traefik + Let's Encrypt) o Cloudflare Tunnel.

### Fase 4 — Adaptar la app Android

- [ ] Cambiar `BASE_URL` en `AuthService.kt:53` y `QrApi.kt:36` a la URL pública HTTPS.
- [ ] Ajustar `network_security_config.xml` (preferible HTTPS; si hay cleartext temporal, agregar el dominio/IP).
- [ ] Recompilar y distribuir el APK **antes** del corte, si el dominio ya resuelve.
- [ ] Probar login, registro (corregir contrato), logout y QR.
- [ ] Para dispositivo físico, usar la URL pública (no `10.0.2.2`).

### Fase 5 — Validación y cierre

- [ ] Smoke test de login, registro, consultas y QR.
- [ ] Revisar logs y métricas.
- [ ] Respaldos automáticos de BD.
- [ ] Documentar credenciales en un gestor de secretos (no en el repo).
- [ ] Apagar el stack local y conservar los volúmenes como respaldo temporal.

---

## 10. ¿Se puede aguantar unas horas de caída?

Sí, para este proyecto es aceptable. Consideraciones:

- **Datos pequeños (~769 MB):** dump/restore toma minutos; la ventana de horas es holgada.
- **Impacto real:**
  - Login/registro: no funcionan durante la ventana.
  - Home/partidos/noticias/equipos: siguen funcionando (APIs externas).
  - QR: hoy es mock; no depende del backend.
- **Sesiones:** el gateway exige `session:<jti>` en Redis. Si no migras Redis, **todas las sesiones se invalidan** y los usuarios deben volver a iniciar sesión. Redis pesa 243 B, así que es asumible.
- **El mayor riesgo es el cambio de URL:** si la app apunta a `10.0.2.2`, las versiones instaladas dejarán de funcionar. Solución: usar un dominio estable desde el inicio o recompilar/redistribuir el APK.
- **Recomendación:** ventana de 2-4 h en horario de baja uso, con respaldo previo y validación posterior.

---

## 11. Variables de entorno de referencia (sin secretos reales)

Gateway:

```env
PORT_GATEWAY=4000
JWT_SECRET=<compartido con seguridad>
REDIS_URL=redis://:<pass>@redis-stack:6379
SEGURIDAD_URL=http://seguridad-service:4005/
ACADEMICO_URL=http://academico-service:4004/
DEPORTES_URL=http://deportes-service:4001/
MAPA_URL=http://mapa-service:4002/
AUDITORIA_URL=http://auditoria-service:4003/
```

Seguridad:

```env
INFRASTRUCTURE_MODE=docker
PORT_SEGURIDAD=4005
JWT_SECRET=<compartido con gateway>
MONGODB_URI=mongodb://<user>:<pass>@mongodb:27017/seguridad?authSource=admin
REDIS_URL=redis://:<pass>@redis-stack:6379
NEO4J_URI=bolt://neo4j:7687
NEO4J_USER=neo4j
NEO4J_PASSWORD=<pass>
SCYLLADB_CONTACT_POINTS=scylladb
SCYLLADB_PORT=9042
RABBITMQ_URL=amqp://<user>:<pass>@rabbitmq:5672
```

Académico:

```env
INFRASTRUCTURE_MODE=docker
PORT_ACADEMICO=4004
JWT_SECRET=<compartido>
MONGODB_URI=mongodb://<user>:<pass>@mongodb:27017/academico?authSource=admin
REDIS_URL=redis://:<pass>@redis-stack:6379
HORARIO_TTL_SECONDS=86400
RABBITMQ_URL=amqp://<user>:<pass>@rabbitmq:5672
```

> No commitear `.env` reales. Usar `.env.example` y un gestor de secretos.

---

## 12. Comandos útiles

```bash
# Tamaño de volúmenes
docker system df -v

# Levantar infraestructura local
cd Docker
docker compose up -d

# Dump/restore MongoDB
mongodump --uri="mongodb://admin:<pass>@localhost:27018/?authSource=admin" --out=./dump
mongorestore --uri="mongodb://admin:<pass>@<host>:27017/?authSource=admin" ./dump

# Neo4j dump/load
neo4j-admin database dump neo4j --to-path=/backups
neo4j-admin database load neo4j --from-path=/backups

# RabbitMQ definiciones
rabbitmqctl export_definitions /backups/definitions.json
rabbitmqctl import_definitions /backups/definitions.json

# Prueba de login (GraphQL)
curl -X POST http://<host>:4000/ \
  -H "Content-Type: application/json" \
  -d '{"query":"mutation($e:String!,$p:String!){login(email:$e,password:$p){token usuario{id email rol}}}","variables":{"e":"correo@ulsa.edu.mx","p":"<pass>"}}'
```

---

## 13. Próximos pasos sugeridos

1. Responder las decisiones pendientes de la sección 7.
2. Corregir el contrato de registro (backend y app) antes de migrar.
3. Decidir si el QR será REST o GraphQL y planear su implementación en `deportes-service`.
4. Dockerizar los servicios.
5. Elegir proveedor y crear la VM.
6. Ejecutar el plan de la sección 9.

---

## 14. Referencias de archivos

Backend:

- `Docker/docker-compose.yml`
- `CONTEXTO_PROYECTO.md`
- `Proyecto/gateway/src/index.js`
- `Proyecto/gateway/src/authentication.js`
- `Proyecto/node_modules-v2/services/*/src/schema.graphql`
- `Proyecto/node_modules-v2/services/*/src/infrastructure/runtime-config.js`

Android:

- `Deportes_ULSA/QR-CONTEXTO.md`
- `Deportes_ULSA/CHANGELOG-F01-v2.md`
- `Deportes_ULSA/app/src/main/java/com/ulsa/deportes/ui/auth/network/AuthService.kt`
- `Deportes_ULSA/app/src/main/java/com/ulsa/deportes/ui/auth/domain/AuthRepositoryImpl.kt`
- `Deportes_ULSA/app/src/main/java/com/ulsa/deportes/ui/auth/data/SessionPreferences.kt`
- `Deportes_ULSA/app/src/main/java/com/ulsa/deportes/ui/qrSection/qrHome/network/QrApi.kt`
- `Deportes_ULSA/app/src/main/java/com/ulsa/deportes/ui/homeSection/homeHome/network/HomeService.kt`
- `Deportes_ULSA/app/src/main/res/xml/network_security_config.xml`
