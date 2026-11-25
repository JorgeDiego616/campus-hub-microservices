import http from 'node:http';
import { HeaderMap } from '@apollo/server';

// Servidor HTTP del Gateway.
//
// Antes usaba startStandaloneServer de Apollo, pero ese servidor contesta
// TODAS las rutas como GraphQL: un POST /qr de la app Android llegaba a
// Apollo y salía como error de GraphQL. La app de QR habla REST
// (POST /qr, GET /events/{id}/capacity) y no la puedo cambiar.
//
// Aquí hago lo mismo que hace startStandaloneServer por dentro (CORS, leer el
// JSON y llamar a executeHTTPGraphQLRequest, que es API pública de Apollo),
// pero antes le pregunto al adaptador REST si la ruta es suya.
// No usé Express para no meter dependencias nuevas solo por unas rutas.

// Apollo dejaba hasta 50 MB por petición. Una query o un formulario de la
// app pesan unos KB, así que 1 MB sobra y evita que alguien me llene la RAM.
export const LIMITE_CUERPO_BYTES = 1024 * 1024;

export class ErrorHttp extends Error {
  constructor(status, codigo, mensaje) {
    super(mensaje);
    this.name = 'ErrorHttp';
    this.status = status;
    this.codigo = codigo;
  }
}

function esJson(contentType) {
  if (typeof contentType !== 'string') return false;
  const tipo = contentType.split(';')[0].trim().toLowerCase();
  return tipo === 'application/json' || tipo.endsWith('+json');
}

// Igual que el body-parser que usa Apollo: si no es JSON no leo nada
// (Apollo decide qué contestar), cuerpo vacío = {} y solo acepto objeto o
// arreglo en la raíz.
export async function leerCuerpoJson(req, { limite = LIMITE_CUERPO_BYTES, exigirJson = false } = {}) {
  const metodo = (req.method ?? 'GET').toUpperCase();
  if (metodo === 'GET' || metodo === 'HEAD') return undefined;

  if (!esJson(req.headers['content-type'])) {
    if (exigirJson) {
      throw new ErrorHttp(415, 'UNSUPPORTED_MEDIA_TYPE', 'El cuerpo debe ser JSON (Content-Type: application/json).');
    }
    return undefined;
  }

  const partes = [];
  let total = 0;

  for await (const parte of req) {
    total += parte.length;
    if (total > limite) {
      throw new ErrorHttp(413, 'PAYLOAD_TOO_LARGE', 'El cuerpo de la petición es demasiado grande.');
    }
    partes.push(parte);
  }

  const texto = Buffer.concat(partes).toString('utf8');
  if (texto.trim().length === 0) return {};

  let cuerpo;
  try {
    cuerpo = JSON.parse(texto);
  } catch {
    throw new ErrorHttp(400, 'BAD_REQUEST', 'El cuerpo no es JSON válido.');
  }

  if (cuerpo === null || typeof cuerpo !== 'object') {
    throw new ErrorHttp(400, 'BAD_REQUEST', 'El cuerpo JSON debe ser un objeto.');
  }

  return cuerpo;
}

export function responderJson(res, status, cuerpo) {
  const texto = JSON.stringify(cuerpo);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('content-length', Buffer.byteLength(texto));
  res.end(texto);
}

// Mismo comportamiento que cors() con sus valores por defecto (lo que traía
// startStandaloneServer): cualquier origen, y en el preflight regreso los
// headers que pidió el navegador. Lo necesita Apollo Sandbox en el navegador;
// a la app Android no le afecta. Regresa true si ya contestó (OPTIONS).
export function aplicarCors(req, res) {
  res.setHeader('access-control-allow-origin', '*');

  if ((req.method ?? '').toUpperCase() !== 'OPTIONS') return false;

  res.setHeader('access-control-allow-methods', 'GET,HEAD,PUT,PATCH,POST,DELETE');
  const pedidos = req.headers['access-control-request-headers'];
  if (pedidos) {
    res.setHeader('access-control-allow-headers', pedidos);
    res.setHeader('vary', 'Access-Control-Request-Headers');
  }
  res.statusCode = 204;
  res.setHeader('content-length', '0');
  res.end();
  return true;
}

async function atenderGraphQL(apollo, construirContexto, req, res) {
  let cuerpo;
  try {
    cuerpo = await leerCuerpoJson(req);
  } catch (error) {
    if (error instanceof ErrorHttp) {
      responderJson(res, error.status, { errors: [{ message: error.message, extensions: { code: error.codigo } }] });
      return;
    }
    throw error;
  }

  const headers = new HeaderMap();
  for (const [clave, valor] of Object.entries(req.headers)) {
    if (valor !== undefined) {
      headers.set(clave, Array.isArray(valor) ? valor.join(', ') : valor);
    }
  }

  const respuesta = await apollo.executeHTTPGraphQLRequest({
    httpGraphQLRequest: {
      method: (req.method ?? 'GET').toUpperCase(),
      headers,
      search: new URL(req.url ?? '/', 'http://localhost').search,
      body: cuerpo
    },
    context: () => construirContexto(req)
  });

  for (const [clave, valor] of respuesta.headers) {
    res.setHeader(clave, valor);
  }
  res.statusCode = respuesta.status || 200;

  if (respuesta.body.kind === 'complete') {
    res.end(respuesta.body.string);
    return;
  }

  // Respuestas por partes (@defer); el Gateway hoy no las usa, pero
  // startStandaloneServer las soportaba y no quiero quitar nada.
  for await (const pedazo of respuesta.body.asyncIterator) {
    res.write(pedazo);
  }
  res.end();
}

// El servidor se crea vacío y el manejador se le pega después
// (servidor.on('request', ...)). Así lo pide Apollo: el plugin de drain
// necesita el servidor ANTES de crear el ApolloServer, y el manejador
// necesita el ApolloServer ya creado.
export function crearServidorHttp() {
  return http.createServer();
}

// manejadorRest(req, res) regresa true si la ruta era suya y ya contestó.
// Si regresa false, la petición sigue a GraphQL como siempre.
export function crearManejadorHttp({ apollo, construirContexto, manejadorRest = async () => false }) {
  return (req, res) => {
    (async () => {
      if (aplicarCors(req, res)) return;
      if (await manejadorRest(req, res)) return;
      await atenderGraphQL(apollo, construirContexto, req, res);
    })().catch((error) => {
      console.error('[gateway] Error no controlado en HTTP:', error);
      if (!res.headersSent) {
        responderJson(res, 500, { errors: [{ message: 'Error interno del servidor.', extensions: { code: 'INTERNAL_SERVER_ERROR' } }] });
      } else {
        res.end();
      }
    });
  };
}
