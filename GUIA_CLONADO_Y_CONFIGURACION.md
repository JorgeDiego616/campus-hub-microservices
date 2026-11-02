# UlsaHub — Guía para clonar, configurar y ejecutar

Esta guía está pensada para quien clona el repositorio o hace `pull` y necesita dejar el proyecto funcionando.

> **Importante:** el `.gitignore` excluye `node_modules/`, `.env` y `*.log`. Por eso, después de clonar **no existirán** las dependencias ni los archivos de entorno. Hay que crearlos siguiendo esta guía.

---

## 1. Requisitos

- **Node.js 20 o superior** (recomendado 22 LTS).
- **npm** incluido con Node.
- **Docker Desktop** con Docker Compose.
- Git.

Verifica:

```powershell
node -v
npm -v
docker -v
docker compose version
```

---

## 2. Estructura del repositorio

```
UlsaHub/
├── Docker/
│   └── docker-compose.yml
├── Proyecto/
│   ├── gateway/                         # API Gateway (puerto 4000)
│   └── node_modules-v2/
│       ├── node_modules/                # IGNORADO por git
│       └── services/
│           ├── seguridad-service/       # 4005
│           ├── academico-service/       # 4004
│           ├── deportes-service/        # 4001
│           ├── mapa-service/            # 4002
│           └── auditoria-service/       # 4003
├── .gitignore
├── CONTEXTO_PROYECTO.md
├── DOCUMENTACION_COMPLETA_PROYECTO.md
├── IMPLEMENTACION_ROLES_Y_PERMISOS.md
└── GUIA_CLONADO_Y_CONFIGURACION.md
```

> La carpeta se llama `node_modules-v2`, pero **no está ignorada**: el patrón `node_modules/` solo excluye carpetas llamadas exactamente `node_modules`. Los servicios sí se suben al repo.

### Qué NO viene en el repo

| Ignorado | Qué hacer |
|---|---|
| `node_modules/` | Ejecutar `npm install` en cada servicio y en el gateway |
| `.env` | Copiar desde `.env.example` y completar |
| `*.log` | No hacen falta; son salidas de ejecución |

Los archivos `.env.example` **sí** están en el repo y son la plantilla.

---

## 3. Paso 1 — Clonar el repositorio

```powershell
git clone <URL_DEL_REPO>
cd UlsaHub
```

Si ya lo tenías clonado:

```powershell
git pull
```

---

## 4. Paso 2 — Levantar la infraestructura con Docker

```powershell
cd Docker
docker compose up -d
```

Si tu versión es antigua:

```powershell
docker-compose up -d
```

Verifica que los 5 contenedores estén arriba:

```powershell
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
```

Deben aparecer:

| Contenedor | Puerto host |
|---|---|
| `ulsa-mongodb` | 27018 |
| `ulsa-redis-stack` | 6380 |
| `ulsa-neo4j` | 7475 (Browser) y 7688 (Bolt) |
| `ulsa-rabbitmq` | 5673 y 15673 |
| `ulsa-scylladb` | 9043 |

Credenciales:

- MongoDB: `admin / password123`
- Redis: `password123`
- Neo4j: `neo4j / password123`
- RabbitMQ: `guest / guest`

---

## 5. Paso 3 — Instalar dependencias

`node_modules` está ignorado, así que hay que instalar en **cada** carpeta.

```powershell
$root = "C:\ruta\a\UlsaHub"

$dirs = @(
  "$root\Proyecto\gateway",
  "$root\Proyecto\node_modules-v2\services\seguridad-service",
  "$root\Proyecto\node_modules-v2\services\academico-service",
  "$root\Proyecto\node_modules-v2\services\deportes-service",
  "$root\Proyecto\node_modules-v2\services\mapa-service",
  "$root\Proyecto\node_modules-v2\services\auditoria-service"
)

foreach ($d in $dirs) {
  Write-Host "Instalando en $d"
  Push-Location $d
  npm install
  Pop-Location
}
```

> Cambia `$root` por la ruta real donde clonaste el repo.

También puedes hacerlo manualmente con `npm install` dentro de cada una de esas 6 carpetas.

---

## 6. Paso 4 — Crear los archivos `.env`

