import assert from 'node:assert/strict';
import test from 'node:test';

import {
  Evento,
  normalizarCategoriaEvento,
  validarSeguridad,
  validarVigencia,
  expiracionPaseDinamico,
  fechaHoraLocalCampus,
  inicioDelEvento
} from '../src/domain/evento.js';
import { createEventosUseCases } from '../src/application/eventos-use-cases.js';
import { assertCanManageEvents } from '../src/domain/authorization.js';

// Pruebas de eventos y QR sin MongoDB ni RabbitMQ: los repositorios son
// arreglos en memoria que se portan como los de Mongoose (incluido el
// "índice único" y la reserva de lugar), igual que en eventos-auditoria.test.js.

const AHORA = new Date('2026-11-24T18:00:00Z'); // 12:00 en CDMX
const entrenador = { id: 'coach-1', rol: 'ENTRENADOR', ip_origen: '189.2.3.4', jti: 'sesion-1' };
const otroEntrenador = { id: 'coach-2', rol: 'ENTRENADOR' };
const estudiante = { id: 'alumno-1', rol: 'ESTUDIANTE' };
const admin = { id: 'admin-1', rol: 'ADMIN' };

function crearRepositorios() {
  const eventos = new Map();
  const registros = [];

  const eventoRepository = {
    async create(evento) {
      if (eventos.has(evento.id)) throw new Error('duplicado');
      const guardado = { ...evento, inscritos: 0, creadoEn: AHORA };
      eventos.set(evento.id, guardado);
      return { ...guardado };
    },
    async findById(id) {
      return eventos.has(id) ? { ...eventos.get(id) } : null;
    },
    async requireById(id) {
      const evento = await this.findById(id);
      if (!evento) {
        const { RecursoNoEncontrado } = await import('../src/domain/errors.js');
        throw new RecursoNoEncontrado('El evento no existe.');
      }
      return evento;
    },
    async findAll() {
      return [...eventos.values()].map((evento) => ({ ...evento }));
    },
    async actualizarDatos(id, cambios) {
      Object.assign(eventos.get(id), cambios);
      return { ...eventos.get(id) };
    },
    async reservarLugar(id) {
      const evento = eventos.get(id);
      if (!evento || evento.inscritos >= evento.capacidad) return null;
      evento.inscritos += 1;
      return { ...evento };
    },
    async liberarLugar(id) {
      const evento = eventos.get(id);
      if (evento && evento.inscritos > 0) evento.inscritos -= 1;
    }
  };

  const registroEventoRepository = {
    async findByEventoYClave(eventoId, clave) {
      const registro = registros.find((r) => r.eventoId === eventoId && r.clavePortador === clave);
      return registro ? { ...registro } : null;
    },
    async findByEvento(eventoId) {
      return registros.filter((r) => r.eventoId === eventoId).map((r) => ({ ...r }));
    },
    async create(registro) {
      if (registros.some((r) => r.eventoId === registro.eventoId && r.clavePortador === registro.clavePortador)) {
        return null; // como el índice único de Mongo
      }
      const guardado = { ...registro, estado: 'ACTIVO', usadoEn: null, usadoEnPuerta: null, registradoEn: AHORA };
      registros.push(guardado);
      return { ...guardado };
    },
    async rotarToken(registroId, qrToken, qrExpiraEn) {
      const registro = registros.find((r) => r.id === registroId);
      Object.assign(registro, { qrToken, qrExpiraEn });
      return { ...registro };
    }
  };

  return { eventos, registros, eventoRepository, registroEventoRepository };
}

function crearCasosDeUso() {
  const repos = crearRepositorios();
  const publicados = [];
  let contador = 0;

  const useCases = createEventosUseCases({
    repositories: repos,
    eventPublisher: { async publish(event, payload) { publicados.push({ event, payload }); } },
    generarToken: () => `token-${++contador}`,
    generarId: () => `reg-${++contador}`,
    ahora: () => new Date(AHORA)
  });

  return { useCases, repos, publicados };
}

