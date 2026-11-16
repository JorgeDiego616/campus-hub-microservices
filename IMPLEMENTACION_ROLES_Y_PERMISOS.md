# UlsaHub — Implementación de Roles, Jerarquía y Permisos

Este documento explica cómo quedó implementado el modelo de **roles jerárquicos**, la **herencia transitiva** y la **autorización por servicio** en UlsaHub.

---

## 1. Resumen

El proyecto es una arquitectura de **microservicios con Apollo Federation**:

- Un **Gateway** centraliza la autenticación (JWT + sesión en Redis).
- Cinco **subgrafos** exponen operaciones GraphQL.
- **Neo4j** modela el DAG RBAC: usuarios, roles, rutas y menú dinámico.
- **MongoDB** guarda usuarios y el catálogo de roles.
- **Redis** guarda sesiones y cachés.
- **RabbitMQ** transporta eventos de auditoría.
- **ScyllaDB** almacena los logs inmutables.

La autorización se aplica en dos capas:

1. **Gateway:** valida que el JWT sea válido y que la sesión siga activa en Redis.
2. **Subgrafos:** vuelven a verificar la firma del JWT, construyen el `actor` y aplican las reglas de rol antes de ejecutar.

---

## 2. Servicios y puertos

| Servicio | Puerto | Responsabilidad |
|---|---|---|
| gateway | 4000 | Composición GraphQL, validación JWT + Redis, routing |
| seguridad-service | 4005 | Usuarios, roles, login/logout, sesiones |
| academico-service | 4004 | Catálogo académico, inscripciones, calificaciones, horarios |
| deportes-service | 4001 | Equipos y prácticas deportivas |
| mapa-service | 4002 | Espacios físicos (aulas, canchas, edificios) |
| auditoria-service | 4003 | Logs inmutables desde RabbitMQ/ScyllaDB |

---

## 3. Catálogo de roles

Se definen **seis roles**:

| Rol | Nivel | Descripción |
|---|---|---|
| `ADMIN` | 1 | Administrador del campus |
| `PROFESOR` | 2 | Docente |
| `ENTRENADOR` | 2 | Entrenador deportivo |
| `COORDINADOR` | 2 | Coordinador de actividades |
| `BECARIO` | 3 | Alumno con beca |
| `ESTUDIANTE` | 3 | Alumno regular |

Los roles se siembran automáticamente en MongoDB y en Neo4j al arrancar `seguridad-service` (`ROLES_POR_DEFECTO` en `src/domain/entities.js` y `seedRoleHierarchy`).

---

## 4. Jerarquía y herencia

La herencia es **transitiva**: un rol hereda los permisos de sus ancestros.

### Relaciones directas

```
ADMIN ──INHERITS──► PROFESOR
ADMIN ──INHERITS──► ENTRENADOR
PROFESOR ──INHERITS──► ESTUDIANTE
ENTRENADOR ──INHERITS──► ESTUDIANTE
COORDINADOR ──INHERITS──► ESTUDIANTE
BECARIO ──INHERITS──► ESTUDIANTE
```

### Cierre transitivo

| Rol | Hereda |
|---|---|
| `ADMIN` | `PROFESOR`, `ENTRENADOR`, `ESTUDIANTE` |
| `PROFESOR` | `ESTUDIANTE` |
| `ENTRENADOR` | `ESTUDIANTE` |
| `COORDINADOR` | `ESTUDIANTE` |
| `BECARIO` | `ESTUDIANTE` |
| `ESTUDIANTE` | — |

### Reglas

- Dirección: `rol_hijo -[:INHERITS]-> rol_padre`.
- Unidireccional: el padre **no** hereda del hijo.
- Acíclica: no se permiten ciclos.
- El usuario conserva su rol propio; su **conjunto efectivo** incluye los ancestros.

---

## 5. Modelo RBAC en Neo4j

Contenedor: `ulsa-neo4j` · Browser: `http://localhost:7475` · Bolt: `localhost:7688` · Credenciales: `neo4j / password123`.

El modelo es un **DAG** con 4 etiquetas y 6 relaciones semánticas:

```
(:User {id}) -[:HAS_ROLE]-> (:Role {name})
(:Role) -[:INHERITS]-> (:Role)
(:Role) -[:CAN_ACCESS]-> (:Route {path})
(:Role) -[:CAN_VIEW_MENU]-> (:MenuNode {id, title, order})
(:MenuNode) -[:HAS_CHILD]-> (:MenuNode)
(:MenuNode) -[:NAVIGATES_TO]-> (:Route)
```

