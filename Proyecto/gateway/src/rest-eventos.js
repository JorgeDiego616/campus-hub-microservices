import { ErrorHttp, leerCuerpoJson, responderJson } from './servidor-http.js';

// Adaptador REST para el módulo de eventos/QR de la app Android.
//
// Nota para mí: la app ya tenía su contrato REST hecho (QrApi.kt) y sus
// modelos con @SerializedName en snake_case (QrModels.kt, EventModels.kt).
// En lugar de cambiar la app, aquí traduzco cada ruta REST a una operación
// GraphQL y la ejecuto en este mismo Gateway con executeOperation. Así pasa
// por todo lo de siempre: sesión en Redis, RBAC de Neo4j (las mutaciones),
// formatError y la auditoría. Este archivo no sabe nada de MongoDB; solo
// traduce nombres y convierte los errores de GraphQL en códigos HTTP.
//
// Rutas (BASE_URL de la app = http://10.0.2.2:4000/):
//   POST /qr                          CreateQrRequest   -> CreateQrResponse
//   GET  /events/{id}/capacity        -                 -> CapacityStatus
//   POST /events                      EventRequest      -> EventResponse
//   GET  /events                      -                 -> [EventResponse]
//   GET  /events/{id}                 -                 -> EventResponse
//   GET  /events/{id}/registrations   -                 -> [RegistrationResponse]
//   POST /registrations               RegistrationRequest -> RegistrationResponse

// ---------------- Catálogos app <-> GraphQL ----------------

const MODO_DESDE_APP = Object.freeze({
  static_event_checkin: 'EVENTO_ESTATICO',
  dynamic_individual_pass: 'PASE_DINAMICO'
});

const ESTADO_A_APP = Object.freeze({
  ACTIVO: 'active',
  USADO: 'used',
  CANCELADO: 'cancelled'
});

// Código de GraphQL -> status HTTP. Retrofit trata todo lo que no es 2xx
// como HttpException y la app muestra el código (error_server_code).
const STATUS_POR_CODIGO = Object.freeze({
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  BAD_USER_INPUT: 400,
  BAD_REQUEST: 400,
  GRAPHQL_VALIDATION_FAILED: 400,
  GRAPHQL_PARSE_FAILED: 400,
  SERVICE_UNAVAILABLE: 503
});

export function statusHttpDeError(error) {
  return STATUS_POR_CODIGO[error?.extensions?.code] ?? 500;
}

// ---------------- Operaciones GraphQL ----------------

const CAMPOS_EVENTO = `
  id titulo categoria sede fecha horaInicio horaFin
  organizador { nombre matricula facultad }
  capacidad lugaresDisponibles qrToken creadoEn
`;

const CAMPOS_REGISTRO = 'id eventoId nombreAsistente emailAsistente qrToken estado registradoEn';

const OPERACIONES = Object.freeze({
  crearQR: `
    mutation CrearQR($input: CrearQRInput!) {
      crearQR(input: $input) {
        ticketId
        qr { token refreshAt }
        ticket { estado usadoEn usadoEnPuerta }
        resumenEvento { titulo categoria sede iniciaEn }
        resumenPortador { nombre matricula facultad }
        reglasAcceso { puertaEntrada validoDesde validoHasta }
      }
    }`,
  capacidadDeEvento: `
    query CapacidadDeEvento($eventoId: ID!) {
      capacidadDeEvento(eventoId: $eventoId) { capacidad lugaresDisponibles }
    }`,
  crearEvento: `
    mutation CrearEvento($input: CrearEventoInput!) {
      crearEvento(input: $input) { ${CAMPOS_EVENTO} }
    }`,
  eventos: `query Eventos { eventos { ${CAMPOS_EVENTO} } }`,
  evento: `query Evento($id: ID!) { evento(id: $id) { ${CAMPOS_EVENTO} } }`,
  registrosDeEvento: `
    query RegistrosDeEvento($eventoId: ID!) {
      registrosDeEvento(eventoId: $eventoId) { ${CAMPOS_REGISTRO} }
    }`,
  registrarAsistente: `
    mutation RegistrarAsistente($input: RegistrarAsistenteInput!) {
      registrarAsistente(input: $input) { ${CAMPOS_REGISTRO} }
    }`
});

// ---------------- De la app a GraphQL ----------------

function exigirObjeto(cuerpo) {
  if (!cuerpo || Array.isArray(cuerpo) || typeof cuerpo !== 'object') {
    throw new ErrorHttp(400, 'BAD_REQUEST', 'El cuerpo debe ser un objeto JSON.');
  }
  return cuerpo;
}

// security_config: { qr_ttl_seconds, geofence: { lat, lng, radius_m } }
function seguridadDesdeApp(config) {
  if (config === undefined || config === null) return null;
  if (typeof config !== 'object') {
    throw new ErrorHttp(400, 'BAD_REQUEST', 'security_config debe ser un objeto.');
  }

  const geofence = config.geofence
    ? { lat: config.geofence.lat, lng: config.geofence.lng, radioM: config.geofence.radius_m }
    : null;

  return { qrTtlSeconds: config.qr_ttl_seconds ?? null, geofence };
}