Cada servicio necesita su `.env`. Como no vienen en el repo, se copian desde `.env.example`.

### 6.1 Generar un `JWT_SECRET` compartido

```powershell
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
```

Copia el resultado. **El mismo valor debe ir en los 6 `.env`**: gateway, seguridad, académico, deportes, mapa y auditoría. Si no coinciden, el Gateway no podrá validar los tokens.

### 6.2 Copiar plantillas y rellenar el secreto (atajo)

```powershell
$root = "C:\ruta\a\UlsaHub"
$secret = "<PEGA_AQUI_EL_SECRETO_GENERADO>"

$dirs = @(
  "$root\Proyecto\gateway",
  "$root\Proyecto\node_modules-v2\services\seguridad-service",
  "$root\Proyecto\node_modules-v2\services\academico-service",
  "$root\Proyecto\node_modules-v2\services\deportes-service",
  "$root\Proyecto\node_modules-v2\services\mapa-service",
  "$root\Proyecto\node_modules-v2\services\auditoria-service"
)

foreach ($d in $dirs) {
  $src = "$d\.env.example"
  $dst = "$d\.env"
  $text = (Get-Content $src -Raw)
  $text = $text -replace '(?m)^JWT_SECRET=.*$', "JWT_SECRET=$secret"
  $text = $text -replace '(?m)^REDIS_URL=\s*$', "REDIS_URL=redis://default:password123@localhost:6380"
  [System.IO.File]::WriteAllText($dst, $text, (New-Object System.Text.UTF8Encoding($false)))
  Write-Host "Creado $dst"
}
```

> El script rellena `JWT_SECRET` en los 6 archivos y, cuando `REDIS_URL` está vacío (caso del Gateway), lo deja apuntando a Redis local. El Gateway **exige** `REDIS_URL`.

### 6.3 Contenido esperado por servicio

Si prefieres hacerlo a mano, crea cada `.env` con estos valores:

**`Proyecto/gateway/.env`**
```env
PORT_GATEWAY=4000
JWT_SECRET=<mismo secreto>
SEGURIDAD_URL=http://localhost:4005/
ACADEMICO_URL=http://localhost:4004/
DEPORTES_URL=http://localhost:4001/
MAPA_URL=http://localhost:4002/
AUDITORIA_URL=http://localhost:4003/
REDIS_URL=redis://default:password123@localhost:6380
```

**`seguridad-service/.env`**
```env
INFRASTRUCTURE_MODE=local
PORT_SEGURIDAD=4005
JWT_SECRET=<mismo secreto>
REDIS_URL=redis://default:password123@localhost:6380
NEO4J_URI=bolt://localhost:7688
NEO4J_USER=neo4j
NEO4J_PASSWORD=password123
```

**`academico-service/.env`**
```env
INFRASTRUCTURE_MODE=local
PORT_ACADEMICO=4004
JWT_SECRET=<mismo secreto>
REDIS_URL=redis://default:password123@localhost:6380
HORARIO_TTL_SECONDS=86400
```

> En `academico-service`, `REDIS_URL` y `HORARIO_TTL_SECONDS` son opcionales: si no se definen, el perfil `local` usa `redis://:password123@localhost:6380` y `86400`.

**`deportes-service/.env`**
```env
INFRASTRUCTURE_MODE=local
PORT_DEPORTES=4001
JWT_SECRET=<mismo secreto>
```

**`mapa-service/.env`**
```env
INFRASTRUCTURE_MODE=local
PORT_MAPA=4002
JWT_SECRET=<mismo secreto>
REDIS_URL=redis://default:password123@localhost:6380
REDIS_CACHE_TTL_SECONDS=60
```

**`auditoria-service/.env`**
```env
INFRASTRUCTURE_MODE=local
PORT_AUDITORIA=4003
JWT_SECRET=<mismo secreto>
```

> Las URLs de MongoDB y RabbitMQ no son obligatorias: cada servicio trae valores por defecto para el perfil `local`. Si necesitas cambiarlas, usa `MONGODB_URI` y `RABBITMQ_URL`.

---

## 7. Paso 5 — Sembrar el grafo de roles en Neo4j

Los roles de MongoDB se crean solos al arrancar `seguridad-service`. El grafo de jerarquía en Neo4j **sí** hay que sembrarlo (por ahora de forma manual).

