import mongoose from 'mongoose';

// 1. Definir el subesquema de Practica primero
const PracticaSchema = new mongoose.Schema({
  fecha: {
    type: String, // formato YYYY-MM-DD
    required: [true, 'La práctica necesita una fecha.']
  },
  horaInicio: {
    type: String, // formato HH:mm
    required: [true, 'Debes definir la hora de inicio.']
  },
  horaFin: {
    type: String,
    required: [true, 'Debes definir la hora de fin.']
  },
  ubicacionId: {
    type: mongoose.Schema.Types.ObjectId,
    required: [true, 'La práctica necesita una ubicación.'],
    ref: 'Espacio'
  }
});

// 2. Esquema del Equipo con el arreglo de prácticas incrustado
const EquipoSchema = new mongoose.Schema({
  nombre: { type: String, required: true },
  deporte: { type: String, required: true },
  categoria: {
    type: String,
    required: true,
    enum: ['VARONIL', 'FEMENIL', 'MIXTO'] // Validación de catálogo
  },
  practicas: [PracticaSchema] // Incrustación NoSQL directa
});

// Forjado del Modelo de Datos
export const EquipoModel = mongoose.model('Equipo', EquipoSchema);

// ==================================================
// Eventos y códigos QR (lo que la app tenía en mock)
// ==================================================

// El organizador y el portador van incrustados (igual que las prácticas en
// el equipo): siempre se leen junto con su evento/registro.
const PersonaSchema = new mongoose.Schema({
  nombre: { type: String, required: true },
  matricula: { type: String, default: '' },
  facultad: { type: String, default: '' },
  email: { type: String, default: null }
}, { _id: false });

const GeofenceSchema = new mongoose.Schema({
  lat: Number,
  lng: Number,
  radioM: Number
}, { _id: false });

const EventoSchema = new mongoose.Schema({
  // El id lo genera la app (un UUID en EventFormData), por eso no uso el
  // _id de Mongo como id del evento: así el id es el mismo en los dos lados.
  eventoId: { type: String, required: true, unique: true },
  titulo: { type: String, required: true },
  categoria: {
    type: String,
    required: true,
    enum: ['DEPORTIVO', 'ACADEMICO', 'CULTURAL_ARTISTICA'] // mismo catálogo que domain/evento.js
  },
  sede: { type: String, required: true },
  fecha: { type: String, required: true }, // AAAA-MM-DD (hora de CDMX)
  horaInicio: { type: String, required: true }, // HH:mm
  horaFin: { type: String, required: true },
  organizador: { type: PersonaSchema, required: true },
  capacidad: { type: Number, required: true, min: 1 },
  // Contador de lugares ocupados. Lo subo con $inc en la misma operación que
  // revisa la capacidad, así dos registros al mismo tiempo no pueden pasarse
  // del cupo (ver reservarLugar en mongoose-repositories.js).
  inscritos: { type: Number, default: 0, min: 0 },
  qrToken: { type: String, required: true, unique: true },
  puertaEntrada: { type: String, required: true },
  validoDesde: { type: Date, required: true },
  validoHasta: { type: Date, required: true },
  creadoPor: { type: String, required: true } // id del usuario (seguridad)
}, { timestamps: true });

const RegistroEventoSchema = new mongoose.Schema({
  registroId: { type: String, required: true, unique: true },
  eventoId: { type: String, required: true },
  // Email/matrícula en minúsculas, o "usuario:<id>" en pases dinámicos.
  clavePortador: { type: String, required: true },
  portador: { type: PersonaSchema, required: true },
  usuarioId: { type: String, default: null },
  modo: {
    type: String,
    required: true,
    enum: ['EVENTO_ESTATICO', 'PASE_DINAMICO']
  },
  qrToken: { type: String, required: true, unique: true },
  // Solo en pases dinámicos: cuándo deja de servir el token actual.
  qrExpiraEn: { type: Date, default: null },
  estado: {
    type: String,
    enum: ['ACTIVO', 'USADO', 'CANCELADO'],
    default: 'ACTIVO'
  },
  usadoEn: { type: Date, default: null },
  usadoEnPuerta: { type: String, default: null },
  validoDesde: { type: Date, required: true },
  validoHasta: { type: Date, required: true },
  seguridad: {
    qrTtlSeconds: { type: Number, default: null },
    geofence: { type: GeofenceSchema, default: null }
  },
  registradoPor: { type: String, required: true }
}, { timestamps: true });

// Una persona solo se registra una vez por evento. Con el índice único, si
// llegan dos peticiones iguales al mismo tiempo, Mongo rechaza la segunda
// (error 11000) aunque las dos hayan pasado la revisión de "ya existe".
RegistroEventoSchema.index({ eventoId: 1, clavePortador: 1 }, { unique: true });

export const EventoModel = mongoose.model('Evento', EventoSchema);
export const RegistroEventoModel = mongoose.model('RegistroEvento', RegistroEventoSchema);