export function crearQRDesdeApp(cuerpo) {
  const peticion = exigirObjeto(cuerpo);
  const modo = MODO_DESDE_APP[peticion.creation_mode];

  if (!modo) {
    throw new ErrorHttp(
      400,
      'BAD_REQUEST',
      `creation_mode debe ser uno de: ${Object.keys(MODO_DESDE_APP).join(', ')}.`
    );
  }

  return {
    eventoId: peticion.event_id,
    modo,
    usuarioId: peticion.user_id ?? null,
    validoDesde: peticion.valid_from,
    validoHasta: peticion.valid_until,
    seguridad: seguridadDesdeApp(peticion.security_config),
    eventoTitulo: peticion.event_title,
    eventoCategoria: peticion.event_category,
    eventoSede: peticion.event_venue,
    portadorNombre: peticion.student_name,
    portadorMatricula: peticion.student_id,
    portadorFacultad: peticion.faculty
  };
}

export function crearEventoDesdeApp(cuerpo) {
  const peticion = exigirObjeto(cuerpo);

  return {
    id: peticion.event_id,
    titulo: peticion.title,
    categoria: peticion.category,
    sede: peticion.venue,
    fecha: peticion.date,
    horaInicio: peticion.start_time,
    horaFin: peticion.end_time,
    organizadorNombre: peticion.organizer_name,
    organizadorMatricula: peticion.organizer_id,
    organizadorFacultad: peticion.organizer_faculty,
    capacidad: peticion.capacity
  };
}

export function registrarAsistenteDesdeApp(cuerpo) {
  const peticion = exigirObjeto(cuerpo);

  return {
    eventoId: peticion.event_id,
    nombre: peticion.attendee_name,
    email: peticion.attendee_email
  };
}

// ---------------- De GraphQL a la app ----------------

// CreateQrResponse. Ojo: event_summary.category va en MAYÚSCULAS porque la
// app la compara con EventCategory.name ("DEPORTIVO") en QrScreenView.
export function ticketParaApp(ticket) {
  return {
    ticket_id: ticket.ticketId,
    qr: {
      token: ticket.qr.token,
      refresh_at: ticket.qr.refreshAt ?? null
    },
    ticket: {
      status: ESTADO_A_APP[ticket.ticket.estado],
      used_at: ticket.ticket.usadoEn ?? null,
      used_at_gate: ticket.ticket.usadoEnPuerta ?? null
    },
    event_summary: {
      title: ticket.resumenEvento.titulo,
      category: ticket.resumenEvento.categoria,
      venue: ticket.resumenEvento.sede,
      starts_at: ticket.resumenEvento.iniciaEn
    },
    user_summary: ticket.resumenPortador
      ? {
        student_name: ticket.resumenPortador.nombre,
        student_id: ticket.resumenPortador.matricula,
        faculty: ticket.resumenPortador.facultad
      }
      : null,
    access_rules: {
      entry_gate: ticket.reglasAcceso.puertaEntrada,
      valid_from: ticket.reglasAcceso.validoDesde,
      valid_until: ticket.reglasAcceso.validoHasta
    }
  };
}

export function capacidadParaApp(capacidad) {
  return {
    capacity_limit: capacidad.capacidad,
    spots_remaining: capacidad.lugaresDisponibles
  };
}

// EventResponse. Aquí la categoría va en minúsculas porque Gson la lee con
// el @SerializedName del enum ("deportivo"). qr_token en la app no es
// nullable: si el usuario no es el dueño, mando "" en vez de null para que
// Kotlin no truene al leerlo.
export function eventoParaApp(evento) {
  return {
    event_id: evento.id,
    title: evento.titulo,
    category: evento.categoria.toLowerCase(),
    venue: evento.sede,
    date: evento.fecha,
    start_time: evento.horaInicio,
    end_time: evento.horaFin,
    organizer_name: evento.organizador.nombre,
    organizer_id: evento.organizador.matricula,
    organizer_faculty: evento.organizador.facultad,
    capacity: evento.capacidad,
    qr_token: evento.qrToken ?? '',
    created_at: evento.creadoEn
  };
}

export function registroParaApp(registro) {
  return {
    registration_id: registro.id,
    event_id: registro.eventoId,
    attendee_name: registro.nombreAsistente,
    attendee_email: registro.emailAsistente,
    qr_token: registro.qrToken,
    ticket_status: ESTADO_A_APP[registro.estado],
    registered_at: registro.registradoEn
  };
}

// ---------------- Rutas ----------------