Entra al cliente de Neo4j:

```powershell
docker exec -it ulsa-neo4j cypher-shell -u neo4j -p password123
```

O abre `http://localhost:7475` y usa el navegador.

### 7.1 Restricción de unicidad

```cypher
CREATE CONSTRAINT role_nombre_unique IF NOT EXISTS
FOR (r:Role) REQUIRE r.nombre IS UNIQUE;
```

### 7.2 Crear roles

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

### 7.3 Crear herencias

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

### 7.4 Verificar

```cypher
MATCH (h:Role)-[:INHERITS]->(p:Role)
RETURN h.nombre AS hereda, p.nombre AS de
ORDER BY hereda, de;
```

Deben aparecer 5 relaciones. Sal del cliente con:

```cypher
:exit
```

---

## 8. Paso 6 — Arrancar los servicios

Orden recomendado: primero los subgrafos, luego el Gateway.

### Opción A — Terminales separadas

Abre una terminal por servicio y ejecuta `npm start`:

```powershell
# Terminal 1
cd Proyecto\node_modules-v2\services\seguridad-service
npm start

# Terminal 2
cd Proyecto\node_modules-v2\services\academico-service
npm start

# Terminal 3
cd Proyecto\node_modules-v2\services\deportes-service
npm start

# Terminal 4
cd Proyecto\node_modules-v2\services\mapa-service
npm start

# Terminal 5
cd Proyecto\node_modules-v2\services\auditoria-service
npm start

# Terminal 6 (cuando los 5 anteriores ya escuchen)
cd Proyecto\gateway
npm start
```

### Opción B — En segundo plano (PowerShell)

```powershell
$root = "C:\ruta\a\UlsaHub"
$log  = "C:\Users\$env:USERNAME\AppData\Local\Temp\ulsahub-logs"
New-Item -ItemType Directory -Force -Path $log | Out-Null

# 1) Subgrafos
$svcs = @("seguridad-service","academico-service","deportes-service","mapa-service","auditoria-service")
$pids = @()
foreach ($s in $svcs) {
  $dir = "$root\Proyecto\node_modules-v2\services\$s"
  $p = Start-Process node -ArgumentList "src/index.js" -WorkingDirectory $dir `
       -RedirectStandardOutput "$log\$s.out.log" -RedirectStandardError "$log\$s.err.log" `
       -PassThru -WindowStyle Hidden
  $pids += "$s=$($p.Id)"
}
$pids | Set-Content "$log\subgraph-pids.txt"

# 2) Esperar puertos 4005,4004,4001,4002,4003
foreach ($p in @(4005,4004,4001,4002,4003)) {
  for ($i=0; $i -lt 40; $i++) {
    if (Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue) { break }
    Start-Sleep -Seconds 1
  }
}

# 3) Gateway
$gw = Start-Process node -ArgumentList "src/index.js" -WorkingDirectory "$root\Proyecto\gateway" `
      -RedirectStandardOutput "$log\gateway.out.log" -RedirectStandardError "$log\gateway.err.log" `
      -PassThru -WindowStyle Hidden
$gw.Id | Set-Content "$log\gateway-pid.txt"
```

---

## 9. Paso 7 — Verificar que todo arrancó

```powershell
foreach ($p in @(4000,4001,4002,4003,4004,4005)) {
  $ok = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue
  "$p -> $(if ($ok) {'LISTEN'} else {'FALLO'})"
}
```

Todos deben decir `LISTEN`. Si alguno falla, revisa su log:

```powershell
Get-Content "$log\seguridad-service.err.log" -Tail 30
Get-Content "$log\gateway.err.log" -Tail 30
```

Prueba rápida de GraphQL en el Gateway:

```powershell
$body = @{ query = 'query { roles { id nombre } }' } | ConvertTo-Json
Invoke-RestMethod -Uri "http://localhost:4000/" -Method Post -ContentType "application/json" -Body $body | ConvertTo-Json -Depth 5
```

Debe devolver los 5 roles sembrados en MongoDB.

---

## 10. Paso 8 — Crear un usuario y probar permisos

### Registrar un ADMIN

