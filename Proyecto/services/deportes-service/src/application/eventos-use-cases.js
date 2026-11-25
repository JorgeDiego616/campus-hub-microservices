import crypto from 'node:crypto';

import {
  Evento,
  MODOS_QR,
  ESTADOS_TICKET,
  CAPACIDAD_POR_DEFECTO,
  textoObligatorio,
  textoOpcional,
  validarEmail,
  validarVigencia,
  validarSeguridad,
  clavePortador,
  claveUsuario,
  fechaHoraLocalCampus,
  inicioDelEvento,
  lugaresDisponibles,
  expiracionPaseDinamico
} from '../domain/evento.js';
import { ErrorDeDominio, ConflictoDeNegocio } from '../domain/errors.js';
import {
  assertCanManageEvents,
  assertPuedeVerAsistentes,
  esDuenoDelEvento
} from '../domain/authorization.js';
import { datosAuditoria } from './sports-use-cases.js';

// Casos de uso de eventos, registros de asistentes y códigos QR.
//
// Nota para mí sobre cómo usa esto la app (lo saqué de QrScreenView.kt y
// RegistrationScreenView.kt), porque explica varias decisiones de abajo:
// 1. El organizador llena el formulario y la app manda crearQR con un
//    eventoId nuevo (un UUID). Ese evento todavía no existe aquí, así que
//    crearQR lo da de alta con los datos que trae (título, categoría, sede).
// 2. La app guarda el ticketId de la respuesta como si fuera el id del
//    evento. Por eso el QR del evento usa ticketId = eventoId: así lo que
//    la app cree que es el id del evento, de verdad lo es.
// 3. Para registrar a un asistente la app vuelve a llamar crearQR con ese
//    eventoId y los datos del asistente (manda su email en student_id).
//    Como el evento ya existe, eso es una inscripción y ocupa un lugar.

// El token del QR es opaco: 32 bytes aleatorios, no lleva datos adentro
// (así lo pide el contrato de la app: nombre, facultad, etc. nunca van en el QR).
export function tokenAleatorio() {
  return crypto.randomBytes(32).toString('base64url');
}

const FORMATO_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const HORA_FIN_IMPLICITA = '23:59';

function iso(fecha) {
  return fecha ? new Date(fecha).toISOString() : null;
}

function resumenDelEvento(evento) {
  return {
    titulo: evento.titulo,
    categoria: evento.categoria,
    sede: evento.sede,
    iniciaEn: inicioDelEvento(evento)
  };
}

// Lo que se regresa por GraphQL. El qrToken del evento solo lo ve quien lo
// creó (o un ADMIN): con ese token se hace el check-in, no se lo doy a
// cualquier estudiante que liste los eventos.
export function presentarEvento(evento, actor) {
  return {
    id: evento.id,
    titulo: evento.titulo,
    categoria: evento.categoria,
    sede: evento.sede,
    fecha: evento.fecha,
    horaInicio: evento.horaInicio,
    horaFin: evento.horaFin,
    organizador: evento.organizador,
    capacidad: evento.capacidad,
    lugaresDisponibles: lugaresDisponibles(evento),
    qrToken: esDuenoDelEvento(actor, evento) ? evento.qrToken : null,
    creadoEn: iso(evento.creadoEn)
  };
}

export function presentarRegistro(registro) {
  return {
    id: registro.id,
    eventoId: registro.eventoId,
    nombreAsistente: registro.portador.nombre,
    emailAsistente: registro.portador.email ?? '',
    qrToken: registro.qrToken,
    estado: registro.estado,
    registradoEn: iso(registro.registradoEn)
  };
}

// QR del propio evento (el que el organizador pone en la entrada).
function ticketDelEvento(evento) {
  return {
    ticketId: evento.id,
    qr: { token: evento.qrToken, refreshAt: null },
    ticket: { estado: ESTADOS_TICKET.ACTIVO, usadoEn: null, usadoEnPuerta: null },
    resumenEvento: resumenDelEvento(evento),
    resumenPortador: {
      nombre: evento.organizador.nombre,
      matricula: evento.organizador.matricula,
      facultad: evento.organizador.facultad
    },
    reglasAcceso: {
      puertaEntrada: evento.puertaEntrada,
      validoDesde: iso(evento.validoDesde),
      validoHasta: iso(evento.validoHasta)
    }
  };
}

