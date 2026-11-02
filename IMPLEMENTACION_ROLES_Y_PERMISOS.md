# UlsaHub — Implementación de Roles, Jerarquía y Permisos

Este documento explica cómo quedó implementado el modelo de **roles jerárquicos**, la **herencia transitiva** y la **autorización por servicio** en UlsaHub.

---

## 1. Resumen

El proyecto es una arquitectura de **microservicios con Apollo Federation**:

- Un **Gateway** centraliza la autenticación (JWT + sesión en Redis).
- Cinco **subgrafos** exponen operaciones GraphQL.
- **Neo4j** modela la jerarquía de roles.
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

Se definen **cinco roles propios del dominio**:

| Rol | Nivel | Descripción |
|---|---|---|
| `ADMIN` | 1 | Administrador del campus |
| `PROFESOR` | 2 | Docente |
| `ENTRENADOR` | 2 | Entrenador deportivo |
| `BECARIO` | 3 | Alumno con beca |
| `ESTUDIANTE` | 3 | Alumno regular |

Los roles se siembran automáticamente en MongoDB al arrancar `seguridad-service` (`ROLES_POR_DEFECTO` en `src/domain/entities.js`).

---

## 4. Jerarquía y herencia

La herencia es **transitiva**: un rol hereda los permisos de sus ancestros.

### Relaciones directas

```
ADMIN ──INHERITS──► PROFESOR
ADMIN ──INHERITS──► ENTRENADOR
PROFESOR ──INHERITS──► ESTUDIANTE
ENTRENADOR ──INHERITS──► ESTUDIANTE
BECARIO ──INHERITS──► ESTUDIANTE
```

### Cierre transitivo

| Rol | Hereda |
|---|---|
| `ADMIN` | `PROFESOR`, `ENTRENADOR`, `ESTUDIANTE` |
| `PROFESOR` | `ESTUDIANTE` |
| `ENTRENADOR` | `ESTUDIANTE` |
| `BECARIO` | `ESTUDIANTE` |
| `ESTUDIANTE` | — |

### Reglas

- Dirección: `rol_hijo -[:INHERITS]-> rol_padre`.
- Unidireccional: el padre **no** hereda del hijo.
- Acíclica: no se permiten ciclos.
- El usuario conserva su rol propio; su **conjunto efectivo** incluye los ancestros.

---

## 5. Modelo en Neo4j

Contenedor: `ulsa-neo4j` · Browser: `http://localhost:7475` · Bolt: `localhost:7688` · Credenciales: `neo4j / password123`.

### 5.1 Restricción de unicidad

```cypher
CREATE CONSTRAINT role_nombre_unique IF NOT EXISTS
FOR (r:Role) REQUIRE r.nombre IS UNIQUE;
```

### 5.2 Nodos de rol

```cypher
MERGE (admin:Role {nombre: 'ADMIN'})
SET admin.descripcion = 'Administrador del campus', admin.nivel = 1, admin.activo = true;

MERGE (prof:Role {nombre: 'PROFESOR'})
SET prof.descripcion = 'Docente', prof.nivel = 2, prof.activo = true;

MERGE (ent:Role {nombre: 'ENTRENADOR'})
SET ent.descripcion = 'Entrenador deportivo', ent.nivel = 2, ent.activo = true;

MERGE (bec:Role {nombre: 'BECARIO'})
SET bec.descripcion = 'Alumno con beca', bec.nivel = 3, bec.activo = true;

MERGE (est:Role {nombre: 'ESTUDIANTE'})
SET est.descripcion = 'Alumno regular', est.nivel = 3, est.activo = true;
```

### 5.3 Relaciones `INHERITS`

> Importante: usar `MATCH` de ambos nodos + `MERGE` de la relación. Hacer `MERGE` sobre el patrón completo cuando los nodos ya existen provoca `ConstraintValidationFailed`.

```cypher
MATCH (admin:Role {nombre: 'ADMIN'})
MATCH (prof:Role {nombre: 'PROFESOR'})
MERGE (admin)-[:INHERITS]->(prof);

MATCH (admin:Role {nombre: 'ADMIN'})
MATCH (ent:Role {nombre: 'ENTRENADOR'})
MERGE (admin)-[:INHERITS]->(ent);

MATCH (prof:Role {nombre: 'PROFESOR'})
MATCH (est:Role {nombre: 'ESTUDIANTE'})
MERGE (prof)-[:INHERITS]->(est);

MATCH (ent:Role {nombre: 'ENTRENADOR'})
MATCH (est:Role {nombre: 'ESTUDIANTE'})
MERGE (ent)-[:INHERITS]->(est);

MATCH (bec:Role {nombre: 'BECARIO'})
MATCH (est:Role {nombre: 'ESTUDIANTE'})
MERGE (bec)-[:INHERITS]->(est);
```

### 5.4 Consultar el cierre transitivo

```cypher
MATCH (r:Role {nombre: 'ADMIN'})-[:INHERITS*1..]->(ancestro:Role)
RETURN DISTINCT ancestro.nombre AS hereda;
```

`[:INHERITS*1..]` es el recorrido de longitud variable que implementa la transitividad.

### 5.5 Validar ciclos antes de crear una relación

```cypher
MATCH (padre:Role {nombre: 'PROFESOR'})-[:INHERITS*1..]->(hijo:Role {nombre: 'ADMIN'})
RETURN count(*) > 0 AS generaCiclo;
```

Si devuelve `true`, la relación `ADMIN → PROFESOR` generaría un ciclo y debe rechazarse.

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

### Modificados

| Archivo | Cambio |
|---|---|
| `mapa-service/src/index.js` | Contexto con `actor` + verificaciones en resolvers |
| `deportes-service/src/index.js` | Contexto con `actor` + verificaciones en resolvers |
| `auditoria-service/src/index.js` | Contexto con `actor` + verificación en query |
| `*/src/infrastructure/runtime-config.js` | `jwtSecret` obligatorio y exportado |
| `*/package.json` y `package-lock.json` | Dependencia `jsonwebtoken` |
| `*/.env.example` | Variables `JWT_SECRET` y Neo4j documentadas |

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

Los pasos de prueba end-to-end están en `GUIA_CLONADO_Y_CONFIGURACION.md` (sección de pruebas).

---

## 12. Limitaciones y pendientes

1. **Jerarquía duplicada en código:** `ROLE_INHERITANCE` es un espejo del grafo de Neo4j. Cuando el login calcule los roles efectivos y los guarde en la sesión, la constante dejará de usarse.
2. **JWT con un solo rol:** actualmente el token lleva `{ id, rol, jti }`. Para aprovechar la herencia desde Neo4j, falta que el login resuelva el cierre transitivo y lo propague.
3. **Acceso directo a subgrafos:** los subgrafos verifican la firma JWT, pero no consultan Redis. El Gateway sí bloquea tokens con sesión cerrada; una llamada directa al puerto con un JWT aún vigente pasaría.
4. **Siembra de Neo4j manual:** el grafo se crea con las consultas Cypher de la sección 5. Queda pendiente automatizarlo al arrancar `seguridad-service`.
5. **`ENTRENADOR`:** ya tiene permisos reales en Deportes; en Académico sigue sin reglas propias.
6. **Caché de roles efectivos:** cuando se implemente la resolución en Neo4j, conviene cachear el cierre transitivo en Redis e invalidarlo al crear roles o relaciones.
