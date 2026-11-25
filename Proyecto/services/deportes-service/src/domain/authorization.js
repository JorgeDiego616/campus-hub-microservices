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