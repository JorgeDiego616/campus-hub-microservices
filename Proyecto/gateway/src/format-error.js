// Limpia los errores antes de mandarlos al cliente (la app).
//
// Problema 1: cuando un subgrafo responde 401/403, el Gateway lo envolvía así:
//   { message: "401: Unauthorized",
//     extensions: { response: { url: "http://localhost:4001/", status, body } } }
// La app veía "401: Unauthorized" en lugar del mensaje real, y además se
// filtraba la URL interna del subgrafo (en la nube: http://deportes-service:4001/).
//
// Problema 2: los errores internos (ej. "Cast to ObjectId failed ... model
// Usuario") le enseñaban al cliente detalles de la BD. En producción esos
// mensajes se cambian por uno genérico y el original solo queda en el log.

export const MENSAJE_ERROR_INTERNO = 'Error interno del servidor.';

// Si el error viene envuelto por el Gateway, saco el error real del subgrafo.
function desenvolver(formattedError) {
  const interno = formattedError.extensions?.response?.body?.errors?.[0];

  if (interno) {
    return {
      message: interno.message,
      // El path sí lo dejo: le dice a la app qué campo falló.
      ...(formattedError.path ? { path: formattedError.path } : {}),
      extensions: { code: interno.extensions?.code ?? 'INTERNAL_SERVER_ERROR' }
    };
  }

  // No venía envuelto: lo copio y le quito "response" por si acaso.
  const { response, ...extensions } = formattedError.extensions ?? {};
  return { ...formattedError, extensions };
}

// produccion = true cuando NODE_ENV=production (en la nube).
// log es inyectable para poder probarlo sin ensuciar la consola.
export function crearFormatError({ produccion = false, log = console.error } = {}) {
  return (formattedError) => {
    const limpio = desenvolver(formattedError);

    if (produccion) {
      // Apollo ya quita el stacktrace en producción; lo borro igual por si acaso.
      delete limpio.extensions.stacktrace;

      if ((limpio.extensions.code ?? 'INTERNAL_SERVER_ERROR') === 'INTERNAL_SERVER_ERROR') {
        log('[gateway] Error interno ocultado al cliente:', limpio.message);
        limpio.message = MENSAJE_ERROR_INTERNO;
        limpio.extensions.code = 'INTERNAL_SERVER_ERROR';
      }
    }

    return limpio;
  };
}
