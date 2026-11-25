# Pruebas Rápidas: Horarios + Redis Cache

## Levantar todo (7 terminales)

```bash
# 1. Infraestructura
cd Docker && docker-compose up -d

# 2. Seguridad (4005)
cd Proyecto/services/seguridad-service && npm start

# 3. Académico (4004)
cd Proyecto/services/academico-service && npm start

# 4. Deportes (4001)
cd Proyecto/services/deportes-service && npm start

# 5. Mapa (4002)
cd Proyecto/services/mapa-service && npm start

# 6. Auditoría (4003)
cd Proyecto/services/auditoria-service && npm start

# 7. Gateway (4000)
cd Proyecto/gateway && npm start
```

---

## Flujo de pruebas (Apollo Studio en http://localhost:4000)

### 1. Crear usuarios
```graphql
# ALUMNO (sin rol queda ESTUDIANTE)
mutation { registrarUsuario(matricula:"2024001", nombre:"Juan", email:"juan@test.com", password:"123456") { id } }

# ADMIN: se registra igual (queda ESTUDIANTE) y luego se sube a ADMIN
mutation { registrarUsuario(matricula:"2024900", nombre:"Admin", email:"admin@test.com", password:"123456") { id } }
```

> `registrarUsuario` ya no deja que un anónimo pida `rol:"ADMIN"`. El primer ADMIN se sube en MongoDB y se reinicia `seguridad-service` para que Neo4j lo sepa (pasos en `GUIA_CLONADO_Y_CONFIGURACION.md`, paso 8). La matrícula debe ser de 6 a 10 dígitos (`ADMIN001` no pasa la validación).

### 2. Login y guardar tokens
```graphql
mutation { login(email:"juan@test.com", password:"123456") { token } }
mutation { login(email:"admin@test.com", password:"123456") { token } }
```
> Usar `Authorization: Bearer <TOKEN>` en headers

### 3. Catálogo (con token ADMIN)
```graphql
mutation {
  crearCarrera(input:{nombre:"Ingeniería"}) { id }
  crearMateria(input:{nombre:"Cálculo", creditos:5}) { id }
  crearPeriodo(input:{nombre:"2024-1", fechaInicio:"2024-01-15", fechaFin:"2024-05-30"}) { id }
}
```

### 4. Profesor + Asignación + Inscripción (token ADMIN)
```graphql
mutation {
  # Con el token del ADMIN sí se puede mandar rol (un anónimo recibe FORBIDDEN)
  registrarUsuario(matricula:"2024800", nombre:"Dr. García", email:"prof@test.com", password:"123456", rol:"PROFESOR") { id }
  crearAsignacionMateria(input:{materiaId:"<MAT_ID>", profesorId:"<PROF_ID>", periodoId:"<PER_ID>", grupo:"A"}) { id }
  inscribirAlumno(input:{alumnoId:"<ALU_ID>", asignacionMateriaId:"<ASIG_ID>", estado:"ACTIVA"}) { id }
}
```

### 5. Crear sesión horario (token ADMIN)
```graphql
mutation {
  crearSesionHorario(input:{
    asignacionMateriaId:"<ASIG_ID>",
    diaSemana:1, horaInicio:"08:00", horaFin:"10:00",
    aula:"A-101", carreraIds:["<CAR_ID>"]
  }) { id materia grupo dia horaInicio horaFin aula }
}
```

---

## Verificar Redis Cache (token ALUMNO)

```graphql
query { miHorario(periodoId:"<PER_ID>") { id materia grupo dia horaInicio horaFin aula } }
```

| Consulta | Log esperado en academico-service |
|----------|-----------------------------------|
| **1ra** (MISS) | `🔍 USE CASE CACHE MISS` → `📦 CACHE SET` |
| **2da** (HIT) | `⚡ USE CASE CACHE HIT` + `📦 CACHE HIT` (instantáneo) |
| **Tras mutación** (actualizar/crear/inscribir) | `🗑️ USE CASE CACHE INVALIDATE` + `📦 CACHE DEL` |
| **Siguiente** (MISS de nuevo) | Igual que 1ra |

---

## Logs clave a observar

```
# Cache miss + populate
🔍 USE CASE CACHE MISS: horario:estudiante:... → consultando MongoDB
📦 CACHE SET: horario:estudiante:... (TTL: 86400s)
💾 USE CASE CACHE POPULATED: horario:estudiante:...

# Cache hit
⚡ USE CASE CACHE HIT: horario:estudiante:...
📦 CACHE HIT: horario:estudiante:...

# Invalidación
🗑️ USE CASE CACHE INVALIDATE: horario:estudiante:...
📦 CACHE DEL: horario:estudiante:...

# TTL configurado al arrancar
🕐 Cache TTL horarios: 86400s (24h)

# Sesión expirada (seguridad + gateway)
🔒 SESIÓN EXPIRADA/INVALIDADA: jti=..., userId=...
🔒 GATEWAY SESIÓN EXPIRADA: jti=..., userId=...
```

---

## Cambiar TTL
```bash
# En academico-service/.env
HORARIO_TTL_SECONDS=3600  # 1 hora
# Reiniciar academico-service
```

---

## Verificar en Redis CLI
```bash
docker exec -it ulsa-redis-stack redis-cli -a password123
> SCAN 0 MATCH horario:* COUNT 100
> GET "horario:estudiante:<ALU_ID>:<PER_ID>"
```
