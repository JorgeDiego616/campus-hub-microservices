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
  {name: 'BECARIO', level: 3, description: 'Alumno con beca'},
  {name: 'ESTUDIANTE', level: 3, description: 'Alumno regular'}
] AS role
MERGE (r:Role {name: role.name})
SET r.level = role.level, r.description = role.description;

// 2.1) Jerarquia: el rol superior hereda hacia el inferior
UNWIND [
  {superior: 'ADMIN', inferior: 'PROFESOR'},
  {superior: 'ADMIN', inferior: 'ENTRENADOR'},
  {superior: 'ADMIN', inferior: 'COORDINADOR'},
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
  {role: 'COORDINADOR', path: 'qr_screen'}
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
  {role: 'COORDINADOR', menu: 'qr'}
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
