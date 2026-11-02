# Documentación Completa del Proyecto UlsaHub (Campus Hub)

> Consolidado: arquitectura, infraestructura, autenticación, Redis (sesiones + caché horarios + caché mapa), esquemas GraphQL, tests, variables de entorno y pendientes.

---

## 1. Arquitectura General

**Patrón:** Microservicios con Apollo Federation (Gateway + Subgraphs)

| Servicio | Puerto | Responsabilidad | DB Principal | Redis |
|----------|--------|-----------------|--------------|-------|
| **gateway** | 4000 | Composition, auth centralizada (JWT + Redis), routing | — | **Sesiones** (`session:<jti>`) |
| **seguridad-service** | 4005 | Auth, usuarios, roles, JWT, sesiones, Neo4j | MongoDB, Neo4j | **Sesiones** (lista blanca) + **Caché roles** (`cache:roles`) |
| **academico-service** | 4004 | Carreras, materias, inscripciones, calificaciones, **horarios** | MongoDB | **Caché horarios** (`horario:estudiante:<alumnoId>:<periodoId>`) |
| **deportes-service** | 4001 | Equipos, prácticas deportivas | MongoDB | — |
| **mapa-service** | 4002 | Espacios físicos (aulas, edificios, coordenadas) | MongoDB | **Caché espacios** (`cache:espacio*`) |
| **auditoria-service** | 4003 | Logs inmutables (event sourcing) | ScyllaDB | — |

**Message Broker:** RabbitMQ (eventos de dominio async)
- Cola: `transmisiones-auditoria` (durable)
- Eventos: `USUARIO_REGISTRADO`, `USUARIO_LOGIN`, `USUARIO_LOGOUT`, `ROL_CREADO`, `INSCRIPCION_CREADA`, `SESION_HORARIO_CREADA/ACTUALIZADA/ELIMINADA`, `ESPACIO_CREADO/DESACTIVADO/ACTIVADO`, etc.

---

## 2. Infraestructura (Docker Compose)

```yaml
# Docker/docker-compose.yml
mongodb:      27018  (admin/password123)
redis-stack:  6380   (password123)  # Redis Stack: cache + sesiones + módulos (JSON, Search, TimeSeries)
neo4j:        7475/7688  (neo4j/password123)
scylladb:     9043   # Auditoría inmutable (Cassandra-compatible)
rabbitmq:     5673/15673  (guest/guest)
```

**Red:** `ulsa-network` (bridge)
**Volúmenes persistentes:** `ulsa_mongodb_data`, `ulsa_redis_data`, `ulsa_neo4j_data`, `ulsa_scylla_data`, `ulsa_rabbitmq_data`

---

## 3. Flujo de Autenticación (JWT + Redis Session Store)

```
1. Login en seguridad-service → JWT (firma HS256) + jti (UUID v4)
2. Sesión guardada en Redis:  session:<jti>  TTL = 3600s (1h)
   Valor: { userId, rol }
3. Gateway valida CADA request:
   a) Verifica firma JWT (JWT_SECRET compartido)
   b) Verifica session:<jti> existe en Redis y coincide userId+rol
   c) Si OK → pasa x-user-id, x-user-role a subgraphs vía headers
4. Subgraphs reciben actor: { id, rol } en context (gateway-identity.js)
```

### Gateway - Nuevos módulos (refactor 2024)

- **`authentication.js`**: Lógica pura de validación JWT + verificación sesión activa
  - `authenticateAuthorizationHeader()`: decode + verify firma + valida estructura payload
  - `authenticateActiveSession()`: usa `sessionStore.hasMatchingSession()`
  - `applyAuthenticatedHeaders()`: limpia headers cliente + setea `authorization`, `x-user-id`, `x-user-role`
- **`redis-session-store.js`**: Adapter Redis tolerante a fallos
  - `hasMatchingSession({ jti, actor })`: GET `session:<jti>` + compara `userId` y `rol`