// QR de un asistente (estático) o de un usuario (pase dinámico).
function ticketDelRegistro(evento, registro) {
  const esDinamico = registro.modo === MODOS_QR.PASE_DINAMICO && registro.qrExpiraEn;

  return {
    ticketId: registro.id,
    qr: {
      token: registro.qrToken,
      // La app espera segundos unix (Long) y vuelve a pedir el QR a esa hora.
      refreshAt: esDinamico ? Math.floor(new Date(registro.qrExpiraEn).getTime() / 1000) : null
    },
    ticket: {
      estado: registro.estado,
      usadoEn: iso(registro.usadoEn),
      usadoEnPuerta: registro.usadoEnPuerta
    },
    resumenEvento: resumenDelEvento(evento),
    resumenPortador: {
      nombre: registro.portador.nombre,
      matricula: registro.portador.matricula,
      facultad: registro.portador.facultad
    },
    reglasAcceso: {
      puertaEntrada: evento.puertaEntrada,
      validoDesde: iso(registro.validoDesde),
      validoHasta: iso(registro.validoHasta)
    }
  };
}

// No dejo inscribir a nadie en un evento que ya terminó.
function asegurarEventoVigente(evento, momento) {
  if (new Date(evento.validoHasta) <= momento) {
    throw new ErrorDeDominio('El evento ya terminó; no se puede registrar a nadie.');
  }
}

function validarModo(modo) {
  if (!Object.values(MODOS_QR).includes(modo)) {
    throw new ErrorDeDominio(`El modo debe ser uno de: ${Object.values(MODOS_QR).join(', ')}.`);
  }
  return modo;
}

function validarPortador(input) {
  const matricula = textoObligatorio(input.portadorMatricula, 'portadorMatricula', 254);

  return {
    nombre: textoObligatorio(input.portadorNombre, 'portadorNombre'),
    matricula,
    facultad: textoOpcional(input.portadorFacultad, 'portadorFacultad'),
    // La app manda el email del asistente en student_id. Si parece email lo
    // guardo también como email para que salga en la lista de asistentes.
    email: FORMATO_EMAIL.test(matricula) ? matricula.toLowerCase() : null
  };
}

