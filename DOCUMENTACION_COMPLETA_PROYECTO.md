# Documentación Completa del Proyecto UlsaHub (Campus Hub)

> Consolidado: arquitectura, infraestructura, autenticación, **autorización RBAC con Neo4j**, Redis (sesiones + caché horarios + caché mapa), **auditoría asíncrona RabbitMQ → ScyllaDB**, esquemas GraphQL, tests, variables de entorno, batería de pruebas de la defensa y pendientes.
>
> Última actualización: 2026-11-17 (rama `feature/rbac-neo4j-enforcement`).

---

## 1. Arquitectura General

**Patrón:** Microservicios con Apollo Federation (Gateway + Subgraphs)

| Servicio | Puerto | Responsabilidad | DB Principal | Redis |
|----------|--------|-----------------|--------------|-------|
| **gateway** | 4000 | Composition, auth centralizada (JWT + Redis), **RBAC de mutaciones contra Neo4j (403)**, routing | Neo4j (lectura) | **Sesiones** (`session:<jti>`) |
| **seguridad-service** | 4005 | Auth, usuarios, roles, JWT, sesiones, siembra del grafo RBAC, menú dinámico | MongoDB, Neo4j | **Sesiones** (lista blanca) + **Caché roles** (`cache:roles`) |
| **academico-service** | 4004 | Carreras, materias, inscripciones, calificaciones, **horarios** | MongoDB | **Caché horarios** (`horario:estudiante:<alumnoId>:<periodoId>`) |
| **deportes-service** | 4001 | Equipos, prácticas deportivas | MongoDB | — |
| **mapa-service** | 4002 | Espacios físicos (aulas, edificios, coordenadas) | MongoDB | **Caché espacios** (`cache:espacio*`) |
| **auditoria-service** | 4003 | Worker consumidor RabbitMQ + logs inmutables (`worker-auditoria.js`) | ScyllaDB | — |

**Message Broker:** RabbitMQ (eventos de dominio async, ver sección 12)
- Cola: `transmisiones-auditoria` (durable, mensajes `persistent`) + DLQ `transmisiones-auditoria.dlq`
- Eventos reales en el código:
  - Seguridad: `USER_REGISTERED`, `LOGIN_SUCCESS`, `LOGIN_FAILED`, `USUARIO_LOGOUT`, `ROL_CREADO`, `ROLE_CHANGED`
  - Gateway: `ACCESS_DENIED` (mutación bloqueada por RBAC)
  - Académico: `CARRERA_CREADA`, `INSCRIPCION_CREADA`, `CALIFICACION_REGISTRADA`, `FALTA_REGISTRADA`, `EXAMEN_REGISTRADO`, `SESION_HORARIO_CREADA/ACTUALIZADA/ELIMINADA`
  - Deportes: `EQUIPO_REGISTRADO`, `PRACTICA_REGISTRADA`
  - Mapa: `ESPACIO_CREADO`, `ESPACIO_DESACTIVADO`, `ESPACIO_ACTIVADO`

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

**Consolas web (puerto publicado en el host):**
| Herramienta | URL | Credenciales |
|-------------|-----|--------------|
| Neo4j Browser | http://localhost:7475 (conectar a `bolt://localhost:7688`) | neo4j / password123 |
| RabbitMQ Management | http://localhost:15673 | guest / guest |
| Apollo Sandbox (Gateway) | http://localhost:4000 | header `Authorization: Bearer <token>` |
| ScyllaDB (cqlsh) | `docker exec -it ulsa-scylladb cqlsh` | — |

> Los puertos internos estándar (7474, 15672, 9042) están remapeados en `docker-compose.yml` para no chocar con instalaciones locales.

**Red:** `ulsa-network` (bridge)
**Volúmenes persistentes:** `ulsa_mongodb_data`, `ulsa_redis_data`, `ulsa_neo4j_data`, `ulsa_scylla_data`, `ulsa_rabbitmq_data`

---

## 3. Flujo de Autenticación y Autorización (JWT + Redis + Neo4j)

