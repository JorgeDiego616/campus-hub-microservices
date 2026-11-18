// init-rbac.cql
// Modelo RBAC de UlsaHub para Neo4j 5.x.
// Uso: cypher-shell -u neo4j -p <password> -f init-rbac.cql
// El script es idempotente: puede ejecutarse varias veces sin duplicar datos.

// 1) Restricciones de unicidad
CREATE CONSTRAINT unique_user_id IF NOT EXISTS FOR (u:User) REQUIRE u.id IS UNIQUE;
CREATE CONSTRAINT unique_role_name IF NOT EXISTS FOR (r:Role) REQUIRE r.name IS UNIQUE;
CREATE CONSTRAINT unique_route_path IF NOT EXISTS FOR (rt:Route) REQUIRE rt.path IS UNIQUE;
CREATE CONSTRAINT unique_menu_id IF NOT EXISTS FOR (m:MenuNode) REQUIRE m.id IS UNIQUE;

// 2) Roles del negocio
UNWIND [
  {name: 'ADMIN', level: 1, description: 'Administrador del campus'},
  {name: 'PROFESOR', level: 2, description: 'Docente'},
  {name: 'ENTRENADOR', level: 2, description: 'Entrenador deportivo'},
  {name: 'COORDINADOR', level: 2, description: 'Coordinador de actividades'},
  {name: 'BECARIO', level: 2, description: 'Coordinador de becas'},
  {name: 'ESTUDIANTE', level: 3, description: 'Alumno regular'}
] AS role
MERGE (r:Role {name: role.name})
SET r.level = role.level, r.description = role.description;

// 2.1) Jerarquia: el rol superior hereda hacia el inferior
UNWIND [
  {superior: 'ADMIN', inferior: 'PROFESOR'},
  {superior: 'ADMIN', inferior: 'ENTRENADOR'},
  {superior: 'ADMIN', inferior: 'COORDINADOR'},
  {superior: 'ADMIN', inferior: 'BECARIO'},
  {superior: 'PROFESOR', inferior: 'ESTUDIANTE'},
  {superior: 'ENTRENADOR', inferior: 'ESTUDIANTE'},
  {superior: 'COORDINADOR', inferior: 'ESTUDIANTE'},
  {superior: 'BECARIO', inferior: 'ESTUDIANTE'}
] AS link
MATCH (superior:Role {name: link.superior})
MATCH (inferior:Role {name: link.inferior})
MERGE (superior)-[:INHERITS]->(inferior);

// 3) Rutas de la aplicacion
UNWIND [
  {path: 'onboarding', title: 'Onboarding', public: true},
  {path: 'login', title: 'Login', public: true},
  {path: 'register', title: 'Registro', public: true},
  {path: 'tabs', title: 'Pestañas', public: false},
  {path: 'home_home', title: 'Inicio', public: false},
  {path: 'team_section', title: 'Equipos', public: false},
  {path: 'news_section', title: 'Noticias', public: false},
  {path: 'matches_section', title: 'Partidos', public: false},
  {path: 'profile_section', title: 'Perfil', public: false},
  {path: 'api_request', title: 'API', public: false},
  {path: 'team_detail/{name}', title: 'Detalle equipo', public: false},
  {path: 'match_detail/{id}', title: 'Detalle partido', public: false},
  {path: 'news_detail/{id}', title: 'Detalle noticia', public: false},
  {path: 'event_detail/{id}', title: 'Detalle evento', public: false},
  {path: 'registration_screen/{eventId}', title: 'Registro evento', public: false},
  {path: 'qr_screen', title: 'Crear evento / QR', public: false}
] AS route
MERGE (rt:Route {path: route.path})
SET rt.title = route.title, rt.public = route.public;

// 3.1) Accesos directos al rol mas bajo autorizado
UNWIND [
  {role: 'ESTUDIANTE', path: 'home_home'},
  {role: 'ESTUDIANTE', path: 'team_section'},
  {role: 'ESTUDIANTE', path: 'news_section'},
  {role: 'ESTUDIANTE', path: 'matches_section'},
  {role: 'ESTUDIANTE', path: 'profile_section'},
  {role: 'ESTUDIANTE', path: 'api_request'},
  {role: 'ESTUDIANTE', path: 'tabs'},
  {role: 'ESTUDIANTE', path: 'team_detail/{name}'},
  {role: 'ESTUDIANTE', path: 'match_detail/{id}'},
  {role: 'ESTUDIANTE', path: 'news_detail/{id}'},
  {role: 'ESTUDIANTE', path: 'event_detail/{id}'},
  {role: 'ESTUDIANTE', path: 'registration_screen/{eventId}'},
  {role: 'ENTRENADOR', path: 'qr_screen'},
  {role: 'PROFESOR', path: 'qr_screen'},
  {role: 'COORDINADOR', path: 'qr_screen'},
  {role: 'BECARIO', path: 'qr_screen'}
] AS access
MATCH (r:Role {name: access.role})
MATCH (rt:Route {path: access.path})
MERGE (r)-[:CAN_ACCESS]->(rt);