### 5.1 Restricciones de unicidad

```cypher
CREATE CONSTRAINT unique_user_id IF NOT EXISTS FOR (u:User) REQUIRE u.id IS UNIQUE;
CREATE CONSTRAINT unique_role_name IF NOT EXISTS FOR (r:Role) REQUIRE r.name IS UNIQUE;
CREATE CONSTRAINT unique_route_path IF NOT EXISTS FOR (rt:Route) REQUIRE rt.path IS UNIQUE;
CREATE CONSTRAINT unique_menu_id IF NOT EXISTS FOR (m:MenuNode) REQUIRE m.id IS UNIQUE;
```

### 5.2 Roles

```cypher
UNWIND [
  {name: 'ADMIN', level: 1, description: 'Administrador del campus'},
  {name: 'PROFESOR', level: 2, description: 'Docente'},
  {name: 'ENTRENADOR', level: 2, description: 'Entrenador deportivo'},
  {name: 'COORDINADOR', level: 2, description: 'Coordinador de actividades'},
  {name: 'BECARIO', level: 3, description: 'Alumno con beca'},
  {name: 'ESTUDIANTE', level: 3, description: 'Alumno regular'}
] AS role
MERGE (r:Role {name: role.name})
SET r.level = role.level, r.description = role.description;
```

### 5.3 Jerarquía `INHERITS`

La dirección es `(rolSuperior)-[:INHERITS]->(rolInferior)` y se siembra con `MATCH` + `MERGE`:

```cypher
UNWIND [
  {superior: 'ADMIN', inferior: 'PROFESOR'},
  {superior: 'ADMIN', inferior: 'ENTRENADOR'},
  {superior: 'PROFESOR', inferior: 'ESTUDIANTE'},
  {superior: 'ENTRENADOR', inferior: 'ESTUDIANTE'},
  {superior: 'COORDINADOR', inferior: 'ESTUDIANTE'},
  {superior: 'BECARIO', inferior: 'ESTUDIANTE'}
] AS link
MATCH (superior:Role {name: link.superior})
MATCH (inferior:Role {name: link.inferior})
MERGE (superior)-[:INHERITS]->(inferior);
```

### 5.4 Rutas y `CAN_ACCESS`

Se registran las 16 rutas reales de la app (incluye `tabs`, el contenedor de pestañas) y el acceso se asigna **solo al rol más bajo autorizado**:

- `ESTUDIANTE` recibe las rutas base: home, equipos, noticias, partidos, perfil, API, detalles, registro de evento y `tabs`.
- `PROFESOR`, `ENTRENADOR` y `COORDINADOR` reciben `qr_screen` por separado, porque son hermanos y no se heredan entre sí.
- `ADMIN`, `BECARIO` y los demás roles obtienen el acceso por transitividad.
- `onboarding`, `login` y `register` se marcan `public: true` y no llevan `CAN_ACCESS`.

```cypher
UNWIND [
  {path: 'tabs', title: 'Pestañas', public: false},
  {path: 'home_home', title: 'Inicio', public: false},
  {path: 'qr_screen', title: 'Crear evento / QR', public: false}
  // ... listado completo en init-rbac.cql
] AS route
MERGE (rt:Route {path: route.path})
SET rt.title = route.title, rt.public = route.public;

UNWIND [
  {role: 'ESTUDIANTE', path: 'home_home'},
  {role: 'ESTUDIANTE', path: 'tabs'},
  {role: 'ENTRENADOR', path: 'qr_screen'},
  {role: 'PROFESOR', path: 'qr_screen'},
  {role: 'COORDINADOR', path: 'qr_screen'}
  // ... listado completo en init-rbac.cql
] AS access
MATCH (r:Role {name: access.role})
MATCH (rt:Route {path: access.path})
MERGE (r)-[:CAN_ACCESS]->(rt);
```

### 5.5 Árbol de menú

`MenuNode` guarda `id`, `title` y `order`. La jerarquía visual se modela con `HAS_CHILD`, el clic con `NAVIGATES_TO` y la visibilidad con `CAN_VIEW_MENU`. El menú queda **desacoplado** de las rutas.