```
1. Login en seguridad-service → JWT (firma HS256) + jti (UUID v4)
2. Sesión guardada en Redis:  session:<jti>  TTL = 3600s (1h)
   Valor: { userId, rol }
3. Gateway valida CADA request:
   a) Verifica firma JWT (JWT_SECRET compartido)
   b) Verifica session:<jti> existe en Redis y coincide userId+rol
   c) Si es MUTACIÓN → pregunta a Neo4j si el usuario puede ejecutarla (sección 3.1)
      - Sin permiso → 403 FORBIDDEN + evento ACCESS_DENIED; nunca llega al subgrafo ni a MongoDB
   d) Si OK → pasa x-user-id, x-user-role a subgraphs vía headers
4. Subgraphs reciben actor: { id, rol } en context (gateway-identity.js)
   y aplican la segunda capa (dueño del recurso, rol mínimo) en domain/authorization.js
```

### 3.1 Autorización RBAC con Neo4j

**Grafo (Neo4j 5.x):**
- Nodos: `(:User {id})`, `(:Role {name, level})`, `(:Route {path, public, tipo})`, `(:MenuNode {id, title, order})`
- Relaciones: `HAS_ROLE`, `INHERITS`, `CAN_ACCESS`, `CAN_VIEW_MENU`, `NAVIGATES_TO`, `HAS_CHILD`
- Restricciones de unicidad: `unique_user_id`, `unique_role_name`, `unique_route_path`, `unique_menu_id`
- Jerarquía: `ADMIN → PROFESOR | ENTRENADOR | COORDINADOR | BECARIO → ESTUDIANTE` (el superior hereda los permisos del inferior)
- **BECARIO = Coordinador de becas** (nivel 2): administra las becas de todos los estudiantes becarios. **No es un alumno con beca.** Registra horas becarias de cualquier estudiante, ve Gestión → Crear evento / QR y, por mínimo privilegio, no consulta calificaciones, inscripciones ni faltas.

**Dónde se siembra:**
- Automático al arrancar `seguridad-service` (`src/infrastructure/neo4j-*.js`, idempotente con `MERGE`). Los usuarios de MongoDB se sincronizan como `(:User)`.
- Manual: `init-rbac.cql` (mismo contenido + usuarios demo `demo-*`).

**Mutaciones como rutas:** cada mutación GraphQL es un `(:Route {path: 'gql:<mutacion>', tipo: 'graphql'})`. El permiso se da al rol más bajo y los superiores lo heredan:

| Rol mínimo | Mutaciones |
|------------|------------|
| Públicas (`public: true`) | `login`, `registrarUsuario`, `logout` |
| ADMIN | `crearRol`, `cambiarRolUsuario`, `crearEspacio`, `activarEspacio`, `desactivarEspacio`, `crearCarrera`, `crearMateria`, `crearPeriodo`, `crearAsignacionMateria`, `crearSesionHorario`, `actualizarSesionHorario`, `eliminarSesionHorario` |
| ENTRENADOR | `registrarEquipo`, `registrarPractica` |
| PROFESOR | `registrarCalificacion`, `registrarFalta`, `registrarExamen` |
| ESTUDIANTE | `inscribirAlumno`, `guardarPerfilAcademico`, `registrarHorasComplementarias` |
| BECARIO (coordinador de becas) | `registrarHorasBecarias` (para cualquier estudiante; ADMIN lo hereda) |

**Consulta que decide el acceso** (`rbac.service.js` → `validarAccesoRuta`, y la misma en `gateway/src/rbac-neo4j.js`):
```cypher
MATCH (u:User {id: $userId})-[:HAS_ROLE]->(r:Role)
MATCH (r)-[:INHERITS*0..]->(effectiveRole:Role)-[:CAN_ACCESS]->(rt:Route {path: $path})
RETURN count(rt) > 0 AS autorizado
```

