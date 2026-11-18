# Punto 1: Eventos Forenses y Privacidad (CWE-532)

**Proyecto:** UlsaHub  
**Rama de trabajo:** `feature/eventos-forenses-auditoria`  
**Base:** `main` (no se modificó directamente)

---

## 1. Resumen de cambios

Se implementaron los 4 eventos críticos de auditoría acordados, siguiendo el esquema definido y aplicando mitigación CWE-532 (minimización de datos, sin secretos en logs, identificadores opacos).

### Archivos modificados

| # | Ruta | Líneas aproximadas | Qué se cambió |
|---|------|-------------------|---------------|
| 1 | `Proyecto/node_modules-v2/services/seguridad-service/src/index.js` | 142-151, 348-468, 503-516, 525-647, 780-801 | Eventos `AUTENTICACION_USUARIO`, `SESION_REVOCADA`, `ASIGNACION_ROL_PERMISO` + utilidad `enmascararCorreo()` |
| 2 | `Proyecto/node_modules-v2/services/academico-service/src/infrastructure/gateway-identity.js` | 22, 48-50 | Actor incluye `ip_origen` y `jti` |
| 3 | `Proyecto/node_modules-v2/services/academico-service/src/application/academic-use-cases.js` | 136-166 | Resolver `calificaciones` emite `CONSULTA_DATOS_SENSIBLES` |

### Commits realizados

| Commit | Mensaje | Servicio |
|--------|---------|----------|
| `6e5696e` | feat(seguridad): evento AUTENTICACION_USUARIO con severidad y correo enmascarado | seguridad-service |
| `6b1424e` | feat(seguridad): evento SESION_REVOCADA en logout | seguridad-service |
| `26b6e0c` | feat(seguridad): evento ASIGNACION_ROL_PERMISO en crearRol y cambiarRolUsuario | seguridad-service |
| `f46bd09` | feat(academico): evento CONSULTA_DATOS_SENSIBLES en calificaciones | academico-service |

---

## 2. Tabla de eventos

| Evento | Severidad | Acción / endpoint que lo detona | Justificación legal / forense |
|--------|-----------|--------------------------------|-------------------------------|
| `AUTENTICACION_USUARIO` | INFO (exitoso) / WARNING (fallido) | `login` (seguridad-service) | Prueba de identidad y momento de acceso; eventos fallidos permiten detectar fuerza bruta. |
| `SESION_REVOCADA` | INFO | `logout` (seguridad-service) | Prueba de que un JWT dejó de ser válido en cierto momento (revocación por JTI en Redis). |
| `ASIGNACION_ROL_PERMISO` | CRITICAL | `cambiarRolUsuario` y `crearRol` (seguridad-service) | Cambio de privilegios de alta sensibilidad; inalterable para investigación de escalamiento de roles. |
| `CONSULTA_DATOS_SENSIBLES` | INFO (acceso propio) / WARNING (datos ajenos o denegado) | `calificaciones` (academico-service) | Demuestra control de acceso y no repudio sobre datos personales protegidos (calificaciones). |

---

## 3. Detalle por evento (Quién, Desde dónde, Cuándo, Qué)

### 3.1 AUTENTICACION_USUARIO
- **Quién:** `usuario_id` (código opaco). Si el usuario no existe: `null` y `correo_enmascarado` (`a***@dominio`) en metadata. `jti` solo si hay sesión.
- **Desde dónde:** `ip_origen` (gateway/socket) y `metadata.user_agent` (cliente de navegación).
- **Cuándo:** `fecha`, `timestamp`, `fecha_dia` (agregados automáticamente por `emitirEventoSeguridad`).
- **Qué:** `resultado` (`exitoso`/`fallido`), `severidad`, `motivo`, `operacion: 'login'`, `metadata.rol`.

