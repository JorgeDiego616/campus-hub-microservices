# Contexto del Proyecto: UlsaHub (Campus Hub)

## Arquitectura General

**Microservicios con Apollo Federation (Gateway + Subgraphs)**

| Servicio | Puerto | Responsabilidad | DB Principal |
|----------|--------|-----------------|--------------|
| **gateway** | 4000 | Composition, auth centralizada (JWT + Redis), routing | Redis (sesiones) |
| **seguridad-service** | 4005 | Auth, usuarios, roles, JWT, sesiones | MongoDB, Redis, Neo4j |
| **academico-service** | 4004 | Carreras, materias, inscripciones, calificaciones, **horarios** | MongoDB, Redis (cache) |
| **deportes-service** | 4001 | Equipos, prácticas deportivas | MongoDB |
| **mapa-service** | 4002 | Espacios físicos (aulas, edificios) | MongoDB |
| **auditoria-service** | 4003 | Logs inmutables (event sourcing) | ScyllaDB |

**Message Broker:** RabbitMQ (eventos de dominio async)

---

## Infraestructura (Docker Compose)

```yaml
# Docker/docker-compose.yml
mongodb:      27018  (admin/password123)
redis-stack:  6380   (password123)  # Cache + sesiones
neo4j:        7475/7688  (neo4j/password123)
scylladb:     9043   # Auditoría inmutable
rabbitmq:     5673/15673  (guest/guest)
```

---

## Flujo de Autenticación

1. **Login** en `seguridad-service` → JWT + `jti` (UUID)
2. **Sesión** guardada en Redis: `session:<jti>` TTL 1h
3. **Gateway** valida cada request:
   - Verifica firma JWT (secret compartido)
   - Verifica `session:<jti>` existe en Redis
   - Pasa `x-user-id`, `x-user-role` a subgraphs
4. **Subgraphs** reciben `actor: { id, rol }` en context

---

## Horarios + Redis Cache (Feature actual)

### Schema (academico-service)
```graphql
type SesionHorario { id, asignacionMateriaId, materia, grupo, diaSemana, dia, horaInicio, horaFin, aula, carreraIds }

Query: horarios(periodoId), miHorario(periodoId), horarioAlumno(alumnoId, periodoId)
Mutation: crearSesionHorario, actualizarSesionHorario, eliminarSesionHorario
```

### Cache-Aside Pattern
- **Key:** `horario:estudiante:<alumnoId>:<periodoId>`
- **TTL:** `HORARIO_TTL_SECONDS` (default 86400 = 24h, configurable)
- **Invalidación automática** al: crear/actualizar/eliminar sesión, inscribir alumno
- **Lock en memoria** evita race condition (múltiples MISS paralelos)

### Archivos clave
```
academico-service/
├── src/
│   ├── application/academic-use-cases.js     # Lógica de negocio + cache
│   ├── domain/horario.js                     # Entidad pura SesionHorario
│   ├── infrastructure/
│   │   ├── redis-cache.js                    # Cliente Redis tolerante a fallos
│   │   ├── mongoose-repositories.js          # Repo horarios + findOverlapping
│   │   ├── runtime-config.js                 # Lee HORARIO_TTL_SECONDS
│   │   └── mongoose-models.js                # HorarioModel (índice + validación)
│   └── index.js                              # Wiring: pasa cache + TTL a useCases
```

---

## Variables de Entorno Importantes

### Gateway (`.env`)
```env
JWT_SECRET=<igual que seguridad>
REDIS_URL=redis://:password123@localhost:6380
SEGURIDAD_URL=http://localhost:4005/
ACADEMICO_URL=http://localhost:4004/
```

### Seguridad (`.env`)
```env
JWT_SECRET=<mismo que gateway>
REDIS_URL=redis://:password123@localhost:6380
MONGODB_URI=mongodb://admin:password123@localhost:27018/seguridad?authSource=admin
```

### Académico (`.env`)
```env
INFRASTRUCTURE_MODE=local
REDIS_URL=redis://:password123@localhost:6380
HORARIO_TTL_SECONDS=86400  # 24h
MONGODB_URI=mongodb://admin:password123@localhost:27018/academico?authSource=admin
RABBITMQ_URL=amqp://guest:guest@localhost:5673
```

---

## Comandos Útiles

```bash
# Ver logs de cache en academico
# Buscar: 🔍 MISS, ⚡ HIT, 💾 POPULATED, 🗑️ INVALIDATE, 📦 CACHE

# Redis CLI
docker exec -it ulsa-redis-stack redis-cli -a password123
> KEYS horario:*
> TTL "horario:estudiante:..."

# Ver contenedores
docker ps | findstr ulsa

# Reiniciar servicio individual
cd Proyecto/node_modules-v2/services/<servicio> && npm start
```

---

## Problemas Conocidos / Pendientes

1. **Gateway no tiene healthcheck** para subgraphs caídos
2. **Lock en memoria** (`_cacheLocks`) se pierde si hay múltiples instancias de academico-service (solo funciona en single-instance)
3. **Audit service** usa ScyllaDB local; en docker necesita `INFRASTRUCTURE_MODE=docker`
4. **Deportes/Mapa** usan BD `resistencia` y `mapa` distintas; no comparten datos con académico
5. **Neo4j** en seguridad-service para grafos de permisos/roles (no usado activamente en horarios)

---

## Próximos Pasos Sugeridos

- [ ] Mover lock a Redis (distribuido) si hay multiple replicas
- [ ] Agregar métricas (hit/miss ratio) en `/metrics`
- [ ] Tests de integración para invalidación de cache
- [ ] Documentar eventos RabbitMQ para auditoría
- [ ] Rate limiting en gateway