```cypher
UNWIND [
  {id: 'root', title: 'Menú principal', order: 0},
  {id: 'teams', title: 'Equipos', order: 1},
  {id: 'home', title: 'Inicio', order: 2},
  {id: 'news', title: 'Noticias', order: 3},
  {id: 'matches', title: 'Partidos', order: 4},
  {id: 'management', title: 'Gestión', order: 5},
  {id: 'qr', title: 'Crear evento / QR', order: 1},
  {id: 'profile', title: 'Perfil', order: 6}
] AS menu
MERGE (m:MenuNode {id: menu.id})
SET m.title = menu.title, m.order = menu.order;
```

Relaciones del menú:

```cypher
UNWIND [
  {parent: 'root', child: 'teams'},
  {parent: 'root', child: 'management'},
  {parent: 'management', child: 'qr'}
  // ... listado completo en init-rbac.cql
] AS link
MATCH (parent:MenuNode {id: link.parent})
MATCH (child:MenuNode {id: link.child})
MERGE (parent)-[:HAS_CHILD]->(child);

UNWIND [
  {menu: 'teams', path: 'team_section'},
  {menu: 'qr', path: 'qr_screen'}
  // ... listado completo en init-rbac.cql
] AS nav
MATCH (m:MenuNode {id: nav.menu})
MATCH (rt:Route {path: nav.path})
MERGE (m)-[:NAVIGATES_TO]->(rt);

UNWIND [
  {role: 'ESTUDIANTE', menu: 'root'},
  {role: 'PROFESOR', menu: 'management'},
  {role: 'ENTRENADOR', menu: 'qr'},
  {role: 'COORDINADOR', menu: 'management'},
  {role: 'COORDINADOR', menu: 'qr'}
  // ... listado completo en init-rbac.cql
] AS view
MATCH (r:Role {name: view.role})
MATCH (m:MenuNode {id: view.menu})
MERGE (r)-[:CAN_VIEW_MENU]->(m);
```

### 5.6 Usuarios y `HAS_ROLE`

Los usuarios viven en MongoDB; Neo4j solo guarda la proyección `(:User {id, role})` y su `HAS_ROLE`. La sincronización se hace al arrancar (`syncUsersToGraph`) y al registrar un usuario (`upsertUserGraph`). El script `init-rbac.cql` incluye además 6 usuarios demo (`demo-admin`, `demo-profesor`, `demo-coordinador`, etc.) marcados con `demo: true` para probar sin MongoDB.

```cypher
MATCH (u:User {id: $userId})-[old:HAS_ROLE]->(:Role)
DELETE old;

MERGE (u:User {id: $userId})
SET u.role = $role
MERGE (r:Role {name: $role})
MERGE (u)-[:HAS_ROLE]->(r);
```

### 5.7 Script `init-rbac.cql`

El script idempotente está en la raíz del repositorio y consolida constraints, roles, herencia, rutas, accesos, menú y usuarios demo:

```bash
docker cp init-rbac.cql ulsa-neo4j:/tmp/init-rbac.cql
docker exec ulsa-neo4j cypher-shell -u neo4j -p password123 -f /tmp/init-rbac.cql
```

También se siembra automáticamente al arrancar `seguridad-service` mediante los seeds JS (`ensureRbacConstraints`, `seedRoleHierarchy`, `seedRoutesAndAccess`, `seedMenuTree`, `syncUsersToGraph`).

### 5.8 Consultas de verificación

```cypher
// Conteos
MATCH (rt:Route) RETURN count(rt) AS rutas;
MATCH ()-[r:CAN_ACCESS]->() RETURN count(r) AS accesos;
MATCH (m:MenuNode) RETURN count(m) AS menus;

// Ciclos (debe ser 0)
MATCH path=(r:Role)-[:INHERITS*1..]->(r) RETURN count(path) AS ciclos;

// Rutas efectivas por rol
MATCH (r:Role)
OPTIONAL MATCH (r)-[:INHERITS*0..]->(:Role)-[:CAN_ACCESS]->(rt:Route)
RETURN r.name AS rol, count(DISTINCT rt) AS rutas
ORDER BY rol;

// Menús efectivos por rol
MATCH (r:Role)
OPTIONAL MATCH (r)-[:INHERITS*0..]->(:Role)-[:CAN_VIEW_MENU]->(m:MenuNode)
RETURN r.name AS rol, collect(DISTINCT m.id) AS menus
ORDER BY rol;
```