**Plugin del Gateway (`gateway/src/rbac-neo4j.js`):**
- Hook `didResolveOperation`: corre antes de enviar la operación a los subgrafos.
- Usa el nombre real del campo (ignora alias) y expande fragmentos.
- Respuestas: `401 UNAUTHENTICATED` (sin sesión), `403 FORBIDDEN` (sin permiso o mutación no registrada en el catálogo), `503 SERVICE_UNAVAILABLE` si Neo4j está caído (**fail-closed**).
- Las queries no se revisan contra Neo4j.

**Menú dinámico:** query `menuUsuario` (método `obtenerMenuUsuario`) devuelve solo los `MenuNode` visibles por los roles efectivos del usuario.
- ESTUDIANTE: Inicio, Equipos, Noticias, Partidos, Perfil
- PROFESOR / ENTRENADOR / COORDINADOR / BECARIO / ADMIN: lo anterior + Gestión → Crear evento / QR

> Al agregar una mutación nueva hay que darla de alta en `neo4j-routes.js` y en `init-rbac.cql`; si no, el Gateway la bloquea con 403.

### Gateway - Nuevos módulos (refactor 2024)

- **`authentication.js`**: Lógica pura de validación JWT + verificación sesión activa
  - `authenticateAuthorizationHeader()`: decode + verify firma + valida estructura payload
  - `authenticateActiveSession()`: usa `sessionStore.hasMatchingSession()`
  - `applyAuthenticatedHeaders()`: limpia headers cliente + setea `authorization`, `x-user-id`, `x-user-role`
- **`redis-session-store.js`**: Adapter Redis tolerante a fallos
  - `hasMatchingSession({ jti, actor })`: GET `session:<jti>` + compara `userId` y `rol`