// Lo mismo que manda QrScreenView al crear el evento.
function qrDelOrganizador(extra = {}) {
  return {
    eventoId: 'evt-uuid-1',
    modo: 'EVENTO_ESTATICO',
    usuarioId: null,
    validoDesde: '2026-11-24T18:00:00Z',
    validoHasta: '2026-12-24T18:00:00Z',
    seguridad: { qrTtlSeconds: null, geofence: null },
    eventoTitulo: 'ULSA Classic 2026',
    eventoCategoria: 'DEPORTIVO', // la app manda category.name
    eventoSede: 'La Salle Stadium',
    portadorNombre: 'Jorge Chaparro',
    portadorMatricula: '14446',
    portadorFacultad: 'Engineering',
    ...extra
  };
}

// Lo mismo que manda RegistrationScreenView (email en student_id, faculty "").
function qrDeAsistente(eventoId, email, extra = {}) {
  return qrDelOrganizador({
    eventoId,
    validoHasta: '2026-11-25T18:00:00Z',
    portadorNombre: 'Ana Asistente',
    portadorMatricula: email,
    portadorFacultad: '',
    ...extra
  });
}

// ---------------- Dominio ----------------

test('la categoría acepta "deportivo", "DEPORTIVO", "Académico" y rechaza lo demás', () => {
  assert.equal(normalizarCategoriaEvento('deportivo'), 'DEPORTIVO');
  assert.equal(normalizarCategoriaEvento('DEPORTIVO'), 'DEPORTIVO');
  assert.equal(normalizarCategoriaEvento('Académico'), 'ACADEMICO');
  assert.equal(normalizarCategoriaEvento('cultural artistica'), 'CULTURAL_ARTISTICA');
  assert.equal(normalizarCategoriaEvento('Soccer'), null);
  assert.equal(normalizarCategoriaEvento(undefined), null);
});

test('Evento.validarDatos limpia los datos y valida fecha, horas y capacidad', () => {
  const base = {
    id: ' evt-1 ', titulo: ' Clásico ', categoria: 'deportivo', sede: 'Estadio',
    fecha: '2026-12-01', horaInicio: '18:00', horaFin: '20:00',
    organizador: { nombre: 'Jorge', matricula: '14446', facultad: 'Ingeniería' }, capacidad: 50
  };

  const datos = new Evento(base).validarDatos();
  assert.equal(datos.id, 'evt-1');
  assert.equal(datos.titulo, 'Clásico');
  assert.equal(datos.categoria, 'DEPORTIVO');
  assert.equal(datos.capacidad, 50);

  const falla = (cambios, patron) => assert.throws(
    () => new Evento({ ...base, ...cambios }).validarDatos(),
    (e) => e.extensions.code === 'BAD_USER_INPUT' && patron.test(e.message)
  );

  falla({ fecha: '2026-02-30' }, /no existe/);
  falla({ fecha: '01/12/2026' }, /AAAA-MM-DD/);
  falla({ horaInicio: '8:00' }, /HH:mm/);
  falla({ horaFin: '17:00' }, /posterior/);
  falla({ capacidad: 0 }, /capacidad/);
  falla({ categoria: 'Soccer' }, /DEPORTIVO, ACADEMICO, CULTURAL_ARTISTICA/);
  falla({ titulo: '   ' }, /titulo/);

  // Sin capacidad usa la misma que el formulario de la app.
  assert.equal(new Evento({ ...base, capacidad: undefined }).validarDatos().capacidad, 100);
});

test('vigencia, seguridad (geofence todo o nada) y expiración del pase dinámico', () => {
  assert.throws(() => validarVigencia('2026-12-02T00:00:00Z', '2026-12-01T00:00:00Z'), /posterior/);
  assert.throws(() => validarVigencia('ayer', '2026-12-01T00:00:00Z'), /ISO 8601/);

  assert.deepEqual(validarSeguridad(null), { qrTtlSeconds: null, geofence: null });
  assert.throws(() => validarSeguridad({ qrTtlSeconds: 5 }), /qrTtlSeconds/);
  assert.throws(() => validarSeguridad({ geofence: { lat: 19.4, lng: -99.1 } }), /geofence/);
  assert.deepEqual(
    validarSeguridad({ qrTtlSeconds: 60, geofence: { lat: 19.4, lng: -99.1, radioM: 150 } }),
    { qrTtlSeconds: 60, geofence: { lat: 19.4, lng: -99.1, radioM: 150 } }
  );

  // El TTL nunca pasa de validoHasta (límite duro del ticket).
  const limite = new Date(AHORA.getTime() + 10_000);
  assert.equal(expiracionPaseDinamico(AHORA, 30, limite).getTime(), limite.getTime());
  assert.equal(expiracionPaseDinamico(AHORA, null, new Date('2030-01-01')).getTime(), AHORA.getTime() + 30_000);
});