Resultados esperados: `Role = 6`, `Route = 16`, `CAN_ACCESS = 15`, `MenuNode = 8`, `HAS_CHILD = 7`, `NAVIGATES_TO = 6`, `CAN_VIEW_MENU = 12`, `INHERITS = 6`, `0` ciclos. Rutas efectivas: `13` para `ADMIN/PROFESOR/ENTRENADOR/COORDINADOR` y `12` para `BECARIO/ESTUDIANTE`. Menús efectivos: `8` y `6` respectivamente.

### 5.9 `rbac.service.js` y GraphQL

`seguridad-service/src/application/rbac.service.js` implementa las dos consultas declarativas:

- `validarAccesoRuta(userId, path)`: recorre `[:INHERITS*0..]` y `CAN_ACCESS` con sesión `READ`.
- `obtenerMenuUsuario(userId)`: obtiene los `MenuNode` visibles por rol, sus `parentIds` y rutas, y arma el árbol recursivo en JS. La visibilidad se evalúa **por nodo**, por lo que un submenú puede ser visible para un rol superior aunque la raíz se comparta con `ESTUDIANTE`.

GraphQL expone:

```graphql
query Menu($path: String!) {
  menuUsuario {
    id
    title
    order
    path
    children { id title order path children { id title order path } }
  }
  validarAccesoRuta(path: $path)
}
```

Ejemplo con `ESTUDIANTE` y `path: "qr_screen"`: devuelve solo los 5 tabs base y `validarAccesoRuta = false`. Con `ENTRENADOR` devuelve además `management` y `qr` anidado, y `validarAccesoRuta = true`.

---

## 6. Flujo de identidad

```
1. Login (seguridad-service)
   → genera jti
   → firma JWT HS256: { id, rol, jti } con expiración de 1h
   → guarda session:<jti> en Redis con { userId, rol } y TTL 3600s

2. Gateway (cada request)
   → authentication.js: verifica firma y estructura del JWT
   → redis-session-store.js: comprueba que session:<jti> exista y coincida
   → applyAuthenticatedHeaders: limpia headers del cliente y setea
        authorization: Bearer <token>
        x-user-id: <id>
        x-user-role: <rol>

3. Subgrafo (mapa, deportes, auditoría)
   → gateway-identity.js: lee headers, re-verifica la firma JWT
     y comprueba que id/rol del token coincidan con los headers
   → context: actor = { id, rol } o null

4. Resolver
   → llama a la función de autorización correspondiente
   → si no tiene permiso, lanza UNAUTHENTICATED (401) o FORBIDDEN (403)
   → si tiene permiso, ejecuta el caso de uso
```

### Archivos involucrados

| Archivo | Función |
|---|---|
| `gateway/src/authentication.js` | Verificación de firma, validación de sesión, inyección de headers |
| `gateway/src/redis-session-store.js` | Lectura y comparación de `session:<jti>` |
| `gateway/src/index.js` | Contexto del gateway y `willSendRequest` |
| `<servicio>/src/infrastructure/gateway-identity.js` | Re-verificación del JWT en el subgrafo |
| `<servicio>/src/infrastructure/runtime-config.js` | Lectura y validación de `JWT_SECRET` |

---

## 7. Capa de autorización por servicio

Cada uno de los tres servicios tiene `src/domain/authorization.js`, con la misma base común:

```js
export const Roles = Object.freeze({
  ADMIN: 'ADMIN',
  PROFESOR: 'PROFESOR',
  ENTRENADOR: 'ENTRENADOR',
  BECARIO: 'BECARIO',
  ESTUDIANTE: 'ESTUDIANTE'
});

const ROLE_INHERITANCE = Object.freeze({
  ADMIN: ['PROFESOR', 'ENTRENADOR'],
  PROFESOR: ['ESTUDIANTE'],
  ENTRENADOR: ['ESTUDIANTE'],
  BECARIO: ['ESTUDIANTE'],
  ESTUDIANTE: []
});

export function effectiveRoles(actor) { /* cierre transitivo */ }
export function requireActor(actor) { /* 401 si no hay actor */ }
export function assertAnyRole(actor, permitidos) { /* 403 si no está */ }
```

### Reglas propias

| Servicio | Función | Roles permitidos |
|---|---|---|
| Mapa | `assertCanReadSpaces` | Cualquier autenticado |
| Mapa | `assertCanManageSpaces` | `ADMIN` |
| Deportes | `assertCanReadSports` | Cualquier autenticado |
| Deportes | `assertCanManageSports` | `ADMIN`, `ENTRENADOR` |
| Auditoría | `assertCanViewAudit` | `ADMIN` |

