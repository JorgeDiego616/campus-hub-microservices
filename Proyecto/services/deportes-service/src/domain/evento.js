import { ErrorDeDominio } from './errors.js';

// Reglas de negocio de los eventos y sus códigos QR.
//
// Nota para mí: la app Android ya tenía todo el módulo de QR hecho, pero con
// un mock (MockQrApi) porque aquí no existían eventos, registros ni tickets.
// Los nombres de los campos y los catálogos salen de los modelos de la app
// (QrModels.kt y EventModels.kt) para que el contrato no cambie.
// Igual que horario.js en académico: funciones puras, sin MongoDB, para
// poder probarlas sin levantar nada.

// Mismo catálogo que el enum EventCategory de la app.
export const CATEGORIAS_EVENTO = Object.freeze(['DEPORTIVO', 'ACADEMICO', 'CULTURAL_ARTISTICA']);

// static_event_checkin / dynamic_individual_pass en la app.
export const MODOS_QR = Object.freeze({
  EVENTO_ESTATICO: 'EVENTO_ESTATICO',
  PASE_DINAMICO: 'PASE_DINAMICO'
});

// active / used / cancelled en la app. "expired" no existe a propósito:
// la app lo calcula comparando la hora contra validoHasta.
export const ESTADOS_TICKET = Object.freeze({
  ACTIVO: 'ACTIVO',
  USADO: 'USADO',
  CANCELADO: 'CANCELADO'
});

// La app usa 100 como capacidad por defecto en el formulario.
export const CAPACIDAD_POR_DEFECTO = 100;
export const CAPACIDAD_MAXIMA = 100000;

// Vida del QR de un pase dinámico. Si no mandan qr_ttl_seconds uso 30 s;
// menos de 10 s no le da tiempo al escáner y más de 1 h ya no es "dinámico".
export const QR_TTL_POR_DEFECTO = 30;
export const QR_TTL_MINIMO = 10;
export const QR_TTL_MAXIMO = 3600;

export const PUERTA_POR_DEFECTO = 'Puerta principal';

// El campus está en CDMX. Desde 2022 México ya no tiene horario de verano,
// así que el desfase es fijo. Lo necesito para convertir "fecha + hora" del
// formulario (hora local) a un instante real.
export const ZONA_HORARIA_CAMPUS = '-06:00';
const DESFASE_CAMPUS_MS = -6 * 60 * 60 * 1000;

const FORMATO_FECHA = /^\d{4}-\d{2}-\d{2}$/;
const FORMATO_HORA = /^([01]\d|2[0-3]):[0-5]\d$/;
const FORMATO_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/; // el mismo de seguridad-service

// La app manda la categoría de dos formas: "deportivo" (EventRequest, por el
// @SerializedName) y "DEPORTIVO" (CreateQrRequest, porque usa category.name).
// También acepto "Académico" o "cultural artistica" para no ser tan estricto
// con lo que escriba una persona en Apollo Sandbox.
export function normalizarCategoriaEvento(valor) {
  if (typeof valor !== 'string') return null;

  const limpia = valor
    .trim()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // quita acentos
    .toUpperCase()
    .replace(/[\s-]+/g, '_');

  return CATEGORIAS_EVENTO.includes(limpia) ? limpia : null;
}

export function textoObligatorio(valor, campo, maximo = 120) {
  if (typeof valor !== 'string' || valor.trim().length === 0) {
    throw new ErrorDeDominio(`El campo ${campo} es obligatorio.`);
  }

  const limpio = valor.trim();
  if (limpio.length > maximo) {
    throw new ErrorDeDominio(`El campo ${campo} no puede pasar de ${maximo} caracteres.`);
  }

  return limpio;
}

// Igual que textoObligatorio, pero aquí vacío sí vale (la app manda
// faculty = "" cuando registra a un asistente).
export function textoOpcional(valor, campo, maximo = 120) {
  if (valor === undefined || valor === null) return '';
  if (typeof valor !== 'string') {
    throw new ErrorDeDominio(`El campo ${campo} debe ser texto.`);
  }

  const limpio = valor.trim();
  if (limpio.length > maximo) {
    throw new ErrorDeDominio(`El campo ${campo} no puede pasar de ${maximo} caracteres.`);
  }

  return limpio;
}