test('las fechas se manejan en hora de CDMX (para que la app no vea el día siguiente)', () => {
  assert.deepEqual(fechaHoraLocalCampus(new Date('2026-12-02T00:30:00Z')), { fecha: '2026-12-01', hora: '18:30' });
  assert.equal(inicioDelEvento({ fecha: '2026-12-01', horaInicio: '18:00' }), '2026-12-01T18:00:00-06:00');
});

test('crear eventos es de ENTRENADOR, PROFESOR, COORDINADOR, BECARIO y ADMIN', () => {
  for (const rol of ['ENTRENADOR', 'PROFESOR', 'COORDINADOR', 'BECARIO', 'ADMIN']) {
    assert.doesNotThrow(() => assertCanManageEvents({ id: 'x', rol }));
  }
  assert.throws(() => assertCanManageEvents(estudiante), (e) => e.extensions.code === 'FORBIDDEN');
  assert.throws(() => assertCanManageEvents(null), (e) => e.extensions.code === 'UNAUTHENTICATED');
});

// ---------------- Flujos de la app ----------------

test('QrScreenView: crearQR con un evento nuevo lo da de alta y regresa su QR (ticketId = eventoId)', async () => {
  const { useCases, repos, publicados } = crearCasosDeUso();

  const ticket = await useCases.crearQR(entrenador, qrDelOrganizador());

  assert.equal(ticket.ticketId, 'evt-uuid-1'); // la app lo guarda como id del evento
  assert.equal(ticket.qr.token, 'token-1');
  assert.equal(ticket.qr.refreshAt, null);
  assert.equal(ticket.ticket.estado, 'ACTIVO');
  assert.deepEqual(ticket.resumenEvento, {
    titulo: 'ULSA Classic 2026', categoria: 'DEPORTIVO', sede: 'La Salle Stadium',
    iniciaEn: '2026-11-24T12:00:00-06:00'
  });
  assert.deepEqual(ticket.resumenPortador, { nombre: 'Jorge Chaparro', matricula: '14446', facultad: 'Engineering' });
  assert.equal(ticket.reglasAcceso.validoHasta, '2026-12-24T18:00:00.000Z');

  const guardado = repos.eventos.get('evt-uuid-1');
  assert.equal(guardado.capacidad, 100);
  assert.equal(guardado.creadoPor, 'coach-1');
  assert.equal(guardado.inscritos, 0); // el QR del evento no ocupa lugar

  assert.equal(publicados[0].event, 'EVENTO_CREADO');
  assert.equal(publicados[0].payload.usuario_id, 'coach-1');
  assert.equal(publicados[0].payload.ip_origen, '189.2.3.4');
});

test('un estudiante no puede dar de alta un evento desde crearQR', async () => {
  const { useCases, repos } = crearCasosDeUso();

  await assert.rejects(
    useCases.crearQR(estudiante, qrDelOrganizador()),
    (e) => e.extensions.code === 'FORBIDDEN'
  );
  assert.equal(repos.eventos.size, 0);
});

test('editar en la app: el organizador vuelve a pedir su QR y se actualizan título/sede sin inscribirlo', async () => {
  const { useCases, repos, publicados } = crearCasosDeUso();
  await useCases.crearQR(entrenador, qrDelOrganizador());

  const ticket = await useCases.crearQR(entrenador, qrDelOrganizador({ eventoTitulo: 'Clásico (editado)', eventoSede: 'Gimnasio' }));

  assert.equal(ticket.ticketId, 'evt-uuid-1');
  assert.equal(ticket.qr.token, 'token-1'); // mismo QR del evento
  assert.equal(ticket.resumenEvento.titulo, 'Clásico (editado)');
  assert.equal(repos.eventos.get('evt-uuid-1').inscritos, 0);
  assert.equal(repos.registros.length, 0);
  assert.ok(publicados.some((p) => p.event === 'EVENTO_ACTUALIZADO'));
});

