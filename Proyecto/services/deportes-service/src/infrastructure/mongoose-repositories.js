import mongoose from 'mongoose';
import { EquipoModel, EventoModel, RegistroEventoModel } from './mongoose-models.js';
import { RecursoNoEncontrado, ErrorDeDominio, ConflictoDeNegocio } from '../domain/errors.js'; // antes: new Error -> salía como 500

function toDto(doc) {
  if (!doc) return null;

  return {
    id: String(doc._id),
    nombre: doc.nombre,
    deporte: doc.deporte,
    categoria: doc.categoria,
    practicas: (doc.practicas ?? []).map((practica) => ({
      id: String(practica._id),
      fecha: practica.fecha,
      horaInicio: practica.horaInicio,
      horaFin: practica.horaFin,
      ubicacionId: String(practica.ubicacionId)
    }))
  };
}

export function createEquipoRepository() {
  return {
    async create(equipo) {
      const doc = await EquipoModel.create({
        nombre: equipo.nombre,
        deporte: equipo.deporte,
        categoria: equipo.categoria,
        practicas: equipo.practicas ?? []
      });

      return toDto(doc);
    },

    async findById(id) {
      // Con un id mal formado (ej. "xx") Mongoose tronaba con
      // "Cast to ObjectId failed" y salía como error interno. Para la app
      // es lo mismo que no existir: regreso null (y requireById da NOT_FOUND).
      if (!mongoose.isValidObjectId(id)) return null;

      const doc = await EquipoModel.findById(id);
      return toDto(doc);
    },

    async requireById(id) {
      const equipo = await this.findById(id);

      if (!equipo) {
        throw new RecursoNoEncontrado('El equipo de destino no existe.');
      }

      return equipo;
    },

    async findAll() {
      const docs = await EquipoModel.find({});
      return docs.map(toDto);
    },

    async addPractica(equipoId, practica) {
      const doc = await EquipoModel.findById(equipoId);

      if (!doc) {
        throw new RecursoNoEncontrado('El equipo de destino no existe.');
      }

      // ubicacionId es un ObjectId que apunta a un Espacio de mapa-service.
      // Si mandaban algo como "cancha-1", Mongoose tronaba al guardar
      // (CastError) y salía como error interno. Lo reviso antes con un
      // mensaje claro. Va aquí y no en el dominio porque "ser ObjectId" es
      // cosa de MongoDB, no una regla del negocio.
      if (!mongoose.isValidObjectId(practica.ubicacionId)) {
        throw new ErrorDeDominio('La ubicación de la práctica no es válida.');
      }

      doc.practicas.push(practica);

      const actualizado = await doc.save();

      return toDto(actualizado);
    },

    async reportePracticasPorDeporte() {
      const resultado = await EquipoModel.aggregate([
        {
          $unwind: '$practicas'
        },

        {
          $match: {
            'practicas.ubicacionId': {
              $exists: true
            }
          }
        },

        {
          $group: {
            _id: '$deporte',
            totalPracticas: {
              $sum: 1
            },
            equiposAsociados: {
              $addToSet: '$nombre'
            }
          }
        },

        {
          $sort: {
            totalPracticas: -1
          }
        }
      ]);

      return resultado.map((item) => ({
        deporte: item._id,
        totalPracticas: item.totalPracticas,
        equiposAsociados: item.equiposAsociados
      }));
    }
  };
}

// ==================================================
// Eventos y registros (QR)
// ==================================================

// Código de MongoDB cuando un índice único rechaza el documento.
const CLAVE_DUPLICADA = 11000;

function esDuplicado(error, campo) {
  return error?.code === CLAVE_DUPLICADA && Boolean(error.keyPattern?.[campo]);
}

// El id del evento lo pone la app, no es un ObjectId. Solo reviso que sea
// texto para que nadie mande { $ne: null } como id (inyección NoSQL).
function idValido(id) {
  return typeof id === 'string' && id.trim().length > 0;
}

function eventoToDto(doc) {
  if (!doc) return null;

  return {
    id: doc.eventoId,
    titulo: doc.titulo,
    categoria: doc.categoria,
    sede: doc.sede,
    fecha: doc.fecha,
    horaInicio: doc.horaInicio,
    horaFin: doc.horaFin,
    organizador: {
      nombre: doc.organizador?.nombre ?? '',
      matricula: doc.organizador?.matricula ?? '',
      facultad: doc.organizador?.facultad ?? ''
    },
    capacidad: doc.capacidad,
    inscritos: doc.inscritos ?? 0,
    qrToken: doc.qrToken,
    puertaEntrada: doc.puertaEntrada,
    validoDesde: doc.validoDesde,
    validoHasta: doc.validoHasta,
    creadoPor: doc.creadoPor,
    creadoEn: doc.createdAt
  };
}

