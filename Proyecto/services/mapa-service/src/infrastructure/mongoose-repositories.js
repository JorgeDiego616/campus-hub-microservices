import { EspacioModel } from './mongoose-models.js';

function toDto(doc) {
  if (!doc) return null;

  return {
    id: String(doc._id),
    nombre: doc.nombre,
    tipo: doc.tipo,
    edificio: doc.edificio,
    piso: doc.piso,
    descripcion: doc.descripcion,
    coordenadas: doc.coordenadas
      ? {
          latitud: doc.coordenadas.latitud,
          longitud: doc.coordenadas.longitud
        }
      : null,
    activo: doc.activo
  };
}

export function createEspacioRepository() {
  return {
    async create(espacio) {
      const doc = await EspacioModel.create({
        nombre: espacio.nombre,
        tipo: espacio.tipo,
        edificio: espacio.edificio,
        piso: espacio.piso,
        descripcion: espacio.descripcion,
        coordenadas: espacio.coordenadas,
        activo: espacio.activo
      });

      return toDto(doc);
    },

    async findById(id) {
      const doc = await EspacioModel.findById(id);
      return toDto(doc);
    },

    async requireById(id) {
      const espacio = await this.findById(id);

      if (!espacio) {
        throw new Error('El espacio solicitado no existe.');
      }

      return espacio;
    },

    async findAll(filters = {}) {
      const query = {};

      if (filters.tipo) {
        query.tipo = filters.tipo;
      }

      if (filters.activo !== undefined) {
        query.activo = filters.activo;
      }

      const docs = await EspacioModel.find(query).sort({
        edificio: 1,
        piso: 1,
        nombre: 1
      });

      return docs.map(toDto);
    },

    async update(id, changes) {
      const doc = await EspacioModel.findByIdAndUpdate(
        id,
        { $set: changes },
        {
          new: true,
          runValidators: true
        }
      );

      return toDto(doc);
    }
  };
}