const RUTAS = [
  {
    metodo: 'POST',
    patron: /^\/qr$/,
    operacion: 'crearQR',
    variables: (_params, cuerpo) => ({ input: crearQRDesdeApp(cuerpo) }),
    respuesta: (data) => ticketParaApp(data.crearQR),
    status: 200
  },
  {
    metodo: 'GET',
    patron: /^\/events\/([^/]+)\/capacity$/,
    operacion: 'capacidadDeEvento',
    variables: ([eventoId]) => ({ eventoId }),
    respuesta: (data) => capacidadParaApp(data.capacidadDeEvento)
  },
  {
    metodo: 'GET',
    patron: /^\/events\/([^/]+)\/registrations$/,
    operacion: 'registrosDeEvento',
    variables: ([eventoId]) => ({ eventoId }),
    respuesta: (data) => data.registrosDeEvento.map(registroParaApp)
  },
  {
    metodo: 'GET',
    patron: /^\/events\/([^/]+)$/,
    operacion: 'evento',
    variables: ([id]) => ({ id }),
    respuesta: (data) => (data.evento ? eventoParaApp(data.evento) : null)
  },
  {
    metodo: 'GET',
    patron: /^\/events$/,
    operacion: 'eventos',
    variables: () => ({}),
    respuesta: (data) => data.eventos.map(eventoParaApp)
  },
  {
    metodo: 'POST',
    patron: /^\/events$/,
    operacion: 'crearEvento',
    variables: (_params, cuerpo) => ({ input: crearEventoDesdeApp(cuerpo) }),
    respuesta: (data) => eventoParaApp(data.crearEvento),
    status: 201
  },
  {
    metodo: 'POST',
    patron: /^\/registrations$/,
    operacion: 'registrarAsistente',
    variables: (_params, cuerpo) => ({ input: registrarAsistenteDesdeApp(cuerpo) }),
    respuesta: (data) => registroParaApp(data.registrarAsistente),
    status: 201
  }
];

// "/events/abc/" -> "/events/abc". Retrofit no manda la diagonal final,
// pero así no importa si alguien la pone a mano en Postman.
function normalizarRuta(url) {
  const ruta = new URL(url ?? '/', 'http://localhost').pathname;
  return ruta.length > 1 ? ruta.replace(/\/+$/, '') : ruta;
}

export function buscarRuta(metodo, url) {
  const ruta = normalizarRuta(url);
  const coincidencias = RUTAS
    .map((definicion) => ({ definicion, match: ruta.match(definicion.patron) }))
    .filter(({ match }) => match);

  if (coincidencias.length === 0) return null;

  const exacta = coincidencias.find(({ definicion }) => definicion.metodo === metodo);
  if (!exacta) {
    // La ruta existe pero con otro método (ej. GET /qr) -> 405.
    return { permitidos: [...new Set(coincidencias.map(({ definicion }) => definicion.metodo))] };
  }

  let params;
  try {
    params = exacta.match.slice(1).map((valor) => decodeURIComponent(valor));
  } catch {
    throw new ErrorHttp(400, 'BAD_REQUEST', 'El id de la ruta no es válido.');
  }

  return { definicion: exacta.definicion, params };
}

function responderError(res, status, codigo, mensaje) {
  responderJson(res, status, { error: { code: codigo, message: mensaje } });
}

// ejecutarOperacion(query, variables, contextValue) -> { data, errors }
// construirContexto(req) -> el mismo contexto que usa GraphQL (sesión, IP).
export function crearManejadorRest({ ejecutarOperacion, construirContexto }) {
  return async function manejarRest(req, res) {
    const metodo = (req.method ?? 'GET').toUpperCase();

    let encontrada;
    try {
      encontrada = buscarRuta(metodo === 'HEAD' ? 'GET' : metodo, req.url);
    } catch (error) {
      if (!(error instanceof ErrorHttp)) throw error;
      responderError(res, error.status, error.codigo, error.message);
      return true;
    }

    // No es una ruta REST: que siga a GraphQL.
    if (!encontrada) return false;

    if (!encontrada.definicion) {
      res.setHeader('allow', encontrada.permitidos.join(', '));
      responderError(res, 405, 'METHOD_NOT_ALLOWED', 'Método no permitido en esta ruta.');
      return true;
    }

    const { definicion, params } = encontrada;

    let variables;
    try {
      const cuerpo = definicion.metodo === 'POST'
        ? await leerCuerpoJson(req, { exigirJson: true })
        : undefined;
      variables = definicion.variables(params, cuerpo);
    } catch (error) {
      if (!(error instanceof ErrorHttp)) throw error;
      responderError(res, error.status, error.codigo, error.message);
      return true;
    }

    const contexto = await construirContexto(req);
    const { data, errors } = await ejecutarOperacion(
      OPERACIONES[definicion.operacion],
      variables,
      contexto
    );

    if (errors?.length) {
      const primero = errors[0];
      responderError(
        res,
        statusHttpDeError(primero),
        primero.extensions?.code ?? 'INTERNAL_SERVER_ERROR',
        primero.message
      );
      return true;
    }

    const cuerpoRespuesta = definicion.respuesta(data);
    if (cuerpoRespuesta === null) {
      responderError(res, 404, 'NOT_FOUND', 'El evento no existe.');
      return true;
    }

    responderJson(res, definicion.status ?? 200, cuerpoRespuesta);
    return true;
  };
}