`effectiveRoles` usa `actor.roles` si viene como arreglo; si no, expande `actor.rol` con el mapa de herencia. Así el cambio futuro a roles efectivos desde la sesión no requiere tocar los resolvers.

---

## 8. Matriz de permisos por operación

### Mapa

| Operación | Tipo | Roles |
|---|---|---|
| `espacio` | Query | Autenticado |
| `espacios` | Query | Autenticado |
| `crearEspacio` | Mutation | `ADMIN` |
| `desactivarEspacio` | Mutation | `ADMIN` |
| `activarEspacio` | Mutation | `ADMIN` |

### Deportes

| Operación | Tipo | Roles |
|---|---|---|
| `verEquipo` | Query | Autenticado |
| `allEquipos` | Query | Autenticado |
| `reportePracticasPorDeporte` | Query | Autenticado |
| `registrarEquipo` | Mutation | `ADMIN`, `ENTRENADOR` |
| `registrarPractica` | Mutation | `ADMIN`, `ENTRENADOR` |

### Auditoría

| Operación | Tipo | Roles |
|---|---|---|
| `buscarLogsAuditoria` | Query | `ADMIN` |

> El consumidor de RabbitMQ de Auditoría **no** pasa por autorización: es un proceso interno que escribe eventos, no una operación de usuario.

### `__resolveReference`

Las funciones de referencia de federación (`__resolveReference`) **no** llevan verificación de rol, porque las invoca el Gateway internamente al resolver entidades. La autorización ya se aplicó en la operación de nivel superior.

---

## 9. Errores de autorización

| Situación | Código GraphQL | HTTP |
|---|---|---|
| Sin token / token inválido / sin sesión | `UNAUTHENTICATED` | 401 |
| Autenticado pero sin el rol requerido | `FORBIDDEN` | 403 |

---

## 10. Archivos creados y modificados

### Creados

| Archivo | Descripción |
|---|---|
| `mapa-service/src/domain/authorization.js` | Reglas de Mapa |
| `deportes-service/src/domain/authorization.js` | Reglas de Deportes |
| `auditoria-service/src/domain/authorization.js` | Reglas de Auditoría |
| `mapa-service/src/infrastructure/gateway-identity.js` | Identidad desde el Gateway |
| `deportes-service/src/infrastructure/gateway-identity.js` | Identidad desde el Gateway |
| `auditoria-service/src/infrastructure/gateway-identity.js` | Identidad desde el Gateway |
| `init-rbac.cql` | Script idempotente del modelo RBAC (constraints, roles, rutas, menú y usuarios demo) |
| `seguridad-service/src/infrastructure/database.js` | Driver singleton de Neo4j |
| `seguridad-service/src/infrastructure/neo4j-constraints.js` | Las 4 constraints de unicidad |
| `seguridad-service/src/infrastructure/neo4j-role-hierarchy.js` | Roles e `INHERITS` |
| `seguridad-service/src/infrastructure/neo4j-routes.js` | Rutas y `CAN_ACCESS` |
| `seguridad-service/src/infrastructure/neo4j-menu.js` | Menú, `HAS_CHILD`, `NAVIGATES_TO` y `CAN_VIEW_MENU` |
| `seguridad-service/src/infrastructure/neo4j-users.js` | Sincronización de `User` y `HAS_ROLE` |
| `seguridad-service/src/application/rbac.service.js` | Consultas RBAC de rutas y menú |

### Modificados

| Archivo | Cambio |
|---|---|
| `mapa-service/src/index.js` | Contexto con `actor` + verificaciones en resolvers |
| `deportes-service/src/index.js` | Contexto con `actor` + verificaciones en resolvers |
| `auditoria-service/src/index.js` | Contexto con `actor` + verificación en query |
| `*/src/infrastructure/runtime-config.js` | `jwtSecret` obligatorio y exportado |
| `*/package.json` y `package-lock.json` | Dependencia `jsonwebtoken` |
| `*/.env.example` | Variables `JWT_SECRET` y Neo4j documentadas |
| `seguridad-service/src/schema.graphql` | Tipo `MenuNode` y queries `menuUsuario` / `validarAccesoRuta` |
| `seguridad-service/src/index.js` | Driver singleton, seeds RBAC, sincronización de usuarios y resolvers de menú/acceso |

---

## 11. Pruebas realizadas

Se verificó la lógica de autorización sin base de datos (funciones puras):

