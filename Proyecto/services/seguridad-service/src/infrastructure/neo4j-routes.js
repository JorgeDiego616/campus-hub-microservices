const ROUTES = [
  { path: 'onboarding', title: 'Onboarding', public: true },
  { path: 'login', title: 'Login', public: true },
  { path: 'register', title: 'Registro', public: true },
  { path: 'tabs', title: 'Pestañas', public: false },
  { path: 'home_home', title: 'Inicio', public: false },
  { path: 'team_section', title: 'Equipos', public: false },
  { path: 'news_section', title: 'Noticias', public: false },
  { path: 'matches_section', title: 'Partidos', public: false },
  { path: 'profile_section', title: 'Perfil', public: false },
  { path: 'api_request', title: 'API', public: false },
  { path: 'team_detail/{name}', title: 'Detalle equipo', public: false },
  { path: 'match_detail/{id}', title: 'Detalle partido', public: false },
  { path: 'news_detail/{id}', title: 'Detalle noticia', public: false },
  { path: 'event_detail/{id}', title: 'Detalle evento', public: false },
  { path: 'registration_screen/{eventId}', title: 'Registro evento', public: false },
  { path: 'qr_screen', title: 'Crear evento / QR', public: false }
];

const ACCESS = [
  { role: 'ESTUDIANTE', path: 'home_home' },
  { role: 'ESTUDIANTE', path: 'team_section' },
  { role: 'ESTUDIANTE', path: 'news_section' },
  { role: 'ESTUDIANTE', path: 'matches_section' },
  { role: 'ESTUDIANTE', path: 'profile_section' },
  { role: 'ESTUDIANTE', path: 'api_request' },
  { role: 'ESTUDIANTE', path: 'tabs' },
  { role: 'ESTUDIANTE', path: 'team_detail/{name}' },
  { role: 'ESTUDIANTE', path: 'match_detail/{id}' },
  { role: 'ESTUDIANTE', path: 'news_detail/{id}' },
  { role: 'ESTUDIANTE', path: 'event_detail/{id}' },
  { role: 'ESTUDIANTE', path: 'registration_screen/{eventId}' },
  { role: 'ENTRENADOR', path: 'qr_screen' },
  { role: 'PROFESOR', path: 'qr_screen' },
  { role: 'COORDINADOR', path: 'qr_screen' },
  { role: 'BECARIO', path: 'qr_screen' }
];

// Las mutaciones de GraphQL también las guardo como (:Route), pero con el
// prefijo 'gql:' para no confundirlas con las pantallas de la app.
// Así el Gateway puede usar la misma consulta [:INHERITS*0..] que ya tengo
// en validarAccesoRuta para saber si un usuario puede ejecutar una mutación.
// Las públicas (login, registro, logout) no se revisan por rol.
const GRAPHQL_OPERATIONS = [
  { path: 'gql:login', title: 'Iniciar sesión', public: true },
  { path: 'gql:registrarUsuario', title: 'Registrar usuario', public: true },
  { path: 'gql:logout', title: 'Cerrar sesión', public: true },
  { path: 'gql:crearRol', title: 'Crear rol', public: false },
  { path: 'gql:cambiarRolUsuario', title: 'Cambiar rol de usuario', public: false },
  { path: 'gql:registrarEquipo', title: 'Registrar equipo', public: false },
  { path: 'gql:registrarPractica', title: 'Registrar práctica', public: false },
  { path: 'gql:crearEspacio', title: 'Crear espacio', public: false },
  { path: 'gql:activarEspacio', title: 'Activar espacio', public: false },
  { path: 'gql:desactivarEspacio', title: 'Desactivar espacio', public: false },
  { path: 'gql:crearCarrera', title: 'Crear carrera', public: false },
  { path: 'gql:crearMateria', title: 'Crear materia', public: false },
  { path: 'gql:crearPeriodo', title: 'Crear periodo', public: false },
  { path: 'gql:crearAsignacionMateria', title: 'Asignar materia', public: false },
  { path: 'gql:crearSesionHorario', title: 'Crear sesión de horario', public: false },
  { path: 'gql:actualizarSesionHorario', title: 'Actualizar sesión de horario', public: false },
  { path: 'gql:eliminarSesionHorario', title: 'Eliminar sesión de horario', public: false },
  { path: 'gql:registrarCalificacion', title: 'Registrar calificación', public: false },
  { path: 'gql:registrarFalta', title: 'Registrar falta', public: false },
  { path: 'gql:registrarExamen', title: 'Registrar examen', public: false },
  { path: 'gql:inscribirAlumno', title: 'Inscribir alumno', public: false },
  { path: 'gql:guardarPerfilAcademico', title: 'Guardar perfil académico', public: false },
  { path: 'gql:registrarHorasComplementarias', title: 'Registrar horas complementarias', public: false },
  { path: 'gql:registrarHorasBecarias', title: 'Registrar horas becarias', public: false },
  // Eventos y QR (deportes-service). Si no las doy de alta aquí, el Gateway
  // las bloquea con 403 porque cierra todo lo que no está en el catálogo.
  { path: 'gql:crearEvento', title: 'Crear evento', public: false },
  { path: 'gql:registrarAsistente', title: 'Registrar asistente a evento', public: false },
  { path: 'gql:crearQR', title: 'Generar código QR', public: false }
];

