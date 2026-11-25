export const TIPOS_ESPACIO = Object.freeze({
  CANCHA: 'CANCHA',
  GIMNASIO: 'GIMNASIO',
  SALON: 'SALON',
  LABORATORIO: 'LABORATORIO',
  AUDITORIO: 'AUDITORIO',
  EDIFICIO: 'EDIFICIO',
  OTRO: 'OTRO'
});

export class Espacio {
  constructor(
    id,
    nombre,
    tipo,
    edificio,
    piso,
    descripcion = '',
    coordenadas = null,
    activo = true
  ) {
    if (!nombre?.trim()) {
      throw new Error('El nombre del espacio es obligatorio.');
    }

    if (!Object.values(TIPOS_ESPACIO).includes(tipo)) {
      throw new Error('El tipo de espacio no es válido.');
    }

    if (!edificio?.trim()) {
      throw new Error('El edificio es obligatorio.');
    }

    if (!Number.isInteger(piso)) {
      throw new Error('El piso debe ser un número entero.');
    }

    if (coordenadas !== null) {
      if (
        typeof coordenadas.latitud !== 'number' ||
        typeof coordenadas.longitud !== 'number'
      ) {
        throw new Error('Las coordenadas deben contener latitud y longitud numéricas.');
      }
    }

    this.id = id;
    this.nombre = nombre.trim();
    this.tipo = tipo;
    this.edificio = edificio.trim();
    this.piso = piso;
    this.descripcion = descripcion?.trim() ?? '';
    this.coordenadas = coordenadas;
    this.activo = activo;
  }

  validarDisponible() {
    if (!this.activo) {
      throw new Error('El espacio no está disponible para nuevas asignaciones.');
    }
  }

  desactivar() {
    this.activo = false;
  }

  activar() {
    this.activo = true;
  }
}