export function validarEmail(valor) {
  const email = textoObligatorio(valor, 'email', 254).toLowerCase();
  if (!FORMATO_EMAIL.test(email)) {
    throw new ErrorDeDominio('El email del asistente no tiene un formato válido.');
  }
  return email;
}

export function validarCapacidad(valor) {
  if (valor === undefined || valor === null) return CAPACIDAD_POR_DEFECTO;

  if (!Number.isInteger(valor) || valor < 1 || valor > CAPACIDAD_MAXIMA) {
    throw new ErrorDeDominio(`La capacidad debe ser un entero entre 1 y ${CAPACIDAD_MAXIMA}.`);
  }

  return valor;
}

// Recibe un texto ISO (como lo manda la app: "2026-10-06T00:00:00Z").
export function validarInstante(valor, campo) {
  if (typeof valor !== 'string' || valor.trim().length === 0) {
    throw new ErrorDeDominio(`El campo ${campo} es obligatorio.`);
  }

  const fecha = new Date(valor);
  if (Number.isNaN(fecha.getTime())) {
    throw new ErrorDeDominio(`El campo ${campo} debe ser una fecha ISO 8601 válida.`);
  }

  return fecha;
}

// validoHasta es el límite duro del ticket (así lo dice el contrato de la app),
// entonces tiene que ser después de validoDesde.
export function validarVigencia(validoDesde, validoHasta) {
  const desde = validarInstante(validoDesde, 'validoDesde');
  const hasta = validarInstante(validoHasta, 'validoHasta');

  if (hasta <= desde) {
    throw new ErrorDeDominio('validoHasta debe ser posterior a validoDesde.');
  }

  return { validoDesde: desde, validoHasta: hasta };
}

// "2026-12-01" + "18:00" (hora de CDMX) -> instante real.
export function instanteLocalCampus(fecha, hora) {
  return new Date(`${fecha}T${hora}:00${ZONA_HORARIA_CAMPUS}`);
}

// Lo contrario: un instante -> fecha y hora como se ven en el campus.
// Lo uso cuando la app crea el evento desde el QR y solo manda valid_from.
export function fechaHoraLocalCampus(instante) {
  const local = new Date(instante.getTime() + DESFASE_CAMPUS_MS).toISOString();
  return { fecha: local.slice(0, 10), hora: local.slice(11, 16) };
}

// La app toma la fecha de starts_at con substringBefore("T"). Si lo mandara
// en UTC, un evento a las 18:00 en CDMX saldría con el día siguiente
// (00:00Z). Por eso lo mando con el desfase del campus.
export function inicioDelEvento(evento) {
  return `${evento.fecha}T${evento.horaInicio}:00${ZONA_HORARIA_CAMPUS}`;
}

function validarFecha(fecha) {
  if (typeof fecha !== 'string' || !FORMATO_FECHA.test(fecha)) {
    throw new ErrorDeDominio('La fecha del evento debe tener el formato AAAA-MM-DD.');
  }

  // "2026-02-30" pasa el regex pero no existe: Date lo recorre al 2 de marzo.
  const comprobada = new Date(`${fecha}T00:00:00Z`);
  if (Number.isNaN(comprobada.getTime()) || comprobada.toISOString().slice(0, 10) !== fecha) {
    throw new ErrorDeDominio('La fecha del evento no existe.');
  }
}

function validarHora(hora, campo) {
  if (typeof hora !== 'string' || !FORMATO_HORA.test(hora)) {
    throw new ErrorDeDominio(`El campo ${campo} debe tener el formato HH:mm.`);
  }
}

