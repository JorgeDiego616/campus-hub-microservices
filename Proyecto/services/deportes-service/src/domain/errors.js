import { GraphQLError } from 'graphql';

// Error de regla de negocio (dato inválido, choque de horario, etc.).
//
// Antes el dominio lanzaba new Error(...) y Apollo lo mandaba como
// INTERNAL_SERVER_ERROR: la app no podía distinguir "escribiste mal la
// matrícula" de "se cayó el servidor". Y en producción, el Gateway oculta el
// mensaje de los INTERNAL_SERVER_ERROR, así que el usuario ni siquiera vería
// qué hizo mal. Con BAD_USER_INPUT el mensaje sí llega tal cual.
//
// No le pongo http.status (como sí tienen los 401/403) a propósito: si el
// subgrafo responde 400, el Gateway toma TODA la respuesta como fallida y
// envuelve el mensaje en "400: Bad Request". Con 200 + errors el Gateway
// pasa el error limpio y además conserva los demás campos que sí salieron.
export class ErrorDeDominio extends GraphQLError {
  constructor(mensaje) {
    super(mensaje, { extensions: { code: 'BAD_USER_INPUT' } });
    this.name = 'ErrorDeDominio';
  }
}

// El id que mandaron no existe en la BD (equipo, espacio, inscripción...).
// Mismo código NOT_FOUND que ya usa seguridad en cambiarRolUsuario.
// Tampoco lleva http.status por la misma razón de arriba.
export class RecursoNoEncontrado extends GraphQLError {
  constructor(mensaje) {
    super(mensaje, { extensions: { code: 'NOT_FOUND' } });
    this.name = 'RecursoNoEncontrado';
  }
}

// Los datos están bien escritos pero chocan con lo que ya hay guardado:
// el evento ya no tiene lugares o ya existe otro evento con ese id.
// Lo separo de BAD_USER_INPUT porque la app no lo arregla corrigiendo el
// formulario, y el adaptador REST del Gateway lo convierte en un 409.
// Sin http.status por lo mismo que los de arriba.
export class ConflictoDeNegocio extends GraphQLError {
  constructor(mensaje) {
    super(mensaje, { extensions: { code: 'CONFLICT' } });
    this.name = 'ConflictoDeNegocio';
  }
}