### 3.2 SESION_REVOCADA
- **Quién:** `usuario_id` (dueño de la sesión). `metadata.usuario_que_revoca` (si igual que `usuario_id`, es logout voluntario; si distinto, revocación forzada).
- **Desde dónde:** `ip_origen`; `jti` del token revocado.
- **Cuándo:** `fecha`, `timestamp`, `fecha_dia`.
- **Qué:** `resultado: 'exitoso'`, `motivo: 'logout_voluntario'`, `operacion: 'logout'`.

### 3.3 ASIGNACION_ROL_PERMISO
- **Quién:** `usuario_id` (administrador que actúa, no el afectado). `metadata.usuario_afectado` (titular del rol cambiado; `null` en `crear_rol`). `metadata.rol_solicitante` en intentos denegados.
- **Desde dónde:** `ip_origen` y `jti` del administrador.
- **Cuándo:** `fecha`, `timestamp`, `fecha_dia`.
- **Qué:** `resultado` (`exitoso`/`denegado`), `motivo`, `operacion` (`crearRol`/`cambiarRolUsuario`), `metadata.tipo_operacion`, `metadata.rol_anterior`, `metadata.nuevo_rol`, `metadata.realizado_por`.

### 3.4 CONSULTA_DATOS_SENSIBLES
- **Quién:** `usuario_id` (quien consulta). `metadata.alumno_consultado` (titular de los datos).
- **Desde dónde:** `ip_origen` (vía `gateway-identity.js`) y `jti` del solicitante.
- **Cuándo:** `fecha`, `timestamp`, `fecha_dia`.
- **Qué:** `resultado: 'exitoso'`, `motivo`, `operacion: 'calificaciones'`, `metadata.rol`, `metadata.acceso_propio`, `metadata.recurso: 'calificaciones'`.

---

## 4. Mitigación CWE-532 y privacidad (LFPDPPP)

### Datos estrictamente proscritos en la carga de auditoría
- Contraseñas en texto plano
- Hashes de contraseña
- Tokens JWT completos (payload, firma, header)
- Secretos criptográficos, claves privadas, API keys
- Calificaciones, notas ni contenido del registro académico
- Correo institucional en plano (solo enmascarado `a***@ulsa.edu.mx` en login fallido de usuario inexistente)

### Identificadores opacos (ej. jti)
Un identificador opaco es un código que no revela información personal por sí solo (por ejemplo, `64f1a2c3...`). No dice el nombre, correo ni rol de nadie; solo sirve como referencia interna.

El uso del `jti` permite:
1. **Trazabilidad sin exposición:** Vincular un evento de auditoría con la sesión en Redis (`session:<jti>`) y revocarla si es necesario, sin guardar el JWT completo.
2. **Minimización de datos (LFPDPPP):** Solo se guarda lo estrictamente necesario para la investigación forense.
3. **Seguridad en caso de filtración de logs:** No se exponen contraseñas, tokens ni datos personales reales.

### Conservación y acceso
- **Plazo de retención:** 12 meses, luego expiración automática (TTL) en ScyllaDB.
- **Quién puede leer:** solo rol `ADMIN`, mediante consultas de auditoría. No hay endpoint público de lectura.
- **IP como dato personal:** se guarda por necesidad forense, con retención limitada a los 12 meses.
- **Inalterabilidad:** `auditoria-service` expone solo inserción (sin `UPDATE`/`DELETE` de eventos existentes).

---

## 5. Cambios de código por archivo (justificación línea a línea)

### 5.1 `seguridad-service/src/index.js`

**Líneas 142-151 — Nueva función `enmascararCorreo()`**
- Justificación: evitar guardar el correo institucional en plano bajo LFPDPPP. Devuelve `a***@dominio` para login fallido de usuario inexistente.

**Líneas 348-361 — Login fallido: usuario inexistente**
- Antes: `LOGIN_FAILED`, `usuario_id: 'ANONYMOUS'`, `email` en plano.
- Después: `AUTENTICACION_USUARIO`, `usuario_id: null`, `severidad: 'WARNING'`, `correo_enmascarado` en metadata.

