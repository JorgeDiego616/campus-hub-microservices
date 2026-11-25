import { ErrorDeDominio } from './errors.js';

// Las reglas de negocio lanzan ErrorDeDominio (antes new Error) para que
// lleguen al cliente como BAD_USER_INPUT y no como error interno.

// Mismo catálogo que el enum de EquipoSchema (mongoose-models.js).
// Antes solo lo revisaba Mongoose al guardar: una categoría como "Prueba"
// tronaba con ValidationError, salía como error interno y en producción el
// usuario solo veía "Error interno del servidor.". Ahora lo valido aquí
// con un mensaje claro (igual que TIPOS_ESPACIO en mapa).
export const CATEGORIAS_EQUIPO = Object.freeze(['VARONIL', 'FEMENIL', 'MIXTO']);

// Entidad de Dominio (Modelo de Negocio Puro - DDD)
export class Equipo {
  constructor(id, nombre, deporte, categoria, practicas = []) {
    this.id = id;
    this.nombre = nombre;
    this.deporte = deporte;
    this.categoria = categoria;
    this.practicas = practicas;
  }

  // Solo se llama al crear un equipo nuevo. No lo pongo en el constructor
  // porque el constructor también se usa para reconstruir equipos que ya
  // existen (al registrar una práctica) y esos ya pasaron por aquí.
  validarDatos() {
    if (typeof this.nombre !== 'string' || !this.nombre.trim()) {
      throw new ErrorDeDominio('El nombre del equipo es obligatorio.');
    }
    if (typeof this.deporte !== 'string' || !this.deporte.trim()) {
      throw new ErrorDeDominio('El deporte del equipo es obligatorio.');
    }
    if (!CATEGORIAS_EQUIPO.includes(this.categoria)) {
      throw new ErrorDeDominio(
        `La categoría debe ser una de: ${CATEGORIAS_EQUIPO.join(', ')}.`
      );
    }
  }

  // Lógica y reglas de negocio del dominio:
  // Un equipo no puede tener dos prácticas que se traslapen en el mismo horario.
  validarHorarioPractica(nuevaPractica) {
    const nuevoInicio = new Date(`${nuevaPractica.fecha}T${nuevaPractica.horaInicio}`);
    const nuevoFin = new Date(`${nuevaPractica.fecha}T${nuevaPractica.horaFin}`);

    if (nuevoFin <= nuevoInicio) {
      throw new ErrorDeDominio("La hora de fin de la práctica debe ser posterior a la hora de inicio.");
    }

    const hayTraslape = this.practicas.some((practica) => {
      if (practica.fecha !== nuevaPractica.fecha) return false;
      const inicioExistente = new Date(`${practica.fecha}T${practica.horaInicio}`);
      const finExistente = new Date(`${practica.fecha}T${practica.horaFin}`);
      return nuevoInicio < finExistente && nuevoFin > inicioExistente;
    });

    if (hayTraslape) {
      throw new ErrorDeDominio(`El equipo ${this.nombre} ya tiene una práctica registrada que se traslapa ese día.`);
    }
  }
}