// 3.2) Mutaciones de GraphQL como rutas protegidas
// Uso el prefijo 'gql:' para no mezclarlas con las pantallas de la app.
// El Gateway revisa estas rutas antes de mandar la mutacion al subgrafo,
// asi que si no hay camino HAS_ROLE -> INHERITS*0.. -> CAN_ACCESS, se bloquea
// con 403 y nunca se escribe nada en MongoDB.
UNWIND [
  {path: 'gql:login', title: 'Iniciar sesión', public: true},
  {path: 'gql:registrarUsuario', title: 'Registrar usuario', public: true},
  {path: 'gql:logout', title: 'Cerrar sesión', public: true},
  {path: 'gql:crearRol', title: 'Crear rol', public: false},
  {path: 'gql:cambiarRolUsuario', title: 'Cambiar rol de usuario', public: false},
  {path: 'gql:registrarEquipo', title: 'Registrar equipo', public: false},
  {path: 'gql:registrarPractica', title: 'Registrar práctica', public: false},
  {path: 'gql:crearEspacio', title: 'Crear espacio', public: false},
  {path: 'gql:activarEspacio', title: 'Activar espacio', public: false},
  {path: 'gql:desactivarEspacio', title: 'Desactivar espacio', public: false},
  {path: 'gql:crearCarrera', title: 'Crear carrera', public: false},
  {path: 'gql:crearMateria', title: 'Crear materia', public: false},
  {path: 'gql:crearPeriodo', title: 'Crear periodo', public: false},
  {path: 'gql:crearAsignacionMateria', title: 'Asignar materia', public: false},
  {path: 'gql:crearSesionHorario', title: 'Crear sesión de horario', public: false},
  {path: 'gql:actualizarSesionHorario', title: 'Actualizar sesión de horario', public: false},
  {path: 'gql:eliminarSesionHorario', title: 'Eliminar sesión de horario', public: false},
  {path: 'gql:registrarCalificacion', title: 'Registrar calificación', public: false},
  {path: 'gql:registrarFalta', title: 'Registrar falta', public: false},
  {path: 'gql:registrarExamen', title: 'Registrar examen', public: false},
  {path: 'gql:inscribirAlumno', title: 'Inscribir alumno', public: false},
  {path: 'gql:guardarPerfilAcademico', title: 'Guardar perfil académico', public: false},
  {path: 'gql:registrarHorasComplementarias', title: 'Registrar horas complementarias', public: false},
  {path: 'gql:registrarHorasBecarias', title: 'Registrar horas becarias', public: false}
] AS op
MERGE (rt:Route {path: op.path})
SET rt.title = op.title, rt.public = op.public, rt.tipo = 'graphql';

// 3.3) Permiso al rol mas bajo; los de arriba lo heredan solos
UNWIND [
  {role: 'ADMIN', path: 'gql:crearRol'},
  {role: 'ADMIN', path: 'gql:cambiarRolUsuario'},
  {role: 'ADMIN', path: 'gql:crearEspacio'},
  {role: 'ADMIN', path: 'gql:activarEspacio'},
  {role: 'ADMIN', path: 'gql:desactivarEspacio'},
  {role: 'ADMIN', path: 'gql:crearCarrera'},
  {role: 'ADMIN', path: 'gql:crearMateria'},
  {role: 'ADMIN', path: 'gql:crearPeriodo'},
  {role: 'ADMIN', path: 'gql:crearAsignacionMateria'},
  {role: 'ADMIN', path: 'gql:crearSesionHorario'},
  {role: 'ADMIN', path: 'gql:actualizarSesionHorario'},
  {role: 'ADMIN', path: 'gql:eliminarSesionHorario'},
  {role: 'ENTRENADOR', path: 'gql:registrarEquipo'},
  {role: 'ENTRENADOR', path: 'gql:registrarPractica'},
  {role: 'PROFESOR', path: 'gql:registrarCalificacion'},
  {role: 'PROFESOR', path: 'gql:registrarFalta'},
  {role: 'PROFESOR', path: 'gql:registrarExamen'},
  {role: 'ESTUDIANTE', path: 'gql:inscribirAlumno'},
  {role: 'ESTUDIANTE', path: 'gql:guardarPerfilAcademico'},
  {role: 'ESTUDIANTE', path: 'gql:registrarHorasComplementarias'},
  {role: 'BECARIO', path: 'gql:registrarHorasBecarias'}
] AS access
MATCH (r:Role {name: access.role})
MATCH (rt:Route {path: access.path})
MERGE (r)-[:CAN_ACCESS]->(rt);