- **`rbac-neo4j.js`**: `createRbacGraph()` (driver Neo4j + `consultarPermiso`), `mutationFieldNames()` y `rbacPlugin()` (bloqueo 401/403/503)
- **`rabbitmq.js`**: productor fail-safe con reconexión cada 5 s; emite `ACCESS_DENIED`

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
type MenuNode { id: ID!, title: String!, order: Int, path: String, children: [MenuNode!]! }
type AuthPayload { token: String!, usuario: Usuario! }
extend type Query {
  verUsuario(id: ID!): Usuario        # el propio usuario o ADMIN
  allUsuarios: [Usuario!]!            # solo ADMIN
  roles: [Rol!]!                      # cualquier usuario con sesión
  validarAccesoRuta(path: String!): Boolean!   # usuario tomado del token
  menuUsuario: [MenuNode!]!                    # usuario tomado del token
}
extend type Mutation {
  # rol opcional: sin rol = ESTUDIANTE; otro rol solo lo puede pedir un ADMIN con sesión
  registrarUsuario(matricula: String!, nombre: String!, email: String!, password: String!, rol: String): Usuario!
  cambiarRolUsuario(userId: ID!, nuevoRol: String!): Usuario!
  login(email: String!, password: String!): AuthPayload!
  logout: Boolean!
  crearRol(nombre: String!): Rol!
}
```

### 5.2 Académico (`academico-service/schema.graphql`)
Ver archivo completo en `Proyecto/services/academico-service/src/schema.graphql`
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
- **Queries:** `verEquipo(id)`, `allEquipos`
- **Mutations:** `registrarEquipo(nombre, deporte, categoria)` (`categoria`: `VARONIL | FEMENIL | MIXTO`), `registrarPractica(equipoId, fecha, horaInicio, horaFin, ubicacionId)`

### 5.5 Auditoría (`auditoria-service/schema.graphql`)
```graphql
type LogTransmision { id: ID!, evento: String!, detalle: String!, fecha: String! }
extend type Query {
  # Solo ADMIN. fecha = 'AAAA-MM-DD' (default hoy UTC); sin tipoEvento consulta todos los del día.
  buscarLogsAuditoria(limite: Int!, tipoEvento: String, fecha: String): [LogTransmision!]!
}
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
# RBAC (si se omiten, se usan estos mismos valores por defecto)
NEO4J_URI=bolt://localhost:7688
NEO4J_USER=neo4j
NEO4J_PASSWORD=password123
# Opcional: eventos ACCESS_DENIED hacia auditoría
RABBITMQ_URL=amqp://guest:guest@localhost:5673
```

### Seguridad (`Proyecto/services/seguridad-service/.env`)
```env
JWT_SECRET=<mismo que gateway>
REDIS_URL=redis://:password123@localhost:6380
MONGODB_URI=mongodb://admin:password123@localhost:27018/seguridad?authSource=admin
NEO4J_URI=bolt://localhost:7688
NEO4J_USER=neo4j
NEO4J_PASSWORD=password123
RABBITMQ_URL=amqp://guest:guest@localhost:5673
PORT=4005
```

### Académico (`Proyecto/services/academico-service/.env`)
```env
INFRASTRUCTURE_MODE=local
REDIS_URL=redis://:password123@localhost:6380
HORARIO_TTL_SECONDS=86400  # 24h
MONGODB_URI=mongodb://admin:password123@localhost:27018/academico?authSource=admin
RABBITMQ_URL=amqp://guest:guest@localhost:5673
JWT_SECRET=<mismo que gateway>
PORT=4004
```

### Mapa (`Proyecto/services/mapa-service/.env`)
```env
INFRASTRUCTURE_MODE=local
REDIS_URL=redis://:password123@localhost:6380
REDIS_CACHE_TTL_SECONDS=60
MONGODB_URI=mongodb://admin:password123@localhost:27018/mapa?authSource=admin
RABBITMQ_URL=amqp://guest:guest@localhost:5673
PORT=4002
```

### Deportes (`Proyecto/services/deportes-service/.env`)
```env
MONGODB_URI=mongodb://admin:password123@localhost:27018/deportes?authSource=admin
RABBITMQ_URL=amqp://guest:guest@localhost:5673
PORT=4001
```

### Auditoría (`Proyecto/services/auditoria-service/.env`)
```env
SCYLLADB_CONTACT_POINTS=127.0.0.1
SCYLLADB_PORT=9043
RABBITMQ_URL=amqp://guest:guest@localhost:5673
JWT_SECRET=<mismo que gateway>
PORT_AUDITORIA=4003
```

---

## 7. Tests Automatizados

| Servicio | Archivo | Qué prueba |
|----------|---------|------------|
| Gateway | `gateway/test/authentication.test.js` | `authenticateAuthorizationHeader`, `authenticateActiveSession` (mock sessionStore), `applyAuthenticatedHeaders` |
| Gateway | `gateway/test/rbac-neo4j.test.js` | Plugin RBAC con Neo4j simulado: permiso heredado, 403, 401, mutación no registrada, Neo4j caído (503), queries libres, alias y fragmentos |
| Académico | `academico-service/test/authentication.test.js` | Identidad desde el Gateway y reglas de autorización por rol |
| Académico | `academico-service/test/horarios-cache.test.js` | Cache-aside: MISS → MongoDB, HIT → Redis, invalidación, lock evita thundering herd |
| Mapa | `mapa-service/test/cache-aside.test.js` | `invalidateByPrefix` con `scanIterator` (batches), degradación Redis caído, eventos RabbitMQ publicados aunque cache falle |

**Ejecutar tests:**
```bash
# Gateway
cd Proyecto/gateway && npm test

# Académico
cd Proyecto/services/academico-service && npm test

# Mapa
cd Proyecto/services/mapa-service && npm test
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

# Neo4j (grafo RBAC)
docker exec -it ulsa-neo4j cypher-shell -u neo4j -p password123
> MATCH p=(:Role)-[:INHERITS|CAN_ACCESS]->() RETURN p;
> MATCH (rt:Route {tipo:'graphql'}) RETURN rt.path, rt.public;

# ScyllaDB (auditoría)
docker exec -it ulsa-scylladb cqlsh
> SELECT * FROM auditoria.logs_eventos;
> SELECT tipo_evento FROM auditoria.tipos_evento_por_dia WHERE fecha_dia='2026-11-17';

