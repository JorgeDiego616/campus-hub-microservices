import { EquipoModel } from './mongoose-models.js';

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
      const doc = await EquipoModel.findById(id);
      return toDto(doc);
    },

    async requireById(id) {
      const equipo = await this.findById(id);

      if (!equipo) {
        throw new Error('El equipo de destino no existe.');
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
        throw new Error('El equipo de destino no existe.');
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