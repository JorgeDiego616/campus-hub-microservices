import assert from 'node:assert/strict';
import test from 'node:test';

import {
  crearQRDesdeApp,
  crearEventoDesdeApp,
  ticketParaApp,
  eventoParaApp,
  registroParaApp,
  statusHttpDeError,
  buscarRuta,
  crearManejadorRest
} from '../src/rest-eventos.js';
import { crearServidorHttp, crearManejadorHttp, LIMITE_CUERPO_BYTES } from '../src/servidor-http.js';

// Pruebas del adaptador REST de eventos/QR y del servidor HTTP del Gateway.
// No levanto Apollo ni los subgrafos: ejecutarOperacion y Apollo son falsos,
// pero el servidor HTTP sí es real (puerto libre) para probar rutas y JSON.

// Lo que manda la app en POST /qr (QrScreenView.kt).
const peticionQrApp = {
  event_id: 'evt-uuid-1',
  creation_mode: 'static_event_checkin',
  user_id: null,
  valid_from: '2026-11-24T18:00:00Z',
  valid_until: '2026-12-24T18:00:00Z',
  security_config: { qr_ttl_seconds: null, geofence: null },
  event_title: 'ULSA Classic 2026',
  event_category: 'DEPORTIVO',
  event_venue: 'La Salle Stadium',
  student_name: 'Jorge Chaparro',
  student_id: '14446',
  faculty: 'Engineering'
};

const ticketGraphQL = {
  ticketId: 'evt-uuid-1',
  qr: { token: 'tok', refreshAt: null },
  ticket: { estado: 'ACTIVO', usadoEn: null, usadoEnPuerta: null },
  resumenEvento: { titulo: 'ULSA Classic 2026', categoria: 'DEPORTIVO', sede: 'La Salle Stadium', iniciaEn: '2026-11-24T12:00:00-06:00' },
  resumenPortador: { nombre: 'Jorge Chaparro', matricula: '14446', facultad: 'Engineering' },
  reglasAcceso: { puertaEntrada: 'Puerta principal', validoDesde: '2026-11-24T18:00:00.000Z', validoHasta: '2026-12-24T18:00:00.000Z' }
};

const eventoGraphQL = {
  id: 'evt-2', titulo: 'Concierto', categoria: 'CULTURAL_ARTISTICA', sede: 'Auditorio',
  fecha: '2026-12-10', horaInicio: '18:00', horaFin: '20:00',
  organizador: { nombre: 'Jorge', matricula: '14446', facultad: 'Ingeniería' },
  capacidad: 300, lugaresDisponibles: 299, qrToken: null, creadoEn: '2026-11-24T18:00:00.000Z'
};

// ---------------- Traducción de nombres ----------------

test('POST /qr: el JSON snake_case de la app se traduce al input de GraphQL', () => {
  assert.deepEqual(crearQRDesdeApp(peticionQrApp), {
    eventoId: 'evt-uuid-1',
    modo: 'EVENTO_ESTATICO',
    usuarioId: null,
    validoDesde: '2026-11-24T18:00:00Z',
    validoHasta: '2026-12-24T18:00:00Z',
    seguridad: { qrTtlSeconds: null, geofence: null },
    eventoTitulo: 'ULSA Classic 2026',
    eventoCategoria: 'DEPORTIVO',
    eventoSede: 'La Salle Stadium',
    portadorNombre: 'Jorge Chaparro',
    portadorMatricula: '14446',
    portadorFacultad: 'Engineering'
  });

  const dinamico = crearQRDesdeApp({
    ...peticionQrApp,
    creation_mode: 'dynamic_individual_pass',
    user_id: 'u-1',
    security_config: { qr_ttl_seconds: 30, geofence: { lat: 19.4, lng: -99.1, radius_m: 100 } }
  });
  assert.equal(dinamico.modo, 'PASE_DINAMICO');
  assert.deepEqual(dinamico.seguridad, { qrTtlSeconds: 30, geofence: { lat: 19.4, lng: -99.1, radioM: 100 } });

  assert.throws(() => crearQRDesdeApp({ ...peticionQrApp, creation_mode: 'otro' }), (e) => e.status === 400);
  assert.throws(() => crearQRDesdeApp([]), (e) => e.status === 400);
});

