import { GraphQLError } from 'graphql';

export const Roles = Object.freeze({
  ADMIN: 'ADMIN',
  PROFESOR: 'PROFESOR',
  ENTRENADOR: 'ENTRENADOR',
  COORDINADOR: 'COORDINADOR',
  BECARIO: 'BECARIO',
  ESTUDIANTE: 'ESTUDIANTE'
});

// Copia de las relaciones [:INHERITS] de Neo4j (rol -> roles que hereda).
// La decisión principal ya la toma el Gateway con Neo4j; esto es la segunda
// capa por si alguien llama al subgrafo directo. Le faltaba COORDINADOR.
// BECARIO = coordinador de becas (nivel 2), ADMIN también lo hereda.
const ROLE_INHERITANCE = Object.freeze({
  ADMIN: ['PROFESOR', 'ENTRENADOR', 'COORDINADOR', 'BECARIO'],
  PROFESOR: ['ESTUDIANTE'],
  ENTRENADOR: ['ESTUDIANTE'],
  COORDINADOR: ['ESTUDIANTE'],
  BECARIO: ['ESTUDIANTE'],
  ESTUDIANTE: []
});

export function effectiveRoles(actor) {
  if (Array.isArray(actor?.roles) && actor.roles.length > 0) {
    return new Set(actor.roles);
  }

  const result = new Set();
  const visit = (rol) => {
    if (!rol || result.has(rol)) return;
    result.add(rol);
    for (const padre of ROLE_INHERITANCE[rol] ?? []) visit(padre);
  };
  visit(actor?.rol);
  return result;
}

export function requireActor(actor) {
  if (!actor?.id || !actor?.rol) {
    throw new GraphQLError('Se requiere una identidad autenticada.', {
      extensions: { code: 'UNAUTHENTICATED', http: { status: 401 } }
    });
  }
}

export function assertAnyRole(actor, permitidos) {
  requireActor(actor);
  const roles = effectiveRoles(actor);
  if (!permitidos.some((rol) => roles.has(rol))) {
    throw new GraphQLError('No tienes permiso para realizar esta operación.', {
      extensions: { code: 'FORBIDDEN', http: { status: 403 } }
    });
  }
}

export function assertCanReadSports(actor) {
  requireActor(actor);
}

export function assertCanManageSports(actor) {
  assertAnyRole(actor, [Roles.ADMIN, Roles.ENTRENADOR]);
}

// ---------------- Eventos y QR ----------------

// Los mismos roles que en Neo4j pueden entrar a la pantalla "Crear evento / QR"
// (qr_screen en neo4j-routes.js). ADMIN los hereda a todos.
// BECARIO aquí es el coordinador de becas (staff), no un alumno con beca.
export const GESTORES_EVENTOS = Object.freeze([
  Roles.ENTRENADOR,
  Roles.PROFESOR,
  Roles.COORDINADOR,
  Roles.BECARIO
]);

export function puedeGestionarEventos(actor) {
  if (!actor?.id || !actor?.rol) return false;
  const roles = effectiveRoles(actor);
  return GESTORES_EVENTOS.some((rol) => roles.has(rol));
}

// Ver eventos y su capacidad: cualquiera con sesión (el estudiante entra a
// registration_screen para inscribirse).
export function assertCanReadEvents(actor) {
  requireActor(actor);
}

export function assertCanManageEvents(actor) {
  assertAnyRole(actor, GESTORES_EVENTOS);
}

// La lista de asistentes trae nombres y emails (datos personales), así que
// solo la ve quien creó el evento o un ADMIN. Mínimo privilegio: otro
// entrenador no tiene por qué ver los asistentes de un evento ajeno.
export function esDuenoDelEvento(actor, evento) {
  if (!actor?.id || !evento) return false;
  return evento.creadoPor === actor.id || effectiveRoles(actor).has(Roles.ADMIN);
}

export function assertPuedeVerAsistentes(actor, evento) {
  requireActor(actor);
  if (!esDuenoDelEvento(actor, evento)) {
    throw new GraphQLError('Solo quien creó el evento o un ADMIN puede ver sus asistentes.', {
      extensions: { code: 'FORBIDDEN', http: { status: 403 } }
    });
  }
}