// security_config de la app. El geofence es todo o nada: si viene, vienen
// lat, lng y radio. Lo valida el escáner del staff, aquí solo lo guardo.
export function validarSeguridad(seguridad) {
  if (!seguridad) return { qrTtlSeconds: null, geofence: null };

  let qrTtlSeconds = null;
  if (seguridad.qrTtlSeconds !== undefined && seguridad.qrTtlSeconds !== null) {
    const ttl = seguridad.qrTtlSeconds;
    if (!Number.isInteger(ttl) || ttl < QR_TTL_MINIMO || ttl > QR_TTL_MAXIMO) {
      throw new ErrorDeDominio(
        `qrTtlSeconds debe ser un entero entre ${QR_TTL_MINIMO} y ${QR_TTL_MAXIMO}.`
      );
    }
    qrTtlSeconds = ttl;
  }

  let geofence = null;
  if (seguridad.geofence) {
    const { lat, lng, radioM } = seguridad.geofence;
    const valido =
      Number.isFinite(lat) && lat >= -90 && lat <= 90 &&
      Number.isFinite(lng) && lng >= -180 && lng <= 180 &&
      Number.isInteger(radioM) && radioM >= 1 && radioM <= 10000;

    if (!valido) {
      throw new ErrorDeDominio(
        'El geofence necesita lat (-90 a 90), lng (-180 a 180) y radioM (1 a 10000).'
      );
    }
    geofence = { lat, lng, radioM };
  }

  return { qrTtlSeconds, geofence };
}

// Clave para no registrar dos veces a la misma persona en un evento.
// La app manda el email del asistente en student_id, por eso no le pongo
// prefijo: así "registrar por email" y "registrar por QR" dan la misma clave.
// El pase dinámico sí va por id de usuario y lleva prefijo para no chocar.
export function clavePortador(identificador) {
  return String(identificador).trim().toLowerCase();
}

export function claveUsuario(usuarioId) {
  return `usuario:${String(usuarioId).trim()}`;
}

export class Evento {
  constructor({
    id,
    titulo,
    categoria,
    sede,
    fecha,
    horaInicio,
    horaFin,
    organizador,
    capacidad,
    puertaEntrada = PUERTA_POR_DEFECTO
  }) {
    this.id = id;
    this.titulo = titulo;
    this.categoria = categoria;
    this.sede = sede;
    this.fecha = fecha;
    this.horaInicio = horaInicio;
    this.horaFin = horaFin;
    this.organizador = organizador;
    this.capacidad = capacidad;
    this.puertaEntrada = puertaEntrada;
  }

  // Igual que Equipo.validarDatos: solo se llama al crear. Regresa los datos
  // ya limpios (trim, categoría normalizada) para guardarlos así.
  validarDatos() {
    const categoria = normalizarCategoriaEvento(this.categoria);
    if (!categoria) {
      throw new ErrorDeDominio(
        `La categoría debe ser una de: ${CATEGORIAS_EVENTO.join(', ')}.`
      );
    }

    validarFecha(this.fecha);
    validarHora(this.horaInicio, 'horaInicio');
    validarHora(this.horaFin, 'horaFin');

    // "HH:mm" se puede comparar como texto porque siempre trae 2 dígitos.
    if (this.horaFin <= this.horaInicio) {
      throw new ErrorDeDominio('La hora de fin del evento debe ser posterior a la hora de inicio.');
    }

    return {
      id: textoObligatorio(this.id, 'id', 100),
      titulo: textoObligatorio(this.titulo, 'titulo'),
      categoria,
      sede: textoObligatorio(this.sede, 'sede'),
      fecha: this.fecha,
      horaInicio: this.horaInicio,
      horaFin: this.horaFin,
      organizador: {
        nombre: textoObligatorio(this.organizador?.nombre, 'organizadorNombre'),
        matricula: textoObligatorio(this.organizador?.matricula, 'organizadorMatricula', 60),
        facultad: textoOpcional(this.organizador?.facultad, 'organizadorFacultad')
      },
      capacidad: validarCapacidad(this.capacidad),
      puertaEntrada: textoObligatorio(this.puertaEntrada, 'puertaEntrada', 60)
    };
  }

  // El QR del evento sirve hasta que el evento termina.
  finDelEvento() {
    return instanteLocalCampus(this.fecha, this.horaFin);
  }
}

// Lugares que quedan: nunca negativo aunque alguien baje la capacidad a mano.
export function lugaresDisponibles(evento) {
  return Math.max(0, evento.capacidad - (evento.inscritos ?? 0));
}

// Hasta cuándo vale el token de un pase dinámico: lo que diga el TTL, pero
// nunca después de validoHasta (el límite duro del ticket).
export function expiracionPaseDinamico(ahora, ttlSegundos, validoHasta) {
  const porTtl = new Date(ahora.getTime() + (ttlSegundos ?? QR_TTL_POR_DEFECTO) * 1000);
  return porTtl < validoHasta ? porTtl : new Date(validoHasta.getTime());
}