// Solo le doy el permiso al rol más bajo que lo necesita.
// Los roles de arriba lo reciben solos por la herencia, por ejemplo
// ADMIN -> ENTRENADOR, entonces ADMIN también puede registrarEquipo.
const GRAPHQL_ACCESS = [
  { role: 'ADMIN', path: 'gql:crearRol' },
  { role: 'ADMIN', path: 'gql:cambiarRolUsuario' },
  { role: 'ADMIN', path: 'gql:crearEspacio' },
  { role: 'ADMIN', path: 'gql:activarEspacio' },
  { role: 'ADMIN', path: 'gql:desactivarEspacio' },
  { role: 'ADMIN', path: 'gql:crearCarrera' },
  { role: 'ADMIN', path: 'gql:crearMateria' },
  { role: 'ADMIN', path: 'gql:crearPeriodo' },
  { role: 'ADMIN', path: 'gql:crearAsignacionMateria' },
  { role: 'ADMIN', path: 'gql:crearSesionHorario' },
  { role: 'ADMIN', path: 'gql:actualizarSesionHorario' },
  { role: 'ADMIN', path: 'gql:eliminarSesionHorario' },
  { role: 'ENTRENADOR', path: 'gql:registrarEquipo' },
  { role: 'ENTRENADOR', path: 'gql:registrarPractica' },
  { role: 'PROFESOR', path: 'gql:registrarCalificacion' },
  { role: 'PROFESOR', path: 'gql:registrarFalta' },
  { role: 'PROFESOR', path: 'gql:registrarExamen' },
  { role: 'ESTUDIANTE', path: 'gql:inscribirAlumno' },
  { role: 'ESTUDIANTE', path: 'gql:guardarPerfilAcademico' },
  { role: 'ESTUDIANTE', path: 'gql:registrarHorasComplementarias' },
  // BECARIO = coordinador de becas: él registra las horas de los estudiantes
  // becarios. El estudiante no se las registra solo. ADMIN lo hereda.
  { role: 'BECARIO', path: 'gql:registrarHorasBecarias' },
  // Crear eventos: los mismos 4 roles que ven la pantalla qr_screen
  // (ACCESS de arriba). ADMIN los hereda a todos.
  { role: 'ENTRENADOR', path: 'gql:crearEvento' },
  { role: 'PROFESOR', path: 'gql:crearEvento' },
  { role: 'COORDINADOR', path: 'gql:crearEvento' },
  { role: 'BECARIO', path: 'gql:crearEvento' },
  // Registrarse y pedir su QR lo hace el estudiante (registration_screen);
  // todos los demás roles heredan ESTUDIANTE. Que solo un gestor pueda dar
  // de alta un evento nuevo desde crearQR lo revisa deportes-service,
  // porque depende de si el evento ya existe (Neo4j no lo sabe).
  { role: 'ESTUDIANTE', path: 'gql:registrarAsistente' },
  { role: 'ESTUDIANTE', path: 'gql:crearQR' }
];

export async function seedRoutesAndAccess(driver) {
  const session = driver.session();
  try {
    await session.executeWrite(async (tx) => {
      for (const route of ROUTES) {
        await tx.run(
          `MERGE (rt:Route {path: $path})
           SET rt.title = $title, rt.public = $public`,
          route
        );
      }

      for (const { role, path } of ACCESS) {
        await tx.run(
          `MATCH (r:Role {name: $role})
           MATCH (rt:Route {path: $path})
           MERGE (r)-[:CAN_ACCESS]->(rt)`,
          { role, path }
        );
      }

      // Mismo MERGE que con las pantallas, solo que marco tipo = 'graphql'
      // para poder filtrarlas en Neo4j Browser si las quiero ver aparte.
      for (const operation of GRAPHQL_OPERATIONS) {
        await tx.run(
          `MERGE (rt:Route {path: $path})
           SET rt.title = $title, rt.public = $public, rt.tipo = 'graphql'`,
          operation
        );
      }

      for (const { role, path } of GRAPHQL_ACCESS) {
        await tx.run(
          `MATCH (r:Role {name: $role})
           MATCH (rt:Route {path: $path})
           MERGE (r)-[:CAN_ACCESS]->(rt)`,
          { role, path }
        );
      }
    });
  } finally {
    await session.close();
  }
}