# RabbitMQ (mensajes pendientes / sin ack / consumidores)
docker exec ulsa-rabbitmq rabbitmqctl list_queues name messages_ready messages_unacknowledged consumers

# Orden de arranque recomendado
# 1) docker compose up -d  2) esperar a que cqlsh responda (ScyllaDB tarda)
# 3) seguridad (siembra Neo4j) → academico, deportes, mapa, auditoria  4) gateway al final

# Reiniciar servicio individual
cd Proyecto/services/<servicio> && npm start

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
5. **Neo4j** decide el acceso a todas las mutaciones desde el Gateway; los subgrafos conservan una segunda capa en `domain/authorization.js` (debe mantenerse alineada con el grafo)
6. **Rate limiting** no implementado en gateway
7. **Métricas** (hit/miss ratio) no expuestas en `/metrics`
8. ~~**`registrarUsuario` es pública y acepta cualquier rol**~~ ✅ Corregido: sin `rol` queda `ESTUDIANTE`; pedir otro rol exige un ADMIN con sesión (y el intento se audita como `ASIGNACION_ROL_PERMISO` denegado). `allUsuarios`/`verUsuario`/`roles` ya piden sesión.
9. **Gateway usa `IntrospectAndCompose`**: si se reinicia con un subgrafo caído, no arranca
10. **auditoria-service**: si ScyllaDB no responde al arrancar, el worker no se inicia (hay que reiniciar el servicio cuando Scylla esté lista)
11. La tabla vieja `auditoria.logs_auditoria` sigue existiendo pero ya no se usa (se puede borrar con `DROP TABLE`)

---

## 10. Próximos Pasos Sugeridos

- [ ] Mover lock de horarios a Redis distribuido (Redlock) para multi-instancia
- [ ] Agregar métricas Prometheus (`/metrics`) con hit/miss ratio por servicio
- [ ] Tests de integración completos para invalidación de caché (académico + mapa)
- [x] Documentar eventos RabbitMQ para auditoría (payloads) → sección 12
- [ ] Versionar el formato de los eventos (`{ event, payload }`)
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

## 12. Auditoría Asíncrona (RabbitMQ → ScyllaDB)

### 12.1 Productores (fail-safe)
| Servicio | Archivo | Comportamiento si RabbitMQ cae |
|----------|---------|-------------------------------|
| Gateway | `gateway/src/rabbitmq.js` | Omite el evento y reintenta conectar cada 5 s |
| Seguridad | `seguridad-service/src/infrastructure/rabbitmq.js` | Omite el evento y reintenta conectar cada 5 s |
| Académico / Deportes / Mapa | `*/src/infrastructure/rabbitmq-event-publisher.js` | Escuchan `error`/`close` (ya no tumban el proceso), `channel = null`, `try/catch` en el envío y reconexión cada 5 s |

- Cola `durable: true` y mensajes `persistent: true`.
- Formato: `{ event, payload }`; el payload incluye `fecha`, `timestamp` y `fecha_dia`.
- **CWE-532:** nunca viajan password, `passwordHash` ni el JWT; solo identificadores opacos (`usuario_id`, `jti`), rol, IP y la operación.

### 12.2 Worker consumidor (`auditoria-service/src/worker-auditoria.js`)
- `channel.prefetch(50)` → contrapresión: máximo 50 mensajes sin confirmar en memoria.
- Consultas con `{ prepare: true }` → binario y sin inyección CQL.
- `ack` manual solo después de que ScyllaDB confirma la escritura; si falla: hasta 3 reintentos y luego DLQ (`transmisiones-auditoria.dlq`).
- La hora del log es la del evento (la manda el productor), no la del procesamiento.

### 12.3 Modelo en ScyllaDB (Query-First)
Pregunta forense: *"¿qué eventos de tipo X ocurrieron el día D, del más reciente al más antiguo?"*