test('RegistrationScreenView: crearQR sobre un evento existente inscribe al asistente y ocupa un lugar', async () => {
  const { useCases, repos, publicados } = crearCasosDeUso();
  await useCases.crearQR(entrenador, qrDelOrganizador());

  const ticket = await useCases.crearQR(estudiante, qrDeAsistente('evt-uuid-1', 'Ana@Test.com'));

  assert.notEqual(ticket.ticketId, 'evt-uuid-1');
  assert.notEqual(ticket.qr.token, 'token-1'); // token propio, no el del evento
  assert.equal(ticket.resumenPortador.nombre, 'Ana Asistente');
  assert.equal(ticket.resumenEvento.titulo, 'ULSA Classic 2026'); // datos guardados, no el eco
  assert.equal(repos.eventos.get('evt-uuid-1').inscritos, 1);
  assert.equal(repos.registros[0].portador.email, 'ana@test.com');

  const evento = publicados.find((p) => p.event === 'ASISTENTE_REGISTRADO');
  assert.ok(evento);
  // CWE-532: nada de email ni token en la auditoría.
  assert.equal(JSON.stringify(evento.payload).includes('ana@test.com'), false);
  assert.equal(JSON.stringify(evento.payload).includes(ticket.qr.token), false);
});

test('registrar dos veces a la misma persona regresa el mismo ticket y no ocupa otro lugar', async () => {
  const { useCases, repos } = crearCasosDeUso();
  await useCases.crearQR(entrenador, qrDelOrganizador());

  const primero = await useCases.crearQR(estudiante, qrDeAsistente('evt-uuid-1', 'ana@test.com'));
  const segundo = await useCases.crearQR(estudiante, qrDeAsistente('evt-uuid-1', 'ANA@test.com'));
  const porEmail = await useCases.registrarAsistente(estudiante, { eventoId: 'evt-uuid-1', nombre: 'Ana', email: 'ana@test.com' });

  assert.equal(segundo.ticketId, primero.ticketId);
  assert.equal(porEmail.id, primero.ticketId); // misma clave aunque entre por otra ruta
  assert.equal(repos.eventos.get('evt-uuid-1').inscritos, 1);
});

test('con el cupo lleno responde CONFLICT y no se pasa de la capacidad', async () => {
  const { useCases, repos } = crearCasosDeUso();
  await useCases.crearEvento(entrenador, {
    id: 'evt-chico', titulo: 'Taller', categoria: 'academico', sede: 'Aula 1',
    fecha: '2026-12-01', horaInicio: '10:00', horaFin: '12:00',
    organizadorNombre: 'Jorge', organizadorMatricula: '14446', capacidad: 1
  });

  await useCases.registrarAsistente(estudiante, { eventoId: 'evt-chico', nombre: 'Uno', email: 'uno@test.com' });

  await assert.rejects(
    useCases.registrarAsistente(estudiante, { eventoId: 'evt-chico', nombre: 'Dos', email: 'dos@test.com' }),
    (e) => e.extensions.code === 'CONFLICT' && /lugares/.test(e.message)
  );
  assert.equal(repos.eventos.get('evt-chico').inscritos, 1);
  assert.deepEqual(await useCases.capacidadDeEvento('evt-chico'), { capacidad: 1, lugaresDisponibles: 0 });
});

test('crearEvento: datos completos de la app, id repetido = CONFLICT y evento pasado = BAD_USER_INPUT', async () => {
  const { useCases } = crearCasosDeUso();
  const input = {
    id: 'evt-2', titulo: 'Concierto', categoria: 'cultural_artistica', sede: 'Auditorio',
    fecha: '2026-12-10', horaInicio: '18:00', horaFin: '20:00',
    organizadorNombre: 'Jorge', organizadorMatricula: '14446', organizadorFacultad: 'Ingeniería', capacidad: 300
  };

  const creado = await useCases.crearEvento(entrenador, input);
  assert.equal(creado.categoria, 'CULTURAL_ARTISTICA');
  assert.equal(creado.lugaresDisponibles, 300);
  assert.equal(creado.qrToken, 'token-1'); // lo ve porque es el dueño
  assert.equal(creado.creadoEn, AHORA.toISOString());

  await assert.rejects(useCases.crearEvento(entrenador, input), (e) => e.extensions.code === 'CONFLICT');
  await assert.rejects(
    useCases.crearEvento(entrenador, { ...input, id: 'evt-viejo', fecha: '2026-11-01' }),
    (e) => e.extensions.code === 'BAD_USER_INPUT' && /terminó/.test(e.message)
  );
  await assert.rejects(useCases.crearEvento(estudiante, { ...input, id: 'evt-3' }), (e) => e.extensions.code === 'FORBIDDEN');
});