> **Cambio importante:** Antes el gateway validaba directo contra Redis en `index.js`. Ahora la lógica está separada en módulos testeables (`authentication.test.js`).

---

## 4. Redis: Usos por Servicio

### 4.1 Gateway + Seguridad - **Session Store (Lista Blanca)**

| Archivo | Clave | TTL | Valor |
|---------|-------|-----|-------|
| `seguridad-service/src/index.js:212` | `session:<jti>` | 3600s (1h) | `{ userId, rol }` |
| `gateway/src/redis-session-store.js:20` | `session:<jti>` | (heredado) | Validación cross-check |

**Flujo Login (seguridad-service):**
```javascript
// Línea 202-216
const jti = crypto.randomUUID();
const token = jwt.sign({ id, rol, jti }, JWT_SECRET, { expiresIn: 3600 });
await redisClient.setEx(`session:${jti}`, 3600, JSON.stringify({ userId: id, rol }));
```

**Flujo Validación (gateway):**
```javascript
// authentication.js:57-75
const auth = authenticateAuthorizationHeader(authorization, jwtSecret);
const isActive = await sessionStore.hasMatchingSession({ jti: auth.jti, actor: auth.actor });
```

**Logout / Expiración:**
- `logout` mutation → `redisClient.del(session:<jti>)`
- TTL natural 1h → auto-expiración
- Gateway loggea: `🔒 GATEWAY SESIÓN EXPIRADA: jti=..., userId=...`

### 4.2 Seguridad - **Caché Roles** (5 min)

```javascript
// seguridad-service/src/index.js:109-118
Query.roles:
  const cached = await redisClient.get('cache:roles');
  if (cached) return JSON.parse(cached);
  // ... consulta MongoDB ...
  await redisClient.setEx('cache:roles', 300, JSON.stringify(data));
```

**Invalidación:** `crearRol` mutation → `redisClient.del('cache:roles')`

### 4.3 Académico - **Caché Horarios** (Cache-Aside + Lock Memoria)

**Archivos clave:**
- `src/infrastructure/redis-cache.js` → Adapter tolerante a fallos (get/set/del)
- `src/application/academic-use-cases.js:199-354` → Lógica cache-aside + invalidación

**Patrón Cache-Aside:**
```
Key:  horario:estudiante:<alumnoId>:<periodoId>
TTL:  HORARIO_TTL_SECONDS (default 86400 = 24h, configurable por .env)
```

**Algoritmo `obtenerHorarioAlumno`:**
1. `cache.get(clave)` → HIT → return
2. MISS → check `_cacheLocks.has(clave)` → si existe, `await` esa promise (evita thundering herd)
3. Crear lock + promise que:
   - Consulta MongoDB (asignaciones + horarios + materias)
   - `cache.set(clave, filas, ttl)`
   - Elimina lock en `finally`
4. Retorna promise

**Invalidación Automática (escritura):**
| Mutación | Acción |
|----------|--------|
| `crearSesionHorario` | `invalidarHorariosDeAsignacion(asignacion)` |
| `actualizarSesionHorario` | Invalida asignación anterior + nueva |
| `eliminarSesionHorario` | `invalidarHorariosDeAsignacion(asignacion)` |
| `inscribirAlumno` | Invalida clave del alumno inscrito |

`invalidarHorariosDeAsignacion` busca todos los `alumnoIds` inscritos y borra sus claves `horario:estudiante:<alumnoId>:<periodoId>`.

**Lock en memoria (`_cacheLocks` Map):**
- ✅ Funciona en single-instance
- ❌ **Problema conocido:** Se pierde con múltiples réplicas → mover a Redis distributed lock (Redlock)

**Logs característicos:**
```
🔍 USE CASE CACHE MISS: horario:estudiante:... → consultando MongoDB
📦 CACHE SET: horario:estudiante:... (TTL: 86400s)
💾 USE CASE CACHE POPULATED: horario:estudiante:...
⚡ USE CASE CACHE HIT: horario:estudiante:...
🗑️ USE CASE CACHE INVALIDATE: horario:estudiante:...
📦 CACHE DEL: horario:estudiante:...
🕐 Cache TTL horarios: 86400s (24h)
```