function registroToDto(doc) {
  if (!doc) return null;

  return {
    id: doc.registroId,
    eventoId: doc.eventoId,
    clavePortador: doc.clavePortador,
    portador: {
      nombre: doc.portador?.nombre ?? '',
      matricula: doc.portador?.matricula ?? '',
      facultad: doc.portador?.facultad ?? '',
      email: doc.portador?.email ?? null
    },
    usuarioId: doc.usuarioId ?? null,
    modo: doc.modo,
    qrToken: doc.qrToken,
    qrExpiraEn: doc.qrExpiraEn ?? null,
    estado: doc.estado,
    usadoEn: doc.usadoEn ?? null,
    usadoEnPuerta: doc.usadoEnPuerta ?? null,
    validoDesde: doc.validoDesde,
    validoHasta: doc.validoHasta,
    seguridad: {
      qrTtlSeconds: doc.seguridad?.qrTtlSeconds ?? null,
      geofence: doc.seguridad?.geofence ?? null
    },
    registradoPor: doc.registradoPor,
    registradoEn: doc.createdAt
  };
}

export function createEventoRepository() {
  return {
    async create(evento) {
      try {
        const doc = await EventoModel.create({
          eventoId: evento.id,
          titulo: evento.titulo,
          categoria: evento.categoria,
          sede: evento.sede,
          fecha: evento.fecha,
          horaInicio: evento.horaInicio,
          horaFin: evento.horaFin,
          organizador: evento.organizador,
          capacidad: evento.capacidad,
          inscritos: 0,
          qrToken: evento.qrToken,
          puertaEntrada: evento.puertaEntrada,
          validoDesde: evento.validoDesde,
          validoHasta: evento.validoHasta,
          creadoPor: evento.creadoPor
        });

        return eventoToDto(doc);
      } catch (error) {
        // Dos personas mandaron el mismo id al mismo tiempo: gana la primera.
        if (esDuplicado(error, 'eventoId')) {
          throw new ConflictoDeNegocio('Ya existe un evento con ese id.');
        }
        throw error;
      }
    },

    async findById(id) {
      if (!idValido(id)) return null;
      return eventoToDto(await EventoModel.findOne({ eventoId: id }));
    },

    async requireById(id) {
      const evento = await this.findById(id);
      if (!evento) {
        throw new RecursoNoEncontrado('El evento no existe.');
      }
      return evento;
    },

    async findAll() {
      const docs = await EventoModel.find({}).sort({ fecha: 1, horaInicio: 1 });
      return docs.map(eventoToDto);
    },

    // Solo los datos que se ven en el ticket. La capacidad, el token y la
    // vigencia no se tocan aquí.
    async actualizarDatos(id, { titulo, categoria, sede }) {
      const doc = await EventoModel.findOneAndUpdate(
        { eventoId: id },
        { $set: { titulo, categoria, sede } },
        { returnDocument: 'after', runValidators: true }
      );
      return eventoToDto(doc);
    },

    // Revisa que haya lugar y lo ocupa en UNA sola operación atómica.
    // Si lo hiciera en dos pasos (leer inscritos y luego guardar +1), dos
    // registros al mismo tiempo podrían ver "queda 1 lugar" y entrar los dos.
    // Regresa null si el evento está lleno.
    async reservarLugar(id) {
      const doc = await EventoModel.findOneAndUpdate(
        { eventoId: id, $expr: { $lt: ['$inscritos', '$capacidad'] } },
        { $inc: { inscritos: 1 } },
        { returnDocument: 'after' }
      );
      return eventoToDto(doc);
    },

    // Deshace reservarLugar si al final el registro no se guardó.
    async liberarLugar(id) {
      await EventoModel.updateOne(
        { eventoId: id, inscritos: { $gt: 0 } },
        { $inc: { inscritos: -1 } }
      );
    }
  };
}

export function createRegistroEventoRepository() {
  return {
    async findByEventoYClave(eventoId, clavePortador) {
      if (!idValido(eventoId) || typeof clavePortador !== 'string') return null;
      return registroToDto(await RegistroEventoModel.findOne({ eventoId, clavePortador }));
    },

    async findByEvento(eventoId) {
      if (!idValido(eventoId)) return [];
      const docs = await RegistroEventoModel.find({ eventoId }).sort({ createdAt: 1 });
      return docs.map(registroToDto);
    },

    // Regresa null si la persona ya estaba registrada en ese evento (el
    // índice único lo rechazó). El caso de uso decide qué hacer con eso.
    async create(registro) {
      try {
        const doc = await RegistroEventoModel.create({
          registroId: registro.id,
          eventoId: registro.eventoId,
          clavePortador: registro.clavePortador,
          portador: registro.portador,
          usuarioId: registro.usuarioId ?? null,
          modo: registro.modo,
          qrToken: registro.qrToken,
          qrExpiraEn: registro.qrExpiraEn ?? null,
          validoDesde: registro.validoDesde,
          validoHasta: registro.validoHasta,
          seguridad: registro.seguridad,
          registradoPor: registro.registradoPor
        });

        return registroToDto(doc);
      } catch (error) {
        if (esDuplicado(error, 'clavePortador')) return null;
        throw error;
      }
    },

    // Pase dinámico: cada vez que la app pide el QR, el token anterior deja
    // de servir. Así una captura de pantalla vieja no sirve para entrar.
    async rotarToken(registroId, qrToken, qrExpiraEn) {
      const doc = await RegistroEventoModel.findOneAndUpdate(
        { registroId },
        { $set: { qrToken, qrExpiraEn } },
        { returnDocument: 'after' }
      );
      return registroToDto(doc);
    }
  };
}
