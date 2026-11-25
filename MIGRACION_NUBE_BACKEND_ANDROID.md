# Migración a la nube: backend UlsaHub + app Android Deportes ULSA

> Documento de contexto para retomar el trabajo más adelante.
> Última actualización: 24/nov/2026 (correcciones 8–14: registro, consultas, IP de auditoría y errores; detalle en la sección 15).

---

## 0. Estado actual — empezar aquí al retomar

**La migración está en pausa a propósito.** Antes de subir a la nube se van a terminar algunas implementaciones en local (ver 0.3). Lo que ya se hizo para preparar la nube está en la rama **`feature/correcciones-nube`** (sin commits todavía).

**Orden de lectura al retomar:** 0.1 (qué se corrigió) → 0.3 (qué falta) → sección 15 (detalle de las correcciones 8–14: cambios en la API, convenciones del código y cómo verificar).

### 0.1 Ya corregido en `feature/correcciones-nube`

| # | Problema | Qué se hizo | Archivos |
|---|---|---|---|
| 1 | RabbitMQ perdía sus datos al recrear el contenedor: guarda todo en `rabbit@<hostname>` y el hostname era el ID aleatorio del contenedor (ya había 3 carpetas de nodo distintas). | `hostname: rabbitmq` fijo. Contenedor recreado, colas restauradas desde definiciones y carpetas viejas borradas. Probado: las colas sobreviven a `--force-recreate`. | `Docker/docker-compose.yml` |
| 2 | Los equipos de deportes estaban en la BD `resistencia` (override en el `.env`, plantilla de otro proyecto); el perfil `docker` usa `deportes`, así que en la nube "desaparecían". | Equipos copiados a `deportes` (5 docs, mismos `_id`), BD `resistencia` borrada, override comentado en el `.env`. | `services/deportes-service/.env` (no está en git), `CONTEXTO_PROYECTO.md` |
| 3 | `seguridad-service` ignoraba el perfil `docker` para Redis y Neo4j (defaults `localhost:6379` y `neo4j://localhost:7687` con `password`). | `redisUrl` y `neo4jUri/User/Password` ahora salen del perfil en `runtime-config.js` (mismo patrón que académico); las variables de entorno siguen ganando. | `services/seguridad-service/src/infrastructure/runtime-config.js`, `database.js`, `src/index.js` |
| 4 | Nodos `User` en Neo4j sin usuario en Mongo. | Borrados los 3 placeholders `ID_MONGO_*`. Los 6 `demo-*` se quedan (los crea `init-rbac.cql` para pruebas). Neo4j: 18 reales = 18 en Mongo. | Solo datos |
| 5 | El gateway truena a los ~9 s si un subgrafo no está prendido al arrancar (`IntrospectAndCompose`). | Nuevo módulo que espera a los subgrafos (30 intentos × 2 s) y dice cuál falta. 4 pruebas nuevas; gateway 15/15. | `gateway/src/esperar-subgrafos.js` (nuevo), `gateway/src/index.js`, `gateway/test/esperar-subgrafos.test.js` (nuevo), `gateway/package.json` |
| 6 | Errores menores. | `.env` de académico separado (`HORARIO_TTL_SECONDS=86400JWT_SECRET=...` estaba pegado). `redis-stack:latest` → `7.4.0-v8` (mismo digest que ya se usaba). Quitado `version: '3.8'`. Contraseñas del compose como `${VAR:-default}` + `Docker/.env.example` (en local nada cambia). | `services/academico-service/.env` (no está en git), `Docker/docker-compose.yml`, `Docker/.env.example` (nuevo) |
| 7 | El código vivía en `Proyecto/node_modules-v2/services` (muchas herramientas ignoran `node_modules*`). | Movido a `Proyecto/services` con `git mv`. Borrados el `package.json` viejo (apollo-server v3), su `node_modules` y la carpeta `gateway` vacía. Rutas actualizadas en todos los `.md`. Probado: todo arranca desde la ruta nueva. | Estructura + docs |
| 8 | **Cualquiera podía registrarse como ADMIN**: `registrarUsuario` es pública y tomaba el `rol` del cliente. | `rol` ahora es opcional: sin rol = `ESTUDIANTE`; otro rol solo si lo pide un ADMIN con sesión (si no, `FORBIDDEN` + evento `ASIGNACION_ROL_PERMISO` denegado). La app sigue igual (manda `rol:"ESTUDIANTE"`). Además: email en minúsculas (los 7 usuarios viejos con mayúsculas se normalizan al arrancar), validación de email/nombre y contraseña ≥ 6 (igual que la app). | `seguridad-service/src/domain/authorization.js` (nuevo), `domain/entities.js`, `schema.graphql`, `src/index.js`, `infrastructure/mongoose-models.js` |
| 9 | **Datos personales sin login**: `allUsuarios` y `verUsuario` devolvían email/matrícula/rol de los 18 usuarios sin token; `roles` también era abierta. | `allUsuarios` solo ADMIN; `verUsuario` el propio usuario o ADMIN (id mal formado → `null`); `roles` cualquier sesión. El RBAC del Gateway solo cubre mutaciones, así que las queries se protegen en el subgrafo. | `seguridad-service/src/index.js`, `domain/authorization.js` |
| 10 | **La IP de auditoría se perdía**: los 30 eventos tenían `ip_origen = ::1` (seguridad veía la IP del Gateway) y `user_agent` siempre `NO_DISPONIBLE`. Con Caddy delante iba a ser la IP del contenedor. | El Gateway calcula la IP del cliente (socket, o el **último** valor de `X-Forwarded-For` solo si `TRUST_PROXY=true`) y la reenvía en `x-forwarded-for` + `x-client-user-agent`, borrando lo que mande el cliente. Seguridad y académico la usan. | `gateway/src/client-info.js` (nuevo), `gateway/src/index.js`, `gateway/.env.example`, `seguridad-service/src/index.js` |
| 11 | **Errores de validación salían como `INTERNAL_SERVER_ERROR`** (el dominio lanzaba `new Error`) en seguridad, académico, deportes y mapa; los "no existe" de los repositorios igual. | `ErrorDeDominio` (`BAD_USER_INPUT`) y `RecursoNoEncontrado` (`NOT_FOUND`) en `domain/errors.js` de cada servicio. Sin `http.status` a propósito, para que el Gateway no los envuelva. Los 2 errores de permiso de académico pasan a `FORBIDDEN`. Ids mal formados (`"xx"`) ya no truenan con `Cast to ObjectId`. | `*/src/domain/errors.js` (nuevos), `domain/entities.js`, `academico/domain/horario.js`, `academico/application/academic-use-cases.js`, `*/infrastructure/mongoose-repositories.js` |
| 12 | **El Gateway filtraba URLs internas** (`"url":"http://localhost:4001/"`) y envolvía los 401/403 como `"401: Unauthorized"`; en producción iban a salir mensajes internos (`Cast to ObjectId ... model "Usuario"`). | `formatError` en el Gateway: desenvuelve el error real del subgrafo (mensaje + código) y quita `response`. Con `NODE_ENV=production` cambia los `INTERNAL_SERVER_ERROR` por "Error interno del servidor." y deja el original en el log. En local se ve todo para depurar. | `gateway/src/format-error.js` (nuevo), `gateway/src/index.js` |
| 13 | Menores: 2 pruebas de académico fallando desde `f46bd09`; seguridad, deportes y auditoría sin pruebas (`"test": "echo Error..."`); `.env` con variables de otra plantilla. | Pruebas de académico actualizadas (+1 de `x-forwarded-for`). Pruebas nuevas en seguridad, deportes y auditoría. En los `.env` de seguridad/deportes/auditoría las variables que el servicio no lee quedaron comentadas con `# [sin uso]` (no se borró nada). | `*/test/*.test.js`, `*/package.json`, `.env` (no están en git) |
| 14 | **Eventos de deportes sin autor ni IP**: `EQUIPO_REGISTRADO` y `PRACTICA_REGISTRADA` llegaban a ScyllaDB con `usuario_id` e `ip_origen` en `null`. Además, una `categoria` fuera del catálogo o un `ubicacionId` que no es ObjectId tronaban en Mongoose y salían como error interno. | El actor de deportes trae `ip_origen` y `jti` (igual que académico); los casos de uso reciben `actor` primero y los eventos llevan `usuario_id`, `ip_origen`, `jti`, `severidad`, `operacion` y `metadata.rol`. Nuevo catálogo `CATEGORIAS_EQUIPO` + `Equipo.validarDatos()` (la categoría se normaliza a mayúsculas) y validación de `ubicacionId` en el repositorio. | `deportes-service/src/infrastructure/gateway-identity.js`, `application/sports-use-cases.js`, `domain/entities.js`, `infrastructure/mongoose-repositories.js`, `src/index.js`, `test/eventos-auditoria.test.js` (nuevo) |