### 4.4 Mapa - **Caché Espacios** (Cache-Aside + SCAN Invalidation)

**Archivos clave:**
- `src/infrastructure/redis-cache.js` → Adapter con `invalidateByPrefix` usando `scanIterator`
- `src/application/mapa-use-cases.js` → Cache-aside con métricas de latencia

**Patrón:**
```
Keys:
  - Individual: cache:espacio:<id>
  - Listas:     cache:espacios:tipo:<tipo>:activo:<activo>  (filtros codificados)
TTL:  redisCacheTtlSeconds (default 60s, configurable)
```

**Invalidación por Prefijo (SCAN, no KEYS):**
```javascript
// redis-cache.js:67-91
async invalidateByPrefix(prefix) {
  for await (const keys of client.scanIterator({ MATCH: `${prefix}*`, COUNT: 100 })) {
    if (keys.length) await client.del(keys);
  }
}
```
> Usa `scanIterator` (redis@5) que devuelve lotes `string[]`, no claves sueltas. Evita bloquear Redis y OOM.

**Mutaciones que invalidan:** `crearEspacio`, `desactivarEspacio`, `activarEspacio` → `invalidarEspacios()` (prefijo `cache:espacio`)

**Logs con métricas:**
```
[cache] consulta=espacios({"tipo":"AULA","activo":true}) resultado=MISS fuente=MongoDB lecturaRedisMs=1.23 totalMs=45.67
[cache] consulta=espacio("abc123") resultado=HIT fuente=Redis lecturaRedisMs=0.45 totalMs=1.23
[cache] Invalidación cache:espacio*: 3 clave(s).
[cache] consulta=espacios(...) resultado=UNAVAILABLE fuente=MongoDB (Redis caído)
```

**Degradación graceful:** Si Redis `UNAVAILABLE` → consulta MongoDB directo, loggea `resultado=UNAVAILABLE fuente=MongoDB`. Al recuperar Redis, siguientes consultas repueblan caché.

---

## 5. Esquemas GraphQL (Subgraphs)

### 5.1 Seguridad (`seguridad-service/schema.graphql`)
```graphql
type Usuario { id: ID!, matricula: String!, nombre: String!, email: String!, rol: String!, activo: Boolean! }
type Rol { id: ID!, nombre: String! }
input RegistrarUsuarioInput { matricula: String!, nombre: String!, email: String!, password: String!, rol: String! }
type AuthPayload { token: String!, usuario: Usuario! }
extend type Query { verUsuario(id: ID!): Usuario, allUsuarios: [Usuario!]!, roles: [Rol!]! }
extend type Mutation { registrarUsuario(input: RegistrarUsuarioInput!): Usuario!, login(email: String!, password: String!): AuthPayload!, logout: Boolean!, crearRol(nombre: String!): Rol! }
```

### 5.2 Académico (`academico-service/schema.graphql`)
Ver archivo completo en `Proyecto/node_modules-v2/services/academico-service/src/schema.graphql`
- **Queries:** carreras, materias, periodos, perfilAcademico, asignaciones, inscripciones, calificaciones, faltas, examenes, **horarios**, **miHorario**, **horarioAlumno**
- **Mutations:** CRUD catálogo + inscripciones + calificaciones + faltas + examenes + horas + **crearSesionHorario / actualizarSesionHorario / eliminarSesionHorario**
- **Type `SesionHorario`:** id, asignacionMateriaId, materia, grupo, diaSemana, dia, horaInicio, horaFin, aula, carreraIds