test('la respuesta del QR tiene exactamente la forma de CreateQrResponse', () => {
  assert.deepEqual(ticketParaApp(ticketGraphQL), {
    ticket_id: 'evt-uuid-1',
    qr: { token: 'tok', refresh_at: null },
    ticket: { status: 'active', used_at: null, used_at_gate: null },
    // MAYÚSCULAS: QrScreenView la compara con EventCategory.name
    event_summary: { title: 'ULSA Classic 2026', category: 'DEPORTIVO', venue: 'La Salle Stadium', starts_at: '2026-11-24T12:00:00-06:00' },
    user_summary: { student_name: 'Jorge Chaparro', student_id: '14446', faculty: 'Engineering' },
    access_rules: { entry_gate: 'Puerta principal', valid_from: '2026-11-24T18:00:00.000Z', valid_until: '2026-12-24T18:00:00.000Z' }
  });

  assert.equal(ticketParaApp({ ...ticketGraphQL, resumenPortador: null }).user_summary, null);
  assert.equal(ticketParaApp({ ...ticketGraphQL, ticket: { estado: 'CANCELADO' } }).ticket.status, 'cancelled');
});

test('EventResponse y RegistrationResponse: categoría en minúsculas y qr_token nunca null', () => {
  const evento = eventoParaApp(eventoGraphQL);
  assert.equal(evento.category, 'cultural_artistica'); // @SerializedName del enum
  assert.equal(evento.qr_token, ''); // Kotlin lo tiene como String no-null
  assert.equal(evento.organizer_id, '14446');
  assert.equal(evento.created_at, '2026-11-24T18:00:00.000Z');

  assert.deepEqual(crearEventoDesdeApp({
    event_id: 'e', title: 't', category: 'deportivo', venue: 'v', date: '2026-12-01',
    start_time: '18:00', end_time: '20:00', organizer_name: 'n', organizer_id: 'i', organizer_faculty: 'f', capacity: 100
  }), {
    id: 'e', titulo: 't', categoria: 'deportivo', sede: 'v', fecha: '2026-12-01', horaInicio: '18:00', horaFin: '20:00',
    organizadorNombre: 'n', organizadorMatricula: 'i', organizadorFacultad: 'f', capacidad: 100
  });

  assert.deepEqual(registroParaApp({
    id: 'r-1', eventoId: 'e', nombreAsistente: 'Ana', emailAsistente: 'ana@test.com',
    qrToken: 'tok', estado: 'USADO', registradoEn: '2026-11-24T18:00:00.000Z'
  }), {
    registration_id: 'r-1', event_id: 'e', attendee_name: 'Ana', attendee_email: 'ana@test.com',
    qr_token: 'tok', ticket_status: 'used', registered_at: '2026-11-24T18:00:00.000Z'
  });
});

test('códigos de GraphQL -> status HTTP (Retrofit los ve como HttpException)', () => {
  const con = (code) => ({ extensions: { code } });
  assert.equal(statusHttpDeError(con('UNAUTHENTICATED')), 401);
  assert.equal(statusHttpDeError(con('FORBIDDEN')), 403);
  assert.equal(statusHttpDeError(con('NOT_FOUND')), 404);
  assert.equal(statusHttpDeError(con('CONFLICT')), 409);
  assert.equal(statusHttpDeError(con('BAD_USER_INPUT')), 400);
  assert.equal(statusHttpDeError(con('SERVICE_UNAVAILABLE')), 503);
  assert.equal(statusHttpDeError(con('INTERNAL_SERVER_ERROR')), 500);
  assert.equal(statusHttpDeError({}), 500);
});

test('buscarRuta: rutas de la app, id decodificado, 405 y lo demás sigue a GraphQL', () => {
  assert.equal(buscarRuta('POST', '/qr').definicion.operacion, 'crearQR');
  assert.equal(buscarRuta('GET', '/events/evt%201/capacity').params[0], 'evt 1');
  assert.equal(buscarRuta('GET', '/events/abc/').definicion.operacion, 'evento');
  assert.equal(buscarRuta('GET', '/events').definicion.operacion, 'eventos');
  assert.equal(buscarRuta('POST', '/events').definicion.operacion, 'crearEvento');
  assert.equal(buscarRuta('GET', '/events/abc/registrations').definicion.operacion, 'registrosDeEvento');
  assert.deepEqual(buscarRuta('GET', '/qr'), { permitidos: ['POST'] });

  // GraphQL vive en "/" (y Apollo contesta cualquier otra ruta): no es REST.
  assert.equal(buscarRuta('POST', '/'), null);
  assert.equal(buscarRuta('GET', '/?query=%7B__typename%7D'), null);
  assert.equal(buscarRuta('POST', '/graphql'), null);

  assert.throws(() => buscarRuta('GET', '/events/%E0%A4%A/capacity'), (e) => e.status === 400);
});