test('el qrToken del evento solo lo ve su dueño o un ADMIN al listar', async () => {
  const { useCases } = crearCasosDeUso();
  await useCases.crearQR(entrenador, qrDelOrganizador());

  assert.equal((await useCases.eventos(estudiante))[0].qrToken, null);
  assert.equal((await useCases.eventos(otroEntrenador))[0].qrToken, null);
  assert.equal((await useCases.eventos(entrenador))[0].qrToken, 'token-1');
  assert.equal((await useCases.evento(admin, 'evt-uuid-1')).qrToken, 'token-1');
  assert.equal(await useCases.evento(estudiante, 'no-existe'), null);
});

test('la lista de asistentes solo la ve el dueño o ADMIN, y deja rastro forense', async () => {
  const { useCases, publicados } = crearCasosDeUso();
  await useCases.crearQR(entrenador, qrDelOrganizador());
  await useCases.registrarAsistente(estudiante, { eventoId: 'evt-uuid-1', nombre: 'Ana', email: 'ana@test.com' });

  await assert.rejects(useCases.registrosDeEvento(estudiante, 'evt-uuid-1'), (e) => e.extensions.code === 'FORBIDDEN');
  await assert.rejects(useCases.registrosDeEvento(otroEntrenador, 'evt-uuid-1'), (e) => e.extensions.code === 'FORBIDDEN');

  const lista = await useCases.registrosDeEvento(entrenador, 'evt-uuid-1');
  assert.equal(lista.length, 1);
  assert.equal(lista[0].emailAsistente, 'ana@test.com');
  assert.equal((await useCases.registrosDeEvento(admin, 'evt-uuid-1')).length, 1);

  assert.ok(publicados.some((p) => p.event === 'CONSULTA_DATOS_SENSIBLES' && p.payload.operacion === 'registrosDeEvento'));
});

test('pase dinámico: refreshAt en segundos unix, token nuevo en cada petición y un solo lugar', async () => {
  const { useCases, repos } = crearCasosDeUso();
  await useCases.crearQR(entrenador, qrDelOrganizador());

  const pase = qrDeAsistente('evt-uuid-1', '14446', {
    modo: 'PASE_DINAMICO', usuarioId: 'alumno-1', seguridad: { qrTtlSeconds: 60 }
  });

  const primero = await useCases.crearQR(estudiante, pase);
  const segundo = await useCases.crearQR(estudiante, pase);

  assert.equal(primero.qr.refreshAt, Math.floor(AHORA.getTime() / 1000) + 60);
  assert.notEqual(segundo.qr.token, primero.qr.token); // el token viejo deja de servir
  assert.equal(segundo.ticketId, primero.ticketId);
  assert.equal(repos.eventos.get('evt-uuid-1').inscritos, 1);
});

test('pase dinámico: sin usuarioId es BAD_USER_INPUT y un estudiante no saca el pase de otro', async () => {
  const { useCases } = crearCasosDeUso();
  await useCases.crearQR(entrenador, qrDelOrganizador());

  await assert.rejects(
    useCases.crearQR(estudiante, qrDeAsistente('evt-uuid-1', '14446', { modo: 'PASE_DINAMICO' })),
    (e) => e.extensions.code === 'BAD_USER_INPUT' && /usuarioId/.test(e.message)
  );
  await assert.rejects(
    useCases.crearQR(estudiante, qrDeAsistente('evt-uuid-1', '14446', { modo: 'PASE_DINAMICO', usuarioId: 'otro-alumno' })),
    (e) => e.extensions.code === 'FORBIDDEN'
  );
});

test('capacidad y registro de un evento que no existe dan NOT_FOUND', async () => {
  const { useCases } = crearCasosDeUso();

  await assert.rejects(useCases.capacidadDeEvento('no-existe'), (e) => e.extensions.code === 'NOT_FOUND');
  await assert.rejects(
    useCases.registrarAsistente(estudiante, { eventoId: 'no-existe', nombre: 'Ana', email: 'ana@test.com' }),
    (e) => e.extensions.code === 'NOT_FOUND'
  );
});
