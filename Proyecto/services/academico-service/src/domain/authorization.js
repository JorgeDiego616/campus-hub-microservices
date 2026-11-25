import { GraphQLError } from 'graphql';

export const Roles = Object.freeze({
  ESTUDIANTE: 'ESTUDIANTE',
  BECARIO: 'BECARIO',
  PROFESOR: 'PROFESOR',
  ADMIN: 'ADMIN'
});

// Antes lanzaba new Error(...) y Apollo lo mandaba como INTERNAL_SERVER_ERROR (500).
// Con GraphQLError puedo decir el código real: 401 si no hay sesión y 403 si no tiene
// permiso, igual que en deportes y mapa. Los mensajes los dejo iguales.
function unauthenticated(message) {
  return new GraphQLError(message, {
    extensions: { code: 'UNAUTHENTICATED', http: { status: 401 } }
  });
}

// La exporto porque los casos de uso también necesitan lanzar 403
// (antes ahí usaban new Error y salía como 500).
export function forbidden(message) {
  return new GraphQLError(message, {
    extensions: { code: 'FORBIDDEN', http: { status: 403 } }
  });
}

export function requireActor(actor) {
  if (!actor?.id || !actor?.rol) throw unauthenticated('Se requiere una identidad autenticada.');
}

// Solo el propio ESTUDIANTE (o ADMIN) ve/modifica sus datos académicos.
// BECARIO ya no entra aquí: es el coordinador de becas, no un alumno, y por
// mínimo privilegio no consulta calificaciones, inscripciones ni faltas.
export function assertCanAccessStudent(actor, alumnoId) {
  requireActor(actor);
  if (actor.rol === Roles.ADMIN) return;
  if (actor.rol !== Roles.ESTUDIANTE || String(actor.id) !== String(alumnoId)) {
    throw forbidden('No tienes permiso para consultar esta información académica.');
  }
}

export function assertCanManageCatalog(actor) {
  requireActor(actor);
  if (actor.rol !== Roles.ADMIN) throw forbidden('Solo ADMIN puede administrar catálogos académicos.');
}

export function assertProfessorOwnsAssignment(actor, asignacion) {
  requireActor(actor);
  if (actor.rol === Roles.ADMIN) return;
  if (actor.rol !== Roles.PROFESOR || String(actor.id) !== String(asignacion.profesorId)) {
    throw forbidden('El profesor no tiene asignada esta materia o grupo.');
  }
}

export function assertCanRegisterHours(actor, alumnoId) {
  assertCanAccessStudent(actor, alumnoId);
}

// BECARIO = coordinador de becas. Él registra las horas becarias de cualquier
// estudiante (por eso aquí NO comparo actor.id con alumnoId). ADMIN también.
// El estudiante no puede registrarse sus propias horas becarias.
// En Neo4j el permiso gql:registrarHorasBecarias es de BECARIO; esto es la segunda capa.
export function assertCanRegisterScholarshipHours(actor) {
  requireActor(actor);
  if (actor.rol !== Roles.ADMIN && actor.rol !== Roles.BECARIO) {
    throw forbidden('Solo el coordinador de becas (BECARIO) o ADMIN puede registrar horas becarias.');
  }
}