// 4) Nodos de menu (se limpian para no arrastrar nodos viejos como 'root')
MATCH (m:MenuNode) DETACH DELETE m;

UNWIND [
  {id: 'home', title: 'Inicio', order: 1},
  {id: 'teams', title: 'Equipos', order: 2},
  {id: 'news', title: 'Noticias', order: 3},
  {id: 'matches', title: 'Partidos', order: 4},
  {id: 'management', title: 'Gestión', order: 5},
  {id: 'profile', title: 'Perfil', order: 6},
  {id: 'qr', title: 'Crear evento / QR', order: 1}
] AS menu
MERGE (m:MenuNode {id: menu.id})
SET m.title = menu.title, m.order = menu.order;

// 4.1) Jerarquia del menu: management es padre de qr
MATCH (p:MenuNode {id: 'management'})
MATCH (c:MenuNode {id: 'qr'})
MERGE (p)-[:HAS_CHILD]->(c);

// 4.2) Navegacion del menu hacia las rutas (management es solo contenedor)
UNWIND [
  {menu: 'home', path: 'home_home'},
  {menu: 'teams', path: 'team_section'},
  {menu: 'news', path: 'news_section'},
  {menu: 'matches', path: 'matches_section'},
  {menu: 'profile', path: 'profile_section'},
  {menu: 'qr', path: 'qr_screen'}
] AS nav
MATCH (m:MenuNode {id: nav.menu})
MATCH (rt:Route {path: nav.path})
MERGE (m)-[:NAVIGATES_TO]->(rt);

// 4.3) Visibilidad del menu por rol
UNWIND [
  {role: 'ESTUDIANTE', menu: 'home'},
  {role: 'ESTUDIANTE', menu: 'teams'},
  {role: 'ESTUDIANTE', menu: 'news'},
  {role: 'ESTUDIANTE', menu: 'matches'},
  {role: 'ESTUDIANTE', menu: 'profile'},
  {role: 'PROFESOR', menu: 'management'},
  {role: 'PROFESOR', menu: 'qr'},
  {role: 'ENTRENADOR', menu: 'management'},
  {role: 'ENTRENADOR', menu: 'qr'},
  {role: 'COORDINADOR', menu: 'management'},
  {role: 'COORDINADOR', menu: 'qr'},
  {role: 'BECARIO', menu: 'management'},
  {role: 'BECARIO', menu: 'qr'}
] AS view
MATCH (r:Role {name: view.role})
MATCH (m:MenuNode {id: view.menu})
MERGE (r)-[:CAN_VIEW_MENU]->(m);

// 5) Usuarios de demostracion para probar el RBAC sin MongoDB
MATCH (u:User) WHERE u.demo = true
MATCH (u)-[old:HAS_ROLE]->(:Role)
DELETE old;

UNWIND [
  {id: 'demo-admin', role: 'ADMIN'},
  {id: 'demo-profesor', role: 'PROFESOR'},
  {id: 'demo-entrenador', role: 'ENTRENADOR'},
  {id: 'demo-coordinador', role: 'COORDINADOR'},
  {id: 'demo-estudiante', role: 'ESTUDIANTE'},
  {id: 'demo-becario', role: 'BECARIO'}
] AS demo
MERGE (u:User {id: demo.id})
SET u.role = demo.role, u.demo = true
WITH u, demo
MATCH (r:Role {name: demo.role})
MERGE (u)-[:HAS_ROLE]->(r);

// Usuario real (opcional):
// UNWIND [
//   {id: 'ID_MONGO_1', role: 'PROFESOR'},
//   {id: 'ID_MONGO_2', role: 'ESTUDIANTE'}
// ] AS real
// MERGE (u:User {id: real.id})
// WITH u, real
// MATCH (r:Role {name: real.role})
// MERGE (u)-[:HAS_ROLE]->(r);

// Limpieza de usuarios demo (opcional):
// MATCH (u:User {demo: true}) DETACH DELETE u;
