import { GraphQLError } from 'graphql';

// Reglas de quién puede hacer qué dentro de seguridad-service.
// Los demás servicios ya tenían su domain/authorization.js; seguridad tenía
// los "if (rol !== 'ADMIN')" regados en index.js. Lo saco aquí para poder
// probarlo sin levantar Mongo, Redis ni Neo4j.

export const ROL_ADMIN = 'ADMIN';

// Rol con el que entra cualquiera que se registra solo (desde la app).
export const ROL_REGISTRO_PUBLICO = 'ESTUDIANTE';

export function noAutenticado() {
  return new GraphQLError('No autenticado.', {
    extensions: { code: 'UNAUTHENTICATED', http: { status: 401 } }
  });
}

export function prohibido(mensaje) {
  return new GraphQLError(mensaje, {
    extensions: { code: 'FORBIDDEN', http: { status: 403 } }
  });
}

export function esAdmin(actor) {
  return actor?.rol === ROL_ADMIN;
}

export function requireActor(actor) {
  if (!actor?.id || !actor?.rol) throw noAutenticado();
}

// --------------------------------------------------
// REGISTRO
// --------------------------------------------------

// Antes registrarUsuario era pública Y aceptaba el rol que mandara el
// cliente, entonces cualquiera podía registrarse como ADMIN.
// Ahora: si no mandan rol (o viene vacío) queda como ESTUDIANTE.
// La app sigue mandando rol: "ESTUDIANTE", así que para ella no cambia nada.
export function rolSolicitadoEnRegistro(rol) {
  const normalizado = typeof rol === 'string' ? rol.trim().toUpperCase() : '';
  return normalizado || ROL_REGISTRO_PUBLICO;
}

// Solo un ADMIN con sesión activa puede dar de alta a alguien con otro rol
// (por ejemplo un PROFESOR). Si no, el resolver lo bloquea y lo audita.
export function puedeRegistrarConRol(rol, actor) {
  return rol === ROL_REGISTRO_PUBLICO || esAdmin(actor);
}

// --------------------------------------------------
// CONSULTAS DE USUARIOS
// --------------------------------------------------

// allUsuarios regresaba los 18 usuarios (email, matrícula, rol) sin token.
// La lista completa solo la ve el ADMIN.
export function assertPuedeListarUsuarios(actor) {
  requireActor(actor);
  if (!esAdmin(actor)) {
    throw prohibido('Solo un ADMIN puede ver la lista de usuarios.');
  }
}

// Cada quien puede ver su propio perfil; el ADMIN puede ver el de cualquiera.
export function assertPuedeVerUsuario(actor, usuarioId) {
  requireActor(actor);
  if (actor.id !== usuarioId && !esAdmin(actor)) {
    throw prohibido('Solo puedes consultar tu propio usuario.');
  }
}