### 5.3 Mapa (`mapa-service/schema.graphql`)
```graphql
enum TipoEspacio { CANCHA, GIMNASIO, SALON, LABORATORIO, AUDITORIO, EDIFICIO, OTRO }
type Espacio @key(fields: "id") { id: ID!, nombre: String!, tipo: TipoEspacio!, edificio: String!, piso: Int!, descripcion: String!, coordenadas: Coordenadas, activo: Boolean! }
extend type Query { espacio(id: ID!): Espacio, espacios(tipo: TipoEspacio, activo: Boolean): [Espacio!]! }
extend type Mutation { crearEspacio(input: CrearEspacioInput!): Espacio!, desactivarEspacio(id: ID!): Espacio!, activarEspacio(id: ID!): Espacio! }
```

### 5.4 Deportes (`deportes-service/schema.graphql`)
Equipos, prácticas, reporte por deporte.

### 5.5 Auditoría (`auditoria-service/schema.graphql`)
```graphql
type LogAuditoria { id: ID!, evento: String!, detalle: String!, fecha: String! }
extend type Query { buscarLogsAuditoria(limite: Int): [LogAuditoria!]! }
```

---

## 6. Variables de Entorno (`.env` por servicio)

### Gateway (`Proyecto/gateway/.env`)
```env
JWT_SECRET=<igual que seguridad>
REDIS_URL=redis://:password123@localhost:6380
SEGURIDAD_URL=http://localhost:4005/
ACADEMICO_URL=http://localhost:4004/
DEPORTES_URL=http://localhost:4001/
MAPA_URL=http://localhost:4002/
AUDITORIA_URL=http://localhost:4003/
PORT_GATEWAY=4000
```

### Seguridad (`Proyecto/node_modules-v2/services/seguridad-service/.env`)
```env
JWT_SECRET=<mismo que gateway>
REDIS_URL=redis://:password123@localhost:6380
MONGODB_URI=mongodb://admin:password123@localhost:27018/seguridad?authSource=admin
NEO4J_URI=neo4j://localhost:7687
NEO4J_USER=neo4j
NEO4J_PASSWORD=password123
RABBITMQ_URL=amqp://guest:guest@localhost:5673
PORT=4005
```

### Académico (`Proyecto/node_modules-v2/services/academico-service/.env`)
```env
INFRASTRUCTURE_MODE=local
REDIS_URL=redis://:password123@localhost:6380
HORARIO_TTL_SECONDS=86400  # 24h
MONGODB_URI=mongodb://admin:password123@localhost:27018/academico?authSource=admin
RABBITMQ_URL=amqp://guest:guest@localhost:5673
JWT_SECRET=<mismo que gateway>
PORT=4004
```

### Mapa (`Proyecto/node_modules-v2/services/mapa-service/.env`)
```env
INFRASTRUCTURE_MODE=local
REDIS_URL=redis://:password123@localhost:6380
REDIS_CACHE_TTL_SECONDS=60
MONGODB_URI=mongodb://admin:password123@localhost:27018/mapa?authSource=admin
RABBITMQ_URL=amqp://guest:guest@localhost:5673
PORT=4002
```

### Deportes (`Proyecto/node_modules-v2/services/deportes-service/.env`)
```env
MONGODB_URI=mongodb://admin:password123@localhost:27018/deportes?authSource=admin
RABBITMQ_URL=amqp://guest:guest@localhost:5673
PORT=4001
```

### Auditoría (`Proyecto/node_modules-v2/services/auditoria-service/.env`)
```env
SCYLLA_HOST=localhost
SCYLLA_PORT=9043
RABBITMQ_URL=amqp://guest:guest@localhost:5673
PORT=4003
```

---

## 7. Tests Automatizados

| Servicio | Archivo | Qué prueba |
|----------|---------|------------|
| Gateway | `gateway/test/authentication.test.js` | `authenticateAuthorizationHeader`, `authenticateActiveSession` (mock sessionStore), `applyAuthenticatedHeaders` |
| Académico | `academico-service/test/horarios-cache.test.js` | Cache-aside: MISS → MongoDB, HIT → Redis, invalidación, lock evita thundering herd |
| Mapa | `mapa-service/test/cache-aside.test.js` | `invalidateByPrefix` con `scanIterator` (batches), degradación Redis caído, eventos RabbitMQ publicados aunque cache falle |