```sql
CREATE TABLE auditoria.logs_eventos (
  fecha_dia   text,        -- 'AAAA-MM-DD' (UTC)
  tipo_evento text,
  timestamp   timestamp,
  evento_id   timeuuid,
  usuario_id  text,
  ip_origen   text,
  severidad   text,
  detalle     text,        -- payload JSON completo
  PRIMARY KEY ((fecha_dia, tipo_evento), timestamp, evento_id)
) WITH CLUSTERING ORDER BY (timestamp DESC, evento_id DESC)
  AND default_time_to_live = 31536000;   -- 12 meses

-- Tabla de apoyo: qué tipos hubo cada día (para consultar sin SELECT sin WHERE)
CREATE TABLE auditoria.tipos_evento_por_dia (
  fecha_dia text, tipo_evento text,
  PRIMARY KEY (fecha_dia, tipo_evento)
) WITH default_time_to_live = 31536000;
```
- Partición compuesta: un ataque masivo de un tipo (p. ej. `LOGIN_FAILED`) no crece la partición de los demás.
- `timeuuid` evita colisiones aunque dos eventos caigan en el mismo milisegundo.
- El worker escribe ambas tablas en un `batch` con `prepare: true`.

```sql
-- Consulta típica (orden cronológico descendente físico)
SELECT * FROM auditoria.logs_eventos
WHERE fecha_dia = '2026-11-17' AND tipo_evento = 'LOGIN_SUCCESS';
```

---

## 13. Batería de Pruebas para la Defensa (verificada el 2026-11-17)

Ejecutada contra Docker local con todos los servicios levantados; los datos de prueba se borraron al final.

| # | Escenario | Cómo se demuestra | Resultado obtenido |
|---|-----------|-------------------|--------------------|
| 1 | Grafo en Neo4j Browser | http://localhost:7475 → `MATCH p=(:Role)-[:INHERITS\|CAN_ACCESS]->() RETURN p;` | ✅ 24 rutas `gql:` (3 públicas, 21 con permiso); camino `ADMIN → ENTRENADOR → gql:registrarEquipo` |
| 2 | 403 vs. éxito | Sandbox: `registrarEquipo(nombre:"X", deporte:"Futbol", categoria:"MIXTO")` con ESTUDIANTE y luego con ADMIN | ✅ ESTUDIANTE → HTTP 403 `FORBIDDEN` (nada en MongoDB); ADMIN → 200 por herencia; sin token → 401; con alias → 403 |
| 3 | Menú dinámico | `{ menuUsuario { id title children { title } } }` | ✅ ESTUDIANTE: 5 nodos; ADMIN: además Gestión → Crear evento / QR |
| 4 | Tránsito en RabbitMQ UI | Detener `auditoria-service`, hacer login, ver *Ready* y *Get messages* (Nack requeue) en http://localhost:15673 | ✅ Ready = 1, `delivery_mode = 2` (persistente), payload sin password/hash/JWT |
| 5 | Persistencia en ScyllaDB | `SELECT * FROM auditoria.logs_eventos;` + `rabbitmqctl list_queues` | ✅ Eventos en orden DESC, TTL 12 meses; cola en 0 ready / 0 unacked al reanudar el worker |
| 6 | Fail-Safe | `docker stop ulsa-rabbitmq` en vivo | ✅ Los 6 procesos siguen arriba; login, `allEquipos`, `espacios`, `registrarEquipo`, 403 y logout responden; con `docker start` los 6 se reconectan solos |

**Tips para la demo:**
- Usar `categoria: MIXTO | VARONIL | FEMENIL` en `registrarEquipo` (otro valor da error de validación de Mongoose, no de permisos).
- Para ver mensajes encolados en la UI hay que detener antes el worker; con el worker activo la cola se vacía al instante.
- No reiniciar el Gateway mientras algún subgrafo esté caído.

---

*Generado automáticamente consolidando: `CONTEXTO_PROYECTO.md`, `PRUEBAS_HORARIOS_REDIS.md`, `mapa-service/CACHE_TESTING.md`, código fuente de todos los servicios, `docker-compose.yml` y esquemas GraphQL.*