Pruebas después de 8–14: gateway 27/27, seguridad 9/9, académico 6/6, deportes 10/10, mapa 3/3, auditoría 4/4 (59 en total), más 68 verificaciones de integración contra el Gateway (local y modo nube con `NODE_ENV=production` + `TRUST_PROXY=true`). Los datos quedaron igual que en la sección 5 (los usuarios y el equipo de prueba se borraron).

> **El detalle completo de 8–14 (qué cambió en la API, convenciones nuevas, cómo verificarlo a mano y qué datos se tocaron) está en la sección 15.**

Nota: `git mv`/`git rm` dejaron cambios **preparados (staged)**. No es un commit; si se quiere quitar del área de preparación: `git restore --staged .`.

### 0.2 Decidido pero NO aplicado todavía (a propósito)

- **Contraseñas por defecto en `runtime-config.js`**: se quedan para desarrollo local. En la nube se sobreescriben con variables (`MONGODB_URI`, `REDIS_URL`, `NEO4J_PASSWORD`, `RABBITMQ_URL`) en el `.env` de producción.
- **`NODE_ENV=production`**: hoy los errores GraphQL devuelven el `stacktrace` con rutas del disco. Se pone en el compose de producción (no requiere código).
- **APOC**: configurado en el compose pero no se carga y nada lo usa. Se dejó igual; quitarlo son 2 líneas si se quiere ahorrar RAM.
- **Healthchecks / `depends_on: service_healthy` / `restart: unless-stopped`**: van en el `docker-compose.prod.yml` del Paso A.

### 0.3 Pendiente

**En local, antes de migrar:**