// ---------------- Servidor HTTP real con dependencias falsas ----------------

async function levantar({ resultado, apolloRespuesta } = {}) {
  const llamadas = { rest: [], graphql: [] };

  const apollo = {
    async executeHTTPGraphQLRequest({ httpGraphQLRequest, context }) {
      llamadas.graphql.push({ ...httpGraphQLRequest, contexto: await context() });
      return apolloRespuesta ?? {
        status: 200,
        headers: new Map([['content-type', 'application/json; charset=utf-8']]),
        body: { kind: 'complete', string: '{"data":{"__typename":"Query"}}' }
      };
    }
  };

  const construirContexto = async (req) => ({ authorization: req.headers.authorization ?? null });

  const ejecutarOperacion = async (query, variables, contexto) => {
    llamadas.rest.push({ query, variables, contexto });
    return typeof resultado === 'function' ? resultado(query, variables) : resultado;
  };

  const servidor = crearServidorHttp();
  servidor.on('request', crearManejadorHttp({
    apollo,
    construirContexto,
    manejadorRest: crearManejadorRest({ ejecutarOperacion, construirContexto })
  }));
  await new Promise((resolve) => servidor.listen(0, '127.0.0.1', resolve));

  const base = `http://127.0.0.1:${servidor.address().port}`;
  return { base, llamadas, cerrar: () => new Promise((resolve) => servidor.close(resolve)) };
}

test('POST /qr de punta a punta: lleva el token al contexto y regresa el JSON de la app', async () => {
  const { base, llamadas, cerrar } = await levantar({ resultado: { data: { crearQR: ticketGraphQL } } });
  try {
    const respuesta = await fetch(`${base}/qr`, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=UTF-8', authorization: 'Bearer abc' },
      body: JSON.stringify(peticionQrApp)
    });

    assert.equal(respuesta.status, 200);
    assert.match(respuesta.headers.get('content-type'), /application\/json/);
    const cuerpo = await respuesta.json();
    assert.equal(cuerpo.ticket_id, 'evt-uuid-1');
    assert.equal(cuerpo.ticket.status, 'active');

    assert.equal(llamadas.rest.length, 1);
    assert.match(llamadas.rest[0].query, /mutation CrearQR/);
    assert.equal(llamadas.rest[0].variables.input.modo, 'EVENTO_ESTATICO');
    assert.equal(llamadas.rest[0].contexto.authorization, 'Bearer abc');
    assert.equal(llamadas.graphql.length, 0); // no se fue a GraphQL
  } finally {
    await cerrar();
  }
});

test('errores de GraphQL salen con su status HTTP y { error: { code, message } }', async () => {
  const casos = [
    ['UNAUTHENTICATED', 401],
    ['FORBIDDEN', 403],
    ['NOT_FOUND', 404],
    ['CONFLICT', 409],
    ['BAD_USER_INPUT', 400]
  ];

  for (const [code, status] of casos) {
    const { base, cerrar } = await levantar({
      resultado: { data: null, errors: [{ message: `mensaje ${code}`, extensions: { code } }] }
    });
    try {
      const respuesta = await fetch(`${base}/events/evt-1/capacity`);
      assert.equal(respuesta.status, status);
      assert.deepEqual(await respuesta.json(), { error: { code, message: `mensaje ${code}` } });
    } finally {
      await cerrar();
    }
  }
});

