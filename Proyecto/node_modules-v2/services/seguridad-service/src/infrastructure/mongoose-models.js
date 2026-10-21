import mongoose from 'mongoose';

const RolSchema = new mongoose.Schema({
  nombre: {
    type: String,
    required: [true, 'El nombre del rol es obligatorio.'],
    unique: true,
    uppercase: true,
    trim: true
  }
});

const UsuarioSchema = new mongoose.Schema({
  matricula: {
    type: String,
    required: [true, 'La matrícula es obligatoria.'],
    unique: true
  },
  nombre: { type: String, required: true },
  email: {
    type: String,
    required: [true, 'El email es obligatorio.'],
    unique: true
  },
  passwordHash: {
    type: String,
    required: [true, 'La contraseña es obligatoria.']
  },
  rol: {
    type: String,
    required: true,
    uppercase: true,
    trim: true
  },
  activo: { type: Boolean, default: true }
});

export const RolModel = mongoose.model('Rol', RolSchema);
export const UsuarioModel = mongoose.model('Usuario', UsuarioSchema);