- **23/23** pruebas de `effectiveRoles`, `requireActor` y `assertAnyRole` pasan.
- **12/12** archivos pasan `node --check`.

Casos cubiertos:

| Caso | Resultado esperado |
|---|---|
| Sin actor | `UNAUTHENTICATED` |
| `ESTUDIANTE` en mutación de Mapa | `FORBIDDEN` |
| `ADMIN` en mutación de Mapa | Permitido |
| `ENTRENADOR` en mutación de Deportes | Permitido |
| `ESTUDIANTE` en mutación de Deportes | `FORBIDDEN` |
| `ESTUDIANTE`/`ENTRENADOR` en Auditoría | `FORBIDDEN` |
| `ADMIN` en Auditoría | Permitido |
| Llamada directa al subgrafo con headers falsos | `UNAUTHENTICATED` |

### RBAC en Neo4j

- `init-rbac.cql` ejecutado dos veces sin duplicados (idempotente).
- Conteos: `Role = 6`, `Route = 16`, `CAN_ACCESS = 15`, `MenuNode = 8`, `HAS_CHILD = 7`, `NAVIGATES_TO = 6`, `CAN_VIEW_MENU = 12`, `INHERITS = 6`, `User = 18` (12 reales + 6 demo), `HAS_ROLE = 18`.
- Ciclos en `INHERITS`: `0`.
- Rutas efectivas: `13` para `ADMIN/PROFESOR/ENTRENADOR/COORDINADOR` y `12` para `BECARIO/ESTUDIANTE`.
- Menús efectivos: `8` para `ADMIN/PROFESOR/ENTRENADOR/COORDINADOR` y `6` para `BECARIO/ESTUDIANTE`; `qr` aparece anidado bajo `management` solo en los roles altos.
- GraphQL E2E: `demo-estudiante` no ve `management`/`qr` y `qr_screen = false`; `demo-entrenador`, `demo-profesor`, `demo-coordinador` y `demo-admin` ven `management` con `qr` anidado y `qr_screen = true`.
- `node --check` en los módulos nuevos (`database.js`, `neo4j-users.js`, `rbac.service.js`, `index.js`).
- Android: `:app:compileDebugKotlin` con `BUILD SUCCESSFUL`; menú dinámico conectado a `menuUsuario` (pestañas filtradas y botón de QR oculto sin acceso).

Los pasos de prueba end-to-end están en `GUIA_CLONADO_Y_CONFIGURACION.md` (sección de pruebas).

---

## 12. Limitaciones y pendientes

1. **Jerarquía duplicada en código:** `ROLE_INHERITANCE` es un espejo del grafo de Neo4j. Cuando el login calcule los roles efectivos y los guarde en la sesión, la constante dejará de usarse.
2. **JWT con un solo rol:** actualmente el token lleva `{ id, rol, jti }`. Para aprovechar la herencia desde Neo4j, falta que el login resuelva el cierre transitivo y lo propague.
3. **Acceso directo a subgrafos:** los subgrafos verifican la firma JWT, pero no consultan Redis. El Gateway sí bloquea tokens con sesión cerrada; una llamada directa al puerto con un JWT aún vigente pasaría.
4. **Doble vía de siembra:** el arranque usa seeds JS y también existe `init-rbac.cql`; hay que mantener ambos sincronizados (hoy ambos incluyen los 6 roles).
5. **`ENTRENADOR`:** ya tiene permisos reales en Deportes; en Académico sigue sin reglas propias.
6. **Caché de roles efectivos:** conviene cachear el cierre transitivo en Redis e invalidarlo al crear roles o relaciones.
7. **Menú dinámico en Android (resuelto):** la app consume `menuUsuario`, filtra las pestañas y oculta el botón de QR cuando el rol no tiene `qr_screen`.
8. **Consulta de menú adaptada:** `obtenerMenuUsuario` no es idéntica al snippet original; evalúa visibilidad por nodo y arma el árbol en JS para soportar submenús.
9. **Federación:** `menuUsuario` y `validarAccesoRuta` se prueban a través del Gateway con los usuarios de MongoDB.
10. **Roles personalizados:** `COORDINADOR` ya es parte del catálogo por defecto; `crearRol` sigue creando roles personalizados solo en MongoDB y en Neo4j se crean sin nivel ni herencia al sincronizar un usuario.
11. **Usuarios huérfanos:** el sync no elimina nodos `User` cuando se borra el usuario en MongoDB.