test('GET /events/{id}/capacity y GET /events/{id} inexistente (404)', async () => {
  const { base, cerrar } = await levantar({
    resultado: (query) => (query.includes('capacidadDeEvento')
      ? { data: { capacidadDeEvento: { capacidad: 500, lugaresDisponibles: 137 } } }
      : { data: { evento: null } })
  });
  try {
    const capacidad = await fetch(`${base}/events/evt-1/capacity`);
    assert.deepEqual(await capacidad.json(), { capacity_limit: 500, spots_remaining: 137 });

    const evento = await fetch(`${base}/events/no-existe`);
    assert.equal(evento.status, 404);
    assert.equal((await evento.json()).error.code, 'NOT_FOUND');
  } finally {
    await cerrar();
  }
});

test('POST /events y POST /registrations responden 201', async () => {
  const { base, cerrar } = await levantar({
    resultado: (query) => (query.includes('crearEvento')
      ? { data: { crearEvento: eventoGraphQL } }
      : { data: { registrarAsistente: { id: 'r-1', eventoId: 'evt-2', nombreAsistente: 'Ana', emailAsistente: 'ana@test.com', qrToken: 't', estado: 'ACTIVO', registradoEn: 'x' } } })
  });
  try {
    const json = { 'content-type': 'application/json' };
    const evento = await fetch(`${base}/events`, { method: 'POST', headers: json, body: JSON.stringify({ event_id: 'evt-2' }) });
    assert.equal(evento.status, 201);
    assert.equal((await evento.json()).event_id, 'evt-2');

    const registro = await fetch(`${base}/registrations`, { method: 'POST', headers: json, body: JSON.stringify({ event_id: 'evt-2' }) });
    assert.equal(registro.status, 201);
    assert.equal((await registro.json()).ticket_status, 'active');
  } finally {
    await cerrar();
  }
});

test('peticiones REST mal formadas: JSON roto 400, sin JSON 415, método equivocado 405', async () => {
  const { base, llamadas, cerrar } = await levantar({ resultado: { data: {} } });
  try {
    const roto = await fetch(`${base}/qr`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{roto' });
    assert.equal(roto.status, 400);

    const texto = await fetch(`${base}/qr`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'hola' });
    assert.equal(texto.status, 415);

    const metodo = await fetch(`${base}/qr`);
    assert.equal(metodo.status, 405);
    assert.equal(metodo.headers.get('allow'), 'POST');

    const enorme = await fetch(`${base}/qr`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ relleno: 'x'.repeat(LIMITE_CUERPO_BYTES + 1) })
    }).catch(() => null); // el servidor puede cortar la conexión al pasarse
    if (enorme) assert.equal(enorme.status, 413);

    assert.equal(llamadas.rest.length, 0); // nada de eso llegó a GraphQL
  } finally {
    await cerrar();
  }
});

test('GraphQL sigue igual: POST / con JSON y GET con query string llegan a Apollo', async () => {
  const { base, llamadas, cerrar } = await levantar();
  try {
    const post = await fetch(`${base}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer abc' },
      body: JSON.stringify({ query: '{ __typename }' })
    });
    assert.equal(post.status, 200);
    assert.deepEqual(await post.json(), { data: { __typename: 'Query' } });

    assert.equal(llamadas.graphql[0].method, 'POST');
    assert.deepEqual(llamadas.graphql[0].body, { query: '{ __typename }' });
    assert.equal(llamadas.graphql[0].headers.get('authorization'), 'Bearer abc');
    assert.equal(llamadas.graphql[0].contexto.authorization, 'Bearer abc');

    await fetch(`${base}/?query=%7B__typename%7D`);
    assert.equal(llamadas.graphql[1].method, 'GET');
    assert.equal(llamadas.graphql[1].search, '?query=%7B__typename%7D');
    assert.equal(llamadas.graphql[1].body, undefined);

    assert.equal(llamadas.rest.length, 0);
  } finally {
    await cerrar();
  }
});

test('CORS como antes: preflight 204 con los headers pedidos y allow-origin en todo', async () => {
  const { base, llamadas, cerrar } = await levantar();
  try {
    const preflight = await fetch(`${base}/`, {
      method: 'OPTIONS',
      headers: {
        origin: 'https://studio.apollographql.com',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type,authorization'
      }
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), '*');
    assert.equal(preflight.headers.get('access-control-allow-headers'), 'content-type,authorization');
    assert.equal(llamadas.graphql.length, 0);

    const normal = await fetch(`${base}/`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(normal.headers.get('access-control-allow-origin'), '*');
  } finally {
    await cerrar();
  }
});