```powershell
$q = 'mutation { registrarUsuario(matricula:"20260001", nombre:"Admin", email:"admin@ulsa.mx", password:"Password123", rol:"ADMIN") { id rol } }'
$body = @{ query = $q } | ConvertTo-Json
Invoke-RestMethod -Uri "http://localhost:4000/" -Method Post -ContentType "application/json" -Body $body | ConvertTo-Json -Depth 5
```

### Login y token

```powershell
$q = 'mutation { login(email:"admin@ulsa.mx", password:"Password123") { token usuario { rol } } }'
$body = @{ query = $q } | ConvertTo-Json
$token = (Invoke-RestMethod -Uri "http://localhost:4000/" -Method Post -ContentType "application/json" -Body $body).data.login.token
$token
```

### Probar una mutación protegida

```powershell
$headers = @{ 'Content-Type'='application/json'; 'Authorization'="Bearer $token" }
$q = 'mutation { crearEspacio(input:{nombre:"Aula Prueba", tipo:SALON, edificio:"A", piso:1, descripcion:"demo"}) { id nombre activo } }'
$body = @{ query = $q } | ConvertTo-Json
Invoke-RestMethod -Uri "http://localhost:4000/" -Method Post -Headers $headers -Body $body | ConvertTo-Json -Depth 5
```

Si funciona, el flujo de autenticación y autorización está completo.

---

## 11. Apagar todo

```powershell
$log = "C:\Users\$env:USERNAME\AppData\Local\Temp\ulsahub-logs"
if (Test-Path "$log\subgraph-pids.txt") {
  Get-Content "$log\subgraph-pids.txt" | ForEach-Object {
    Stop-Process -Id ([int](($_ -split '=')[1])) -Force -ErrorAction SilentlyContinue
  }
}
if (Test-Path "$log\gateway-pid.txt") {
  Stop-Process -Id ([int](Get-Content "$log\gateway-pid.txt")) -Force -ErrorAction SilentlyContinue
}

foreach ($p in @(4000,4001,4002,4003,4004,4005)) {
  $c = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue
  if ($c) { $c.OwningProcess | Sort-Object -Unique | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue } }
}

# Infraestructura (opcional)
cd Docker
docker compose down
```

---

## 12. Problemas comunes

| Síntoma | Causa | Solución |
|---|---|---|
| `JWT_SECRET es obligatorio en ...` | Falta `.env` o la variable | Crear `.env` desde `.env.example` y rellenar `JWT_SECRET` |
| `ERR_MODULE_NOT_FOUND: jsonwebtoken` | Falta la dependencia | `npm install` en esa carpeta |
| El token se rechaza en el Gateway | `JWT_SECRET` distinto entre servicios | Usar el **mismo** valor en los 6 `.env` |
| `Neo4j` conecta al 7687 y falla | La variable no está o usa el puerto equivocado | `NEO4J_URI=bolt://localhost:7688` |
| El Gateway no arranca / composición falla | Un subgrafo está caído | Levantar los 5 subgrafos antes del Gateway |
| `registrarUsuario` dice "El rol no existe" | Seguridad no arrancó o no sembró roles | Reiniciar `seguridad-service` y revisar su log |
| Redis rechaza la conexión | URL o contraseña | `redis://default:password123@localhost:6380` |
| MongoDB rechaza la conexión | URI o `authSource` | Usar el perfil `local` o definir `MONGODB_URI` con `?authSource=admin` |
| `ConstraintValidationFailed` en Neo4j | `MERGE` de patrón completo con nodos existentes | Usar `MATCH` de ambos nodos + `MERGE` de la relación |

---

## 13. Checklist final

- [ ] Docker con los 5 contenedores arriba.
- [ ] `npm install` ejecutado en gateway + 5 servicios.
- [ ] `.env` creado en gateway + 5 servicios.
- [ ] Mismo `JWT_SECRET` en los 6 `.env`.
- [ ] Grafo de roles sembrado en Neo4j (5 nodos + 5 relaciones).
- [ ] Servicios escuchando en 4000–4005.
- [ ] `roles` responde desde el Gateway.
- [ ] `registrarUsuario` + `login` funcionan.
- [ ] Una mutación protegida responde según el rol.

Si todo el checklist está completo, el proyecto quedó correctamente configurado.
