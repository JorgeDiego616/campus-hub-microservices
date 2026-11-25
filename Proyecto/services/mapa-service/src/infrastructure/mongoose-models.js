import mongoose from 'mongoose';
import { TIPOS_ESPACIO } from '../domain/entities.js';

const CoordenadasSchema = new mongoose.Schema(
  {
    latitud: {
      type: Number,
      required: true
    },
    longitud: {
      type: Number,
      required: true
    }
  },
  { _id: false }
);

const EspacioSchema = new mongoose.Schema(
  {
    nombre: {
      type: String,
      required: [true, 'El nombre del espacio es obligatorio.'],
      trim: true
    },

    tipo: {
      type: String,
      required: [true, 'El tipo de espacio es obligatorio.'],
      enum: {
        values: Object.values(TIPOS_ESPACIO),
        message: 'El tipo de espacio no es válido.'
      }
    },

    edificio: {
      type: String,
      required: [true, 'El edificio es obligatorio.'],
      trim: true
    },

    piso: {
      type: Number,
      required: [true, 'El piso es obligatorio.'],
      validate: {
        validator: Number.isInteger,
        message: 'El piso debe ser un número entero.'
      }
    },

    descripcion: {
      type: String,
      trim: true,
      default: ''
    },

    coordenadas: {
      type: CoordenadasSchema,
      default: null
    },

    activo: {
      type: Boolean,
      default: true
    }
  },
  {
    timestamps: true
  }
);

EspacioSchema.index({
  nombre: 1,
  edificio: 1
});

export const EspacioModel = mongoose.model(
  'Espacio',
  EspacioSchema
);