export function createEventosUseCases({
  repositories,
  eventPublisher,
  // Inyectables para poder probar sin azar ni reloj real (igual que el
  // publicador falso en los tests de deportes).
  generarToken = tokenAleatorio,
  generarId = () => crypto.randomUUID(),
  ahora = () => new Date()
}) {
  const { eventoRepository, registroEventoRepository } = repositories;

  async function guardarEventoNuevo(actor, datos, vigencia, operacion) {
    const evento = await eventoRepository.create({
      ...datos,
      qrToken: generarToken(),
      validoDesde: vigencia.validoDesde,
      validoHasta: vigencia.validoHasta,
      creadoPor: actor.id
    });

    await eventPublisher.publish('EVENTO_CREADO', {
      ...datosAuditoria(actor),
      operacion,
      eventoId: evento.id,
      categoria: evento.categoria,
      capacidad: evento.capacidad
    });

    return evento;
  }

  // Inscribe a una persona o regresa la inscripción que ya tenía.
  // Lo hago idempotente a propósito: si la app reintenta porque se cortó el
  // internet, no quiero que ocupe dos lugares ni que le salga error.
  async function inscribir(actor, evento, datos, operacion) {
    const existente = await registroEventoRepository.findByEventoYClave(evento.id, datos.clavePortador);
    if (existente) return existente;

    const reservado = await eventoRepository.reservarLugar(evento.id);
    if (!reservado) {
      throw new ConflictoDeNegocio('El evento ya no tiene lugares disponibles.');
    }

    let registro;
    try {
      registro = await registroEventoRepository.create({
        id: generarId(),
        eventoId: evento.id,
        qrToken: generarToken(),
        registradoPor: actor.id,
        ...datos
      });
    } catch (error) {
      // Si Mongo falló al guardar, devuelvo el lugar que ya había apartado.
      await eventoRepository.liberarLugar(evento.id);
      throw error;
    }

    if (!registro) {
      // Otra petición idéntica ganó la carrera (el índice único la frenó):
      // devuelvo mi lugar y regreso la inscripción que sí se guardó.
      await eventoRepository.liberarLugar(evento.id);
      return registroEventoRepository.findByEventoYClave(evento.id, datos.clavePortador);
    }

    // CWE-532: en auditoría solo van ids, nunca el email ni el token.
    await eventPublisher.publish('ASISTENTE_REGISTRADO', {
      ...datosAuditoria(actor),
      operacion,
      eventoId: evento.id,
      registroId: registro.id,
      modo: registro.modo
    });

    return registro;
  }

  async function crearEvento(actor, input) {
    assertCanManageEvents(actor);

    const evento = new Evento({
      id: input.id,
      titulo: input.titulo,
      categoria: input.categoria,
      sede: input.sede,
      fecha: input.fecha,
      horaInicio: input.horaInicio,
      horaFin: input.horaFin,
      organizador: {
        nombre: input.organizadorNombre,
        matricula: input.organizadorMatricula,
        facultad: input.organizadorFacultad
      },
      capacidad: input.capacidad
    });
    const datos = evento.validarDatos();

    const momento = ahora();
    const fin = evento.finDelEvento();
    if (fin <= momento) {
      throw new ErrorDeDominio('El evento ya terminó; revisa la fecha y la hora de fin.');
    }

    if (await eventoRepository.findById(datos.id)) {
      throw new ConflictoDeNegocio('Ya existe un evento con ese id.');
    }

    // El QR del evento sirve desde ahora hasta que termina el evento.
    const creado = await guardarEventoNuevo(
      actor,
      datos,
      { validoDesde: momento, validoHasta: fin },
      'crearEvento'
    );

    return presentarEvento(creado, actor);
  }

  async function registrarAsistente(actor, { eventoId, nombre, email }) {
    const evento = await eventoRepository.requireById(eventoId);

    const emailLimpio = validarEmail(email);
    const momento = ahora();
    asegurarEventoVigente(evento, momento);

    const registro = await inscribir(actor, evento, {
      clavePortador: clavePortador(emailLimpio),
      portador: {
        nombre: textoObligatorio(nombre, 'nombre'),
        matricula: '',
        facultad: '',
        email: emailLimpio
      },
      usuarioId: null,
      modo: MODOS_QR.EVENTO_ESTATICO,
      validoDesde: momento,
      validoHasta: evento.validoHasta,
      seguridad: { qrTtlSeconds: null, geofence: null }
    }, 'registrarAsistente');

    return presentarRegistro(registro);
  }

  // Cuando la app manda crearQR para un evento que todavía no existe, lo
  // creo con lo que trae. La app no manda fecha/hora/capacidad en este
  // contrato (solo valid_from), así que tomo la fecha y hora de validoDesde,
  // el fin a las 23:59 de ese día y la capacidad por defecto (100, la misma
  // que usa el formulario de la app). Con crearEvento sí se mandan completos.
  async function crearEventoDesdeQR(actor, eventoId, input, portador, vigencia) {
    const { fecha, hora } = fechaHoraLocalCampus(vigencia.validoDesde);

    const datos = new Evento({
      id: eventoId,
      titulo: input.eventoTitulo,
      categoria: input.eventoCategoria,
      sede: input.eventoSede,
      fecha,
      // Si se crea justo a las 23:59, el inicio tiene que quedar antes del fin.
      horaInicio: hora < HORA_FIN_IMPLICITA ? hora : '23:58',
      horaFin: HORA_FIN_IMPLICITA,
      organizador: portador,
      capacidad: CAPACIDAD_POR_DEFECTO
    }).validarDatos();

    return guardarEventoNuevo(actor, datos, vigencia, 'crearQR');
  }

  // El organizador vuelve a pedir el QR de su evento (en la app es "editar
  // evento"): si cambió título, categoría o sede, lo actualizo para que lo
  // que ve la app y lo que hay aquí no se separen.
  async function actualizarDatosVisibles(actor, evento, input) {
    const cambios = new Evento({
      ...evento,
      titulo: input.eventoTitulo ?? evento.titulo,
      categoria: input.eventoCategoria ?? evento.categoria,
      sede: input.eventoSede ?? evento.sede
    }).validarDatos();

    const sinCambios =
      cambios.titulo === evento.titulo &&
      cambios.categoria === evento.categoria &&
      cambios.sede === evento.sede;

    if (sinCambios) return evento;

    const actualizado = await eventoRepository.actualizarDatos(evento.id, cambios);

    await eventPublisher.publish('EVENTO_ACTUALIZADO', {
      ...datosAuditoria(actor),
      operacion: 'crearQR',
      eventoId: evento.id
    });

    return actualizado;
  }

  async function crearQR(actor, input) {
    const modo = validarModo(input.modo);
    const eventoId = textoObligatorio(input.eventoId, 'eventoId', 100);
    const vigencia = validarVigencia(input.validoDesde, input.validoHasta);
    const seguridad = validarSeguridad(input.seguridad);
    const portador = validarPortador(input);

    let evento = await eventoRepository.findById(eventoId);

    if (!evento) {
      // Dar de alta un evento es de gestores (los que ven "Crear evento / QR").
      assertCanManageEvents(actor);
      evento = await crearEventoDesdeQR(actor, eventoId, input, portador, vigencia);

      if (modo === MODOS_QR.EVENTO_ESTATICO) return ticketDelEvento(evento);
    } else if (
      modo === MODOS_QR.EVENTO_ESTATICO &&
      evento.creadoPor === actor.id &&
      clavePortador(portador.matricula) === clavePortador(evento.organizador.matricula)
    ) {
      // El mismo organizador pidiendo el QR de su evento: no es inscripción.
      evento = await actualizarDatosVisibles(actor, evento, input);
      return ticketDelEvento(evento);
    }

    // De aquí para abajo ya es inscribir a alguien.
    asegurarEventoVigente(evento, ahora());

    if (modo === MODOS_QR.EVENTO_ESTATICO) {
      const registro = await inscribir(actor, evento, {
        clavePortador: clavePortador(portador.matricula),
        portador,
        usuarioId: null,
        modo,
        validoDesde: vigencia.validoDesde,
        validoHasta: vigencia.validoHasta,
        seguridad
      }, 'crearQR');

      return ticketDelRegistro(evento, registro);
    }

    // ---------- Pase dinámico ----------
    if (input.usuarioId === undefined || input.usuarioId === null) {
      throw new ErrorDeDominio('usuarioId es obligatorio en el pase dinámico.');
    }
    const usuarioId = textoObligatorio(input.usuarioId, 'usuarioId', 100);

    // Un estudiante solo puede sacar su propio pase; para otra persona
    // tiene que ser un gestor (igual que BECARIO con las horas becarias).
    if (usuarioId !== actor.id) assertCanManageEvents(actor);

    let registro = await inscribir(actor, evento, {
      clavePortador: claveUsuario(usuarioId),
      portador,
      usuarioId,
      modo,
      validoDesde: vigencia.validoDesde,
      validoHasta: vigencia.validoHasta,
      seguridad
    }, 'crearQR');

    // Si ya se usó, se canceló o ya venció, no genero token nuevo: la app
    // muestra el estado (y "vencido" lo calcula ella con validoHasta).
    const momento = ahora();
    const validoHasta = new Date(registro.validoHasta);
    if (registro.estado !== ESTADOS_TICKET.ACTIVO || validoHasta <= momento) {
      return ticketDelRegistro(evento, { ...registro, qrExpiraEn: null });
    }

    const expira = expiracionPaseDinamico(
      momento,
      registro.seguridad?.qrTtlSeconds ?? seguridad.qrTtlSeconds,
      validoHasta
    );

    // No audito cada renovación: la app pide un QR nuevo cada ~30 s y eso
    // llenaría ScyllaDB de ruido. La emisión del pase sí quedó en
    // ASISTENTE_REGISTRADO.
    registro = await registroEventoRepository.rotarToken(registro.id, generarToken(), expira);

    return ticketDelRegistro(evento, registro);
  }

  async function eventos(actor) {
    const lista = await eventoRepository.findAll();
    return lista.map((evento) => presentarEvento(evento, actor));
  }

  async function evento(actor, id) {
    const encontrado = await eventoRepository.findById(id);
    return encontrado ? presentarEvento(encontrado, actor) : null;
  }

  async function capacidadDeEvento(id) {
    const encontrado = await eventoRepository.requireById(id);
    return {
      capacidad: encontrado.capacidad,
      lugaresDisponibles: lugaresDisponibles(encontrado)
    };
  }

  async function registrosDeEvento(actor, eventoId) {
    const encontrado = await eventoRepository.requireById(eventoId);
    assertPuedeVerAsistentes(actor, encontrado);

    const registros = await registroEventoRepository.findByEvento(eventoId);

    // Igual que calificaciones en académico: leer datos personales de otros
    // (nombres y emails) deja rastro forense.
    await eventPublisher.publish('CONSULTA_DATOS_SENSIBLES', {
      ...datosAuditoria(actor),
      resultado: 'exitoso',
      motivo: 'Consulta de asistentes de un evento',
      operacion: 'registrosDeEvento',
      metadata: {
        rol: actor.rol,
        evento_consultado: eventoId,
        total_registros: registros.length,
        recurso: 'registros_evento'
      }
    });

    return registros.map(presentarRegistro);
  }

  return {
    crearEvento,
    registrarAsistente,
    crearQR,
    eventos,
    evento,
    capacidadDeEvento,
    registrosDeEvento
  };
}