**Líneas 377-391 — Login fallido: contraseña incorrecta**
- Antes: `LOGIN_FAILED`, `email: doc.email`.
- Después: `AUTENTICACION_USUARIO`, `severidad: 'WARNING'`, sin email, con `metadata.rol`.

**Líneas 402-416 — Login fallido: usuario deshabilitado**
- Antes: `LOGIN_FAILED`, `email: doc.email`.
- Después: `AUTENTICACION_USUARIO`, `severidad: 'WARNING'`, sin email.

**Líneas 454-468 — Login exitoso**
- Antes: `LOGIN_SUCCESS`, `email`, `jti` dentro de metadata.
- Después: `AUTENTICACION_USUARIO`, `severidad: 'INFO'`, `jti` en payload principal, `operacion: 'login'`, `user_agent` en metadata.

**Líneas 503-516 — Logout (`SESION_REVOCADA`)**
- Antes: `USUARIO_LOGOUT`, sin `ip_origen`, sin `severidad`, sin `jti`.
- Después: `SESION_REVOCADA`, `severidad: 'INFO'`, `motivo: 'logout_voluntario'`, `jti`, `operacion: 'logout'`, `metadata.usuario_que_revoca`.

**Líneas 525-647 — `crearRol` y `cambiarRolUsuario` (`ASIGNACION_ROL_PERMISO`)**
- Antes: `ROL_CREADO` y `ROLE_CHANGED`, `usuario_id` del afectado, `email`, sin `severidad`.
- Después: `ASIGNACION_ROL_PERMISO`, `severidad: 'CRITICAL'`, `usuario_id` del administrador que actúa, `metadata.usuario_afectado`, `metadata.rol_anterior`, `metadata.nuevo_rol`, `metadata.realizado_por`. Además, se emite evento cuando un no-ADMIN intenta crear/cambiar roles (resultado `denegado`).

### 5.2 `academico-service/src/infrastructure/gateway-identity.js`

**Línea 22 — Captura de IP**
- Justificación: obtener la IP real del cliente desde `x-forwarded-for` (gateway) con fallback a `request.socket.remoteAddress`.

**Líneas 48-50 — Actor con `ip_origen` y `jti`**
- Justificación: el contexto GraphQL de academico ahora trae la IP y el JTI del JWT para usarse en eventos de auditoría.

### 5.3 `academico-service/src/application/academic-use-cases.js`

**Líneas 136-166 — Resolver `calificaciones`**
- Justificación: emitir `CONSULTA_DATOS_SENSIBLES` tras autorización exitosa. Severidad `INFO` si acceso propio (ESTUDIANTE/BECARIO consulta sus propias calificaciones), `WARNING` si acceso a datos ajenos (PROFESOR/ADMIN). Payload sin calificaciones ni correo.

---

## 6. Limitación conocida

El evento `CONSULTA_DATOS_SENSIBLES` con `resultado: 'denegado'` no se emite actualmente porque las funciones de autorización (`assertCanAccessStudent`, `requireManagedInscripcion`) lanzan error antes de llegar al `publish`. Registrar intentos denegados requiere atrapar errores de autorización en una capa superior (mejora futura).

---

## 7. Estado de Git y pasos pendientes

- **Rama actual:** `feature/eventos-forenses-auditoria`
- **Commits realizados:** 4 (listados arriba)
- **Rama `main`:** No fue modificada directamente.
- **Push:** No se ha realizado `git push`.
- **Pull Request:** No se ha creado.

**¿Qué falta?** Si deseas subir los cambios y proponer su integración, los próximos pasos son:
1. `git push origin feature/eventos-forenses-auditoria`
2. Crear un Pull Request desde `feature/eventos-forenses-auditoria` hacia `main`

Esto no se ha hecho aún; quedará a tu criterio ejecutarlo.