- [ ] Implementaciones que faltan del proyecto *(agregar aquí las que se tengan en mente)*.
- [x] 2 pruebas de `academico-service/test/authentication.test.js` fallaban desde `f46bd09` → actualizadas (ver 0.1 #13).
- [x] Contrato de `registrarUsuario` entre app y backend: la app ya manda `rol:"ESTUDIANTE"` y espera `Usuario` (sin token); el backend lo acepta con `rol` opcional (ver 0.1 #8 y sección 6, punto 1).
- [ ] Decidir QR REST vs GraphQL (sección 6, punto 2).
- [x] Los eventos de deportes (`EQUIPO_REGISTRADO`, `PRACTICA_REGISTRADA`) llegaban a auditoría con `ip_origen = null` → corregido (ver 0.1 #14).
- [ ] (Menor) La app Android hace logout solo local (sección 6, punto 3); conviene que llame a la mutation `logout` para revocar la sesión en Redis.
- [ ] Hacer commit de `feature/correcciones-nube` y abrir PR a `main`.

**Para la nube (Paso A en adelante, sección 9):**

- [ ] `Dockerfile` + `.dockerignore` para el gateway y los 5 servicios (`node:24-slim`, `npm ci --omit=dev`; seguridad usa `bcrypt`, que es nativo).
- [ ] `docker-compose.prod.yml`: los 11 contenedores en red interna, solo Caddy (80/443) expuesto, BD sin puertos publicados, `INFRASTRUCTURE_MODE=docker`, `NODE_ENV=production`, healthchecks, `restart`, límites de memoria (Scylla `--smp 1 --memory 750M`, heap de Neo4j 512 MB).
- [ ] Caddy con HTTPS y un dominio gratuito (DuckDNS o sslip.io).
- [ ] Elegir proveedor (sección 7) y crear la VM.
- [ ] Respaldar, transferir y restaurar (sección 12).
- [ ] Cambiar `BASE_URL` en la app Android.

---

## 1. Objetivo

Subir a la nube el backend **UlsaHub** (hoy corriendo en Docker local) para que la app Android **Deportes ULSA** funcione desde cualquier lugar, no solo desde el emulador o la red local.

Requisitos clave:

- Conservar los datos existentes de **MongoDB, Neo4j, Redis, RabbitMQ y ScyllaDB** (auditoría). Los usuarios de Mongo pueden perderse/recrearse si hace falta; el resto no.
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

| Servicio | Imagen | Puerto host | Credenciales por defecto |
|---|---|---:|---|
| MongoDB | `mongo:8.0` | 27018 → 27017 | `admin/password123` |
| Redis Stack | `redis/redis-stack:7.4.0-v8` | 6380 → 6379, 8002 → 8001 | `password123` |
| Neo4j | `neo4j:5.26` | 7475 → 7474, 7688 → 7687 | `neo4j/password123` |
| ScyllaDB | `scylladb/scylla:5.4` | 9043 → 9042 | sin auth |
| RabbitMQ | `rabbitmq:3.13-management` (`hostname: rabbitmq`) | 5673 → 5672, 15673 → 15672 | `guest/guest` |

- Las credenciales salen de `${VAR:-default}`. Sin `Docker/.env` se usan las de la tabla; para la nube se copia `Docker/.env.example` a `Docker/.env`.
- Mongo, Neo4j y RabbitMQ **solo leen esas contraseñas la primera vez que se crea su volumen**.
- Todas las imágenes tienen build `arm64` (sirve para Oracle ARM).

**Importante:** el compose **solo contiene las bases de datos y RabbitMQ**. Los 6 microservicios **no están dockerizados** (no existen Dockerfiles propios) y se ejecutan en la máquina host con `node src/index.js`.

### 3.3 Perfiles de infraestructura ya previstos

Los `runtime-config.js` de los servicios ya tienen perfiles `local` y `docker`:

- `academico-service`: `mongodb:27017`, `redis-stack:6379`, `rabbitmq:5672`.
- `seguridad-service`: `mongodb:27017`, `redis-stack:6379`, `neo4j:7687`, `rabbitmq:5672`. Antes Redis y Neo4j no estaban en el perfil; corregido.
- `deportes-service` (BD `deportes`), `mapa-service`, `auditoria-service`: equivalentes.

Para la nube basta con `INFRASTRUCTURE_MODE=docker` y las variables correctas. Las variables de entorno siempre le ganan al perfil.

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

Contenido revisado el 22–24/nov/2026 (volúmenes `docker_ulsa_*`):

| Componente | Contenido | Volumen |
|---|---|---:|
| MongoDB | `academico` (2 periodos, 4 materias, 4 carreras, 4 asignaciones, 2 horarios, 1 inscripción), `deportes` (5 equipos), `mapa` (1 espacio), `seguridad` (18 usuarios, 6 roles) | ~230 MB |
| Neo4j | 40 `Route`, 24 `User` (18 reales + 6 `demo-*`), 7 `MenuNode`, 6 `Role` | ~541 MB (casi todo logs de transacciones; el dump pesa KB) |
| Redis | Vacío al revisarlo (`DBSIZE 0`): sesiones con TTL 1 h y caché. Persistencia RDB, sin AOF. | < 1 KB |
| RabbitMQ | Colas durables `transmisiones-auditoria` y `.dlq` (0 mensajes), usuario `guest`, nodo `rabbit@rabbitmq` | ~1 MB |
| ScyllaDB | Keyspace `auditoria`: 30 eventos (`logs_eventos`, `tipos_evento_por_dia`). El esquema lo crea `auditoria-service` al arrancar. | ~1 GB (preasignado) |

Notas:

- **Se conserva todo**, Redis incluido (requisito). Los usuarios de Mongo son prescindibles.
- Migrar con **dumps lógicos**, no copiando carpetas de volúmenes (más seguro si la VM es ARM). Comandos exactos en la sección 12.

---

## 6. Brechas e inconsistencias detectadas

1. ~~**El registro está roto contra el backend actual.**~~ ✅ Resuelto.
   - La app ya cambió: manda `rol: "ESTUDIANTE"` (variable `String!`) y espera el `Usuario` sin token (`AuthRepositoryImpl.kt:37-48`, `AuthModel.kt:83-85`).
   - El backend ahora tiene `rol: String` opcional (sin rol = `ESTUDIANTE`; otro rol solo con token de ADMIN). Probado con la misma mutación que manda la app.
   - Ojo: el primer ADMIN ya no se puede crear por `registrarUsuario`; ver `GUIA_CLONADO_Y_CONFIGURACION.md`, paso 8.

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

5. ~~**`.env` mal formado en académico.**~~ ✅ Corregido (ver 0.1).

6. **Contraseñas débiles y puertos de BD publicados.**
   - `password123`, `guest/guest`. El compose ya acepta variables (`Docker/.env.example`); falta poner valores reales en la nube.
   - En el compose los puertos de BD se publican al host; en la nube deben quedar privados.
   - Sin `NODE_ENV=production`, los errores GraphQL devuelven el `stacktrace` al cliente. Con `NODE_ENV=production` el Gateway además oculta los mensajes internos (ver 0.1 #12).

7. **Scylla en modo desarrollador.**
   - `--developer-mode=1` no debe usarse en producción.

---

## 7. Decisiones pendientes (responder antes de migrar)

1. **¿Suben también los microservicios o solo las BD?**
   - Recomendación: **todo**. Si solo suben las BD y el gateway queda local, la app solo funciona en la red del PC.
   - Implica crear Dockerfiles para gateway y los 5 servicios.

2. **¿Qué proveedor?**
   - **Recomendado para empezar: Azure for Students.** Correo institucional ULSA activo, $100 USD de crédito por 12 meses, sin tarjeta. Una VM B2ms (2 vCPU / 8 GB, ~$60/mes aprox.) cubre un mes con el crédito.
   - **Oracle Cloud Always Free (gratis permanente):** según reportes de jun-2026 el límite ARM bajó de 4 OCPU / 24 GB a **2 OCPU / 12 GB** (cuentas PAYG podrían conservar 4/24; verificar en la documentación oficial). 12 GB alcanza. Requiere tarjeta para verificación, a veces no hay capacidad ARM y puede reclamar instancias inactivas.
   - Las 5 imágenes (`mongo`, `redis-stack`, `neo4j`, `scylla`, `rabbitmq`) tienen build `arm64`, así que Oracle ARM es viable.
   - **VPS de pago:** Hetzner CX33 (4 vCPU / 8 GB) ~€8.49/mes tras la subida de jun-2026, pero se reportó sin disponibilidad. DigitalOcean tiene crédito en GitHub Student Pack.
   - No conviene repartir en servicios gestionados gratis (Render duerme y sus 750 h/mes no alcanzan para 6 servicios; Aura Free se pausa; ScyllaDB no tiene tier gratis).
   - Verificar precios y límites al retomar: cambian seguido.

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

- [x] Verificar que los datos están completos (inventario de la sección 5).
- [x] Corregir `academico-service/.env`.
- [x] Corregir RabbitMQ (`hostname` fijo), BD de deportes, perfiles de seguridad, nodos huérfanos en Neo4j, espera de subgrafos en el gateway, renombrar `node_modules-v2` (ver 0.1).
- [x] Compose con contraseñas por variable (`Docker/.env.example`).
- [ ] Terminar las implementaciones pendientes en local (ver 0.3).
- [ ] Decidir proveedor y crear la VM/instancia.
- [ ] Definir dominio (o IP fija) y DNS.

### Fase 1 — Dockerizar los servicios

- [ ] Crear `Dockerfile` + `.dockerignore` para `gateway` y para cada servicio de `Proyecto/services`.
- [ ] Crear `docker-compose.prod.yml` con los 11 contenedores (o uno de aplicación aparte).
- [ ] Usar red interna; exponer solo Caddy (80/443) → gateway:4000.
- [ ] Quitar la publicación de puertos de BD al host (o bind a `127.0.0.1`).
- [ ] `INFRASTRUCTURE_MODE=docker` y `NODE_ENV=production` en todos los servicios; `TRUST_PROXY=true` solo en el gateway.
- [ ] Los puertos 4001–4005 de los subgrafos **no** se publican: toman la IP de `x-forwarded-for` tal cual, así que solo el Gateway debe poder hablarles (los `x-user-*` sí los validan contra el JWT).
- [ ] `healthcheck` en BD y servicios, `depends_on: condition: service_healthy`, `restart: unless-stopped`. El gateway ya espera a los subgrafos por su cuenta (`esperar-subgrafos.js`).
- [ ] Límites de memoria: Scylla `--smp 1 --memory 750M`, heap de Neo4j ~512 MB.
- [ ] Variables clave (ver sección 11). **Deportes:** el perfil `docker` ya apunta a la BD `deportes`; no poner override a `resistencia`.

### Fase 2 — Migrar datos (comandos en la sección 12)

- [ ] Detener los microservicios para congelar escrituras; esperar a que la cola de auditoría quede en 0 mensajes.
- [ ] Respaldar: MongoDB (**excluyendo la BD `admin`**, si no se restaura el usuario viejo `admin/password123`), Neo4j (dump), Redis (`dump.rdb`), RabbitMQ (definiciones) y Scylla (CSV).
- [ ] Transferir los respaldos a la VM (scp/rsync).
- [ ] Restaurar: Mongo → Neo4j → Redis → RabbitMQ → arrancar auditoria-service (crea tablas) → Scylla `COPY FROM`.
- [ ] Si se decide no llevar los usuarios: excluir `seguridad.usuarios` en el dump y en Neo4j correr `MATCH (u:User) WHERE u.demo IS NULL DETACH DELETE u`.
- [ ] Validar conteos contra la sección 5.

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
- **Sesiones:** el gateway exige `session:<jti>` en Redis. Redis sí se migra (requisito), pero las sesiones duran 1 h, y si se cambia `JWT_SECRET` en la nube todos los tokens viejos dejan de valer de todos modos: hay que volver a iniciar sesión.
- **El mayor riesgo es el cambio de URL:** si la app apunta a `10.0.2.2`, las versiones instaladas dejarán de funcionar. Solución: usar un dominio estable desde el inicio o recompilar/redistribuir el APK.
- **Recomendación:** ventana de 2-4 h en horario de baja uso, con respaldo previo y validación posterior.

---

## 11. Variables de entorno de referencia (sin secretos reales)

Gateway:

`JWT_SECRET` debe ser **el mismo en los 6** (gateway firma/valida y los subgrafos verifican la identidad). Todos llevan `NODE_ENV=production`. Las contraseñas deben coincidir con las de `Docker/.env`.

Gateway (no tiene perfiles; todo va por variable):

```env
NODE_ENV=production
PORT_GATEWAY=4000
# Caddy va delante: tomar la IP real del último valor de X-Forwarded-For.
# SOLO en la nube; en local dejarlo en false (si no, cualquiera falsifica su IP).
TRUST_PROXY=true
JWT_SECRET=<compartido>
REDIS_URL=redis://default:<pass>@redis-stack:6379
NEO4J_URI=bolt://neo4j:7687
NEO4J_USER=neo4j
NEO4J_PASSWORD=<pass>
RABBITMQ_URL=amqp://<user>:<pass>@rabbitmq:5672
SEGURIDAD_URL=http://seguridad-service:4005/
ACADEMICO_URL=http://academico-service:4004/
DEPORTES_URL=http://deportes-service:4001/
MAPA_URL=http://mapa-service:4002/
AUDITORIA_URL=http://auditoria-service:4003/
```

Seguridad:

```env
NODE_ENV=production
INFRASTRUCTURE_MODE=docker
PORT_SEGURIDAD=4005
JWT_SECRET=<compartido>
MONGODB_URI=mongodb://<user>:<pass>@mongodb:27017/seguridad?authSource=admin
REDIS_URL=redis://default:<pass>@redis-stack:6379
NEO4J_URI=bolt://neo4j:7687
NEO4J_USER=neo4j
NEO4J_PASSWORD=<pass>
RABBITMQ_URL=amqp://<user>:<pass>@rabbitmq:5672
```

Académico:

```env
NODE_ENV=production
INFRASTRUCTURE_MODE=docker
PORT_ACADEMICO=4004
JWT_SECRET=<compartido>
MONGODB_URI=mongodb://<user>:<pass>@mongodb:27017/academico?authSource=admin
REDIS_URL=redis://default:<pass>@redis-stack:6379
HORARIO_TTL_SECONDS=86400
RABBITMQ_URL=amqp://<user>:<pass>@rabbitmq:5672
```

Deportes / Mapa / Auditoría:

```env
# Deportes (BD "deportes", ya no "resistencia")
NODE_ENV=production
INFRASTRUCTURE_MODE=docker
PORT_DEPORTES=4001
JWT_SECRET=<compartido>
MONGODB_URI=mongodb://<user>:<pass>@mongodb:27017/deportes?authSource=admin
RABBITMQ_URL=amqp://<user>:<pass>@rabbitmq:5672

# Mapa
NODE_ENV=production
INFRASTRUCTURE_MODE=docker
PORT_MAPA=4002
JWT_SECRET=<compartido>
MONGODB_URI=mongodb://<user>:<pass>@mongodb:27017/mapa?authSource=admin
REDIS_URL=redis://default:<pass>@redis-stack:6379
REDIS_CACHE_TTL_SECONDS=60
RABBITMQ_URL=amqp://<user>:<pass>@rabbitmq:5672

# Auditoría (no usa Mongo; su .env local trae líneas sobrantes de una plantilla vieja)
NODE_ENV=production
INFRASTRUCTURE_MODE=docker
PORT_AUDITORIA=4003
JWT_SECRET=<compartido>
SCYLLADB_CONTACT_POINTS=scylladb
SCYLLADB_PORT=9042
RABBITMQ_URL=amqp://<user>:<pass>@rabbitmq:5672
```

> No commitear `.env` reales. Usar `.env.example` y un gestor de secretos.

---

## 12. Comandos útiles

### 12.1 Respaldo en la PC (Git Bash, desde la raíz del repo)

```bash
mkdir -p backup

# MongoDB: todo menos la BD admin (para no traer el usuario admin/password123 viejo).
# Para no llevar usuarios, agregar: --nsExclude='seguridad.usuarios'
docker exec ulsa-mongodb mongodump -u admin -p password123 --authenticationDatabase admin \
  --nsExclude='admin.*' --gzip --archive=/tmp/mongo.gz
docker cp ulsa-mongodb:/tmp/mongo.gz ./backup/

# Neo4j: hay que detenerlo para el dump
docker stop ulsa-neo4j
docker run --rm -v docker_ulsa_neo4j_data:/data -v "$PWD/backup":/backups neo4j:5.26 \
  neo4j-admin database dump neo4j --to-path=/backups
docker start ulsa-neo4j

# Redis
docker exec ulsa-redis-stack redis-cli -a password123 --no-auth-warning SAVE
docker cp ulsa-redis-stack:/data/dump.rdb ./backup/

# RabbitMQ (colas, usuarios, bindings). En Git Bash hace falta MSYS_NO_PATHCONV=1
MSYS_NO_PATHCONV=1 docker exec ulsa-rabbitmq rabbitmqctl export_definitions /tmp/defs.json
docker cp ulsa-rabbitmq:/tmp/defs.json ./backup/

# ScyllaDB (auditoría)
docker exec ulsa-scylladb cqlsh -e "COPY auditoria.logs_eventos TO '/tmp/logs.csv' WITH HEADER=true"
docker exec ulsa-scylladb cqlsh -e "COPY auditoria.tipos_evento_por_dia TO '/tmp/tipos.csv' WITH HEADER=true"
docker cp ulsa-scylladb:/tmp/logs.csv ./backup/
docker cp ulsa-scylladb:/tmp/tipos.csv ./backup/
```

### 12.2 Restauración en la VM

```bash
# Mongo
docker cp backup/mongo.gz <cont-mongo>:/tmp/
docker exec <cont-mongo> mongorestore -u <user> -p <pass> --authenticationDatabase admin --gzip --archive=/tmp/mongo.gz

# Neo4j (con el contenedor detenido)
docker run --rm -v <vol-neo4j-data>:/data -v "$PWD/backup":/backups neo4j:5.26 \
  neo4j-admin database load neo4j --from-path=/backups --overwrite-destination=true

# Redis: copiar dump.rdb a /data ANTES de arrancar Redis
docker cp backup/dump.rdb <cont-redis>:/data/dump.rdb   # con el contenedor creado pero detenido

# RabbitMQ
docker cp backup/defs.json <cont-rabbit>:/tmp/
docker exec <cont-rabbit> rabbitmqctl import_definitions /tmp/defs.json

# Scylla: primero arrancar auditoria-service (crea keyspace y tablas)
docker cp backup/logs.csv <cont-scylla>:/tmp/ && docker cp backup/tipos.csv <cont-scylla>:/tmp/
docker exec <cont-scylla> cqlsh -e "COPY auditoria.logs_eventos FROM '/tmp/logs.csv' WITH HEADER=true"
docker exec <cont-scylla> cqlsh -e "COPY auditoria.tipos_evento_por_dia FROM '/tmp/tipos.csv' WITH HEADER=true"
```

### 12.3 Otros

```bash
# Tamaño de volúmenes
docker system df -v

# Levantar infraestructura local
cd Docker
docker compose up -d

# Pruebas
cd Proyecto/gateway && npm test                       # 27/27
cd Proyecto/services/seguridad-service && npm test    # 9/9
cd Proyecto/services/academico-service && npm test    # 6/6
cd Proyecto/services/deportes-service && npm test     # 10/10
cd Proyecto/services/mapa-service && npm test         # 3/3
cd Proyecto/services/auditoria-service && npm test    # 4/4

# Prueba de login (GraphQL)
curl -X POST http://<host>:4000/ \
  -H "Content-Type: application/json" \
  -d '{"query":"mutation($e:String!,$p:String!){login(email:$e,password:$p){token usuario{id email rol}}}","variables":{"e":"correo@ulsa.edu.mx","p":"<pass>"}}'
```

---

## 13. Próximos pasos sugeridos

1. Terminar en local las implementaciones pendientes (sección 0.3), incluyendo el contrato de registro y la decisión REST/GraphQL del QR.
2. Hacer commit/PR de `feature/correcciones-nube` (las pruebas ya pasan todas).
3. Paso A: Dockerfiles, `docker-compose.prod.yml` y Caddy (sección 9, Fase 1).
4. Elegir proveedor (sección 7) y crear la VM.
5. Ejecutar las fases 2 a 5 de la sección 9.

---

## 14. Referencias de archivos

Backend:

- `Docker/docker-compose.yml`
- `CONTEXTO_PROYECTO.md`
- `Proyecto/gateway/src/index.js`
- `Proyecto/gateway/src/authentication.js`
- `Proyecto/services/*/src/schema.graphql`
- `Proyecto/services/*/src/infrastructure/runtime-config.js`

Android:

- `Deportes_ULSA/QR-CONTEXTO.md`
- `Deportes_ULSA/CHANGELOG-F01-v2.md`
- `Deportes_ULSA/app/src/main/java/com/ulsa/deportes/ui/auth/network/AuthService.kt`
- `Deportes_ULSA/app/src/main/java/com/ulsa/deportes/ui/auth/domain/AuthRepositoryImpl.kt`
- `Deportes_ULSA/app/src/main/java/com/ulsa/deportes/ui/auth/data/SessionPreferences.kt`
- `Deportes_ULSA/app/src/main/java/com/ulsa/deportes/ui/qrSection/qrHome/network/QrApi.kt`
- `Deportes_ULSA/app/src/main/java/com/ulsa/deportes/ui/homeSection/homeHome/network/HomeService.kt`
- `Deportes_ULSA/app/src/main/res/xml/network_security_config.xml`

Archivos nuevos de las correcciones 8–14 (detalle en la sección 15):

- `Proyecto/gateway/src/client-info.js`, `Proyecto/gateway/src/format-error.js`
- `Proyecto/services/*/src/domain/errors.js` (seguridad, académico, deportes, mapa)
- `Proyecto/services/seguridad-service/src/domain/authorization.js`
- Pruebas: `gateway/test/client-info.test.js`, `gateway/test/format-error.test.js`, `seguridad-service/test/registro.test.js`, `deportes-service/test/dominio.test.js`, `deportes-service/test/eventos-auditoria.test.js`, `auditoria-service/test/authorization.test.js`

---

## 15. Bitácora de las correcciones 8–14 (para retomar)

Todo esto está en `feature/correcciones-nube`, **sin commit**. Salió de revisar el backend pensando en exponerlo a internet: varias cosas que en local no importaban (registro abierto, consultas sin token, IPs, mensajes de error) sí importan en cuanto el Gateway sea público.

### 15.1 Resumen rápido

| # | Antes | Ahora | Dónde se ve |
|---|---|---|---|
| 8 | `registrarUsuario(rol:"ADMIN")` sin token creaba un ADMIN | Sin `rol` = ESTUDIANTE; otro rol solo con token de ADMIN, si no `FORBIDDEN` + evento auditado | seguridad |
| 9 | `allUsuarios`/`verUsuario`/`roles` sin token | ADMIN / propio-o-ADMIN / cualquier sesión | seguridad |
| 10 | Todos los eventos con `ip_origen = ::1` y `user_agent = NO_DISPONIBLE` | IP y user-agent reales del cliente | gateway → seguridad, académico, deportes |
| 11 | Validaciones como `INTERNAL_SERVER_ERROR` | `BAD_USER_INPUT` / `NOT_FOUND` / `FORBIDDEN` con su mensaje | seguridad, académico, deportes, mapa |
| 12 | `"401: Unauthorized"` con la URL interna del subgrafo; mensajes internos al cliente | Mensaje y código reales; en producción los internos se ocultan | gateway |
| 13 | 2 pruebas rotas; 3 servicios sin pruebas; `.env` con variables sobrantes | 59 pruebas pasando; variables sin uso comentadas | todos |
| 14 | Eventos de deportes con `usuario_id`/`ip_origen` en `null`; categoría o ubicación inválidas = error interno | Eventos con autor e IP; validación con mensaje claro | deportes |

### 15.2 Cambios que notará quien use la API (app Android, Apollo Studio, scripts)

- **`registrarUsuario`**
  - `rol` es opcional. Sin `rol` (o vacío) → `ESTUDIANTE`. La app manda `rol:"ESTUDIANTE"` y sigue funcionando sin cambios.
  - Pedir otro rol sin token de ADMIN → `FORBIDDEN` "Solo un ADMIN puede registrar usuarios con un rol distinto de ESTUDIANTE." y evento `ASIGNACION_ROL_PERMISO` con `resultado: 'denegado'`, `operacion: 'registrarUsuario'`.
  - El email se guarda en minúsculas y sin espacios (el login también lo normaliza). Nombre obligatorio. Contraseña ≥ 6 caracteres (igual que `RegisterViewModel` de la app). Matrícula: 6 a 10 dígitos (regla que ya existía).
- **El primer ADMIN** ya no se crea por GraphQL: registro normal → `rol:'ADMIN'` en Mongo → **reiniciar seguridad** (sincroniza Mongo → Neo4j al arrancar). Pasos exactos en `GUIA_CLONADO_Y_CONFIGURACION.md`, paso 8. Si se sube en Mongo y no se reinicia, el Gateway le sigue dando `FORBIDDEN` porque Neo4j tiene el rol viejo.
- **Consultas de seguridad:** `allUsuarios` solo ADMIN; `verUsuario` el propio usuario o ADMIN (id mal formado → `null`); `roles` cualquier usuario con sesión. Antes las tres eran públicas.
- **`registrarEquipo`:** `categoria` debe ser `VARONIL`, `FEMENIL` o `MIXTO` (acepta minúsculas, se guarda en mayúsculas); `nombre` y `deporte` obligatorios.
- **`registrarPractica`:** `ubicacionId` debe ser un ObjectId (el `_id` de un espacio de mapa). Con algo como `"cancha-1"` → `BAD_USER_INPUT` "La ubicación de la práctica no es válida.".
- **Ids mal formados** (`"xx"`) en deportes, mapa y académico → `null` en consultas, `NOT_FOUND` en mutaciones. Antes: `Cast to ObjectId failed ...` como error interno.
- **Forma de los errores:** el cliente recibe directamente `{ message, path, extensions: { code } }` con el mensaje del subgrafo. Códigos: `UNAUTHENTICATED`, `FORBIDDEN`, `BAD_USER_INPUT`, `NOT_FOUND`, `INTERNAL_SERVER_ERROR`. Con `NODE_ENV=production` el mensaje de `INTERNAL_SERVER_ERROR` es siempre "Error interno del servidor."; el original queda en el log del Gateway con el prefijo `[gateway] Error interno ocultado al cliente:`.

### 15.3 Convenciones nuevas en el código (seguir el mismo patrón)

- **Errores de dominio** — `src/domain/errors.js` en seguridad, académico, deportes y mapa:
  - `ErrorDeDominio(mensaje)` → `BAD_USER_INPUT`. Para reglas de negocio y datos inválidos. Reemplaza a `throw new Error(...)` en `domain/` y `application/`.
  - `RecursoNoEncontrado(mensaje)` → `NOT_FOUND`. Para los `requireById` de los repositorios.
  - **No llevan `http.status` a propósito**: si el subgrafo responde 400/404, el Gateway marca toda la respuesta como fallida y la envuelve. Los de permiso (`UNAUTHENTICATED`/`FORBIDDEN` en `authorization.js`) conservan su `http.status` como estaban; el `formatError` del Gateway los desenvuelve.
  - `new Error` solo queda para fallas internas de verdad (worker de auditoría, rollback de Neo4j en `cambiarRolUsuario`, configuración).
- **Autorización en seguridad** — ahora tiene su `src/domain/authorization.js` (como los demás servicios): `rolSolicitadoEnRegistro`, `puedeRegistrarConRol`, `assertPuedeListarUsuarios`, `assertPuedeVerUsuario`, `requireActor`, `prohibido`, `noAutenticado`. El RBAC del Gateway (Neo4j) **solo revisa mutaciones**; las queries se protegen en cada subgrafo.
- **Headers Gateway → subgrafos** (`gateway/src/index.js`, `willSendRequest`):

  | Header | Lo pone | Uso |
  |---|---|---|
  | `authorization`, `x-user-id`, `x-user-role` | `applyAuthenticatedHeaders` (ya existía) | Identidad; los subgrafos la cruzan con el JWT |
  | `x-forwarded-for` | `aplicarHeadersCliente` (nuevo) | IP real del cliente para auditoría |
  | `x-client-user-agent` | `aplicarHeadersCliente` (nuevo) | User-agent del cliente (máx. 256 caracteres) |

  El Gateway **borra primero** lo que mande el cliente en esos headers y luego pone los suyos.
- **IP del cliente** (`gateway/src/client-info.js`): con `TRUST_PROXY=false` (local) usa la IP del socket e ignora `X-Forwarded-For`. Con `TRUST_PROXY=true` (nube, detrás de Caddy) usa el **último** valor de `X-Forwarded-For`, que es el que agrega Caddy; los anteriores los pudo escribir el cliente. Quita el prefijo `::ffff:`.
- **Eventos de auditoría:** el worker guarda en columnas propias `usuario_id`, `ip_origen` y `severidad`; todo lo demás va en `detalle`. Patrón: el actor trae `id`, `rol`, `ip_origen`, `jti` (`infrastructure/gateway-identity.js`) y los casos de uso lo reciben como **primer parámetro**. En deportes hay un helper `datosAuditoria(actor)` en `sports-use-cases.js`.
- **Ids en repositorios:** antes de `findById`/`findByIdAndUpdate`/`findByIdAndDelete` se revisa `mongoose.isValidObjectId(id)` (en académico con el helper `idValido`).
- **Catálogos del dominio:** si el modelo de Mongoose tiene un `enum`, el dominio debe tener la misma lista y validarla antes (como `TIPOS_ESPACIO` en mapa y `CATEGORIAS_EQUIPO` en deportes). Si no, el error sale de Mongoose como interno.

### 15.4 Variables de entorno nuevas o con efecto nuevo

| Variable | Servicio | Local | Nube | Efecto |
|---|---|---|---|---|
| `TRUST_PROXY` | gateway | `false` (o sin poner) | `true` | Leer la IP real de `X-Forwarded-For` |
| `NODE_ENV` | todos | sin poner | `production` | Además de quitar el `stacktrace`, el Gateway oculta los mensajes internos |

Ya están en `gateway/.env.example` y en la sección 11.

### 15.5 Datos que se tocaron al hacer estas correcciones

- **MongoDB `seguridad.usuarios`:** los 7 usuarios con mayúsculas en el email quedaron en minúsculas. Lo hace `normalizarEmailsExistentes()` al arrancar seguridad: es idempotente y también corrige un respaldo viejo que se restaure en la nube. Si dos emails solo difieren en mayúsculas, no tumba el servicio: avisa con `⚠️ No se pudieron normalizar los emails`.
- **Usuarios y equipo de prueba:** se crearon usuarios `*@prueba.local` y un equipo "Equipo Prueba IP ..." para probar, y **se borraron** de Mongo, Neo4j y Redis. Conteos finales iguales a la sección 5: 18 usuarios en Mongo, 24 `User` en Neo4j (18 + 6 demo), 5 equipos, 1 espacio, 4 materias.
- **ScyllaDB:** las pruebas dejaron eventos reales del 24/nov/2026 (`AUTENTICACION_USUARIO`, `USER_REGISTERED`, `ASIGNACION_ROL_PERMISO`, `EQUIPO_REGISTRADO`, `PRACTICA_REGISTRADA`, `ACCESS_DENIED`). No se borraron porque la tabla es inmutable a propósito. Se reconocen por `ip_origen = 189.2.3.4` o el user-agent `PruebaIP-*`.
- **`.env` (no están en git):** en seguridad, deportes y auditoría las variables que el servicio no lee quedaron comentadas con `# [sin uso]`. Los valores no se cambiaron.
- Nota: la colección de roles en Mongo se llama `rols` (Mongoose pluraliza "Rol"); tiene los 6 roles. No es un error.

### 15.6 Cómo verificarlo a mano al retomar

Pruebas unitarias: ver 12.3 (todas deben pasar: 27 + 9 + 6 + 10 + 3 + 4 = 59).

Con los 6 servicios prendidos (Git Bash):

```bash
G=http://localhost:4000/
q(){ curl -s -X POST $G -H 'content-type: application/json' "$@"; echo; }

# 8) Un anónimo no puede pedir ADMIN -> FORBIDDEN "Solo un ADMIN puede registrar..."
q -d '{"query":"mutation{registrarUsuario(matricula:\"99000001\",nombre:\"X\",email:\"x@prueba.local\",password:\"123456\",rol:\"ADMIN\"){id}}"}'

# 9) allUsuarios sin token -> UNAUTHENTICATED (antes devolvía los 18 usuarios)
q -d '{"query":"{ allUsuarios { id email } }"}'

# 11) Validación -> BAD_USER_INPUT con el mensaje de la matrícula
q -d '{"query":"mutation{registrarUsuario(matricula:\"abc\",nombre:\"X\",email:\"x@prueba.local\",password:\"123456\"){id}}"}'

# 12) 401 de un subgrafo -> mensaje real, sin "response" ni "localhost:4001"
q -d '{"query":"{ allEquipos { id } }"}'
```

**Probar el "modo nube" sin subir nada:** con los otros 5 servicios prendidos, levantar un segundo Gateway en otro puerto:

```bash
cd Proyecto/gateway
PORT_GATEWAY=4010 NODE_ENV=production TRUST_PROXY=true node src/index.js
```

Contra `http://localhost:4010/`:

- Un error interno debe decir solo "Error interno del servidor." y no traer `stacktrace`.
- Un login con `-H 'x-forwarded-for: 6.6.6.6, 189.2.3.4'` debe quedar en ScyllaDB con `ip_origen = 189.2.3.4`:

```bash
docker exec ulsa-scylladb cqlsh -e "SELECT ip_origen, usuario_id, severidad FROM auditoria.logs_eventos WHERE fecha_dia='AAAA-MM-DD' AND tipo_evento='AUTENTICACION_USUARIO' ORDER BY timestamp DESC LIMIT 5"
```

Para probar mutaciones de ADMIN, crear un ADMIN de prueba como en la guía (paso 8) y **borrarlo al terminar**: de Mongo (`seguridad.usuarios`), de Neo4j (`MATCH (u:User {id:'<id>'}) DETACH DELETE u`) y sus `session:*` de Redis.

### 15.7 Qué queda pendiente después de esto

- Lo de la sección 0.3: QR REST vs GraphQL, logout real en la app, commit y PR.
- En `docker-compose.prod.yml` **no publicar 4001–4005**: los subgrafos toman la IP de `x-forwarded-for` tal cual, así que solo el Gateway debe poder hablarles.
- `CONSULTA_DATOS_SENSIBLES` con `resultado: 'denegado'` sigue sin emitirse (limitación ya anotada en `EVENTOS_FORENSES_PUNTO1.md`, sección 6).
- Los errores en producción todavía incluyen `extensions.serviceName` (ej. `"deportes"`). Es solo el nombre lógico, no una URL; se puede quitar en `format-error.js` si se quiere ocultar también.
