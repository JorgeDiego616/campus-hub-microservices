import { ErrorDeDominio } from './errors.js';

// Las reglas de negocio lanzan ErrorDeDominio (antes new Error) para que
// lleguen al cliente como BAD_USER_INPUT y no como error interno.

// Entidad de Dominio (Modelo de Negocio Puro - DDD)

// Roles que se crean automáticamente al arrancar el servicio.
export const ROLES_POR_DEFECTO = ['ESTUDIANTE', 'ENTRENADOR', 'PROFESOR', 'COORDINADOR', 'ADMIN', 'BECARIO'];

// Mismo mínimo que pide la app Android en RegisterViewModel (password.length < 6).
export const PASSWORD_MIN_LENGTH = 6;

// Guardo y busco el email siempre en minúsculas y sin espacios. Antes
// "Ana@Test.com" y "ana@test.com" contaban como dos usuarios distintos y el
// login fallaba si la persona escribía una mayúscula diferente.
export function normalizarEmail(email) {
  return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

export class Usuario {
  constructor(id, matricula, nombre, email, rol) {
    this.id = id;
    this.matricula = matricula;
    this.nombre = nombre;
    this.email = email;
    this.rol = rol;
  }

  // Regla de negocio: el nombre no puede venir vacío.
  validarNombre() {
    if (typeof this.nombre !== 'string' || this.nombre.trim().length === 0) {
      throw new ErrorDeDominio("El nombre es obligatorio.");
    }
  }

  // Regla de negocio: formato básico de correo (algo@algo.algo).
  // No es perfecto a propósito; solo evita basura como "" o "hola".
  validarEmail() {
    const formatoValido = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(this.email);
    if (!formatoValido) {
      throw new ErrorDeDominio("El email no tiene un formato válido.");
    }
  }

  // La contraseña no vive en la entidad (solo guardamos el hash), por eso
  // esta validación es estática: se revisa antes de hacer el hash.
  static validarPassword(password) {
    if (typeof password !== 'string' || password.length < PASSWORD_MIN_LENGTH) {
      throw new ErrorDeDominio(`La contraseña debe tener al menos ${PASSWORD_MIN_LENGTH} caracteres.`);
    }
  }

  // Regla de negocio: la matrícula debe tener entre 6 y 10 dígitos numéricos.
  validarMatricula() {
    const formatoValido = /^\d{6,10}$/.test(this.matricula);
    if (!formatoValido) {
      throw new ErrorDeDominio("La matrícula debe contener solo dígitos, entre 6 y 10 caracteres.");
    }
  }

  // Regla de negocio: el rol debe tener un formato válido.
  // Que exista en el sistema se verifica contra la base de datos.
  validarRol() {
    const formatoValido = /^[A-ZÁÉÍÓÚÑ0-9_]{3,30}$/.test(this.rol);
    if (!formatoValido) {
      throw new ErrorDeDominio("El rol debe tener entre 3 y 30 caracteres: letras, números o guion bajo.");
    }
  }
}