**Ejecutar tests:**
```bash
# Gateway
cd Proyecto/gateway && npm test

# Académico
cd Proyecto/node_modules-v2/services/academico-service && npm test

# Mapa
cd Proyecto/node_modules-v2/services/mapa-service && npm test
```

---

## 8. Comandos Útiles

```bash
# Levantar infraestructura
cd Docker && docker-compose up -d

# Ver contenedores
docker ps | findstr ulsa

# Redis CLI
docker exec -it ulsa-redis-stack redis-cli -a password123
> KEYS session:*
> KEYS horario:*
> KEYS cache:espacio*
> TTL "horario:estudiante:..."
> GET "session:<jti>"

# Logs de caché (buscar en consola de cada servicio)
# Académico: 🔍 MISS, ⚡ HIT, 💾 POPULATED, 🗑️ INVALIDATE, 📦 CACHE
# Mapa: [cache] consulta=... resultado=HIT/MISS/UNAVAILABLE fuente=Redis/MongoDB

# Reiniciar servicio individual
cd Proyecto/node_modules-v2/services/<servicio> && npm start

# Cambiar TTL horarios (academico-service)
# Editar .env: HORARIO_TTL_SECONDS=3600  # 1h
# Reiniciar academico-service
```

---

## 9. Problemas Conocidos / Pendientes

1. **Gateway sin healthcheck** para subgraphs caídos
2. **Lock en memoria** (`_cacheLocks` en academico-service) → no funciona con múltiples réplicas (mover a Redlock en Redis)
3. **Audit service** usa ScyllaDB local; en docker necesita `INFRASTRUCTURE_MODE=docker`
4. **Deportes/Mapa** usan BD `deportes` y `mapa` distintas; no comparten datos con académico
5. **Neo4j** en seguridad-service para grafos de permisos/roles (no usado activamente en horarios)
6. **Rate limiting** no implementado en gateway
7. **Métricas** (hit/miss ratio) no expuestas en `/metrics`

---

## 10. Próximos Pasos Sugeridos

- [ ] Mover lock de horarios a Redis distribuido (Redlock) para multi-instancia
- [ ] Agregar métricas Prometheus (`/metrics`) con hit/miss ratio por servicio
- [ ] Tests de integración completos para invalidación de caché (académico + mapa)
- [ ] Documentar eventos RabbitMQ para auditoría (payloads, versión)
- [ ] Rate limiting en gateway (token bucket en Redis)
- [ ] Health checks en gateway para subgraphs
- [ ] Migración `deportes-service` y `auditoria-service` a la nueva estructura de módulos (como gateway/authentication.js)

---

## 11. Resumen de Redis en el Proyecto

| Uso | Servicio(s) | Clave(s) | TTL | Patrón |
|-----|-------------|----------|-----|--------|
| **Session Store (Lista Blanca JWT)** | Gateway + Seguridad | `session:<jti>` | 3600s (1h) | Write-on-login, Read-on-every-request, Del-on-logout/TTL |
| **Caché Roles** | Seguridad | `cache:roles` | 300s (5min) | Cache-Aside, Invalidación en `crearRol` |
| **Caché Horarios (Estudiante)** | Académico | `horario:estudiante:<alumnoId>:<periodoId>` | 86400s (24h, configurable) | Cache-Aside + Lock Memoria, Invalidación automática en escrituras |
| **Caché Espacios (Mapa)** | Mapa | `cache:espacio:<id>`, `cache:espacios:tipo:*:activo:*` | 60s (configurable) | Cache-Aside + SCAN Invalidation, Degradación graceful |

---

*Generado automáticamente consolidando: `CONTEXTO_PROYECTO.md`, `PRUEBAS_HORARIOS_REDIS.md`, `mapa-service/CACHE_TESTING.md`, código fuente de todos los servicios, `docker-compose.yml` y esquemas GraphQL.*