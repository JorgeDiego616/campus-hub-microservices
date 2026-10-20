export const DIAS_SEMANA = {
  1: 'LUNES',
  2: 'MARTES',
  3: 'MIÉRCOLES',
  4: 'JUEVES',
  5: 'VIERNES',
  6: 'SÁBADO',
  7: 'DOMINGO'
};

const FORMATO_HORA = /^([01]\d|2[0-3]):[0-5]\d$/;

// Regla de negocio: una sesión de horario es un bloque semanal de una asignación.
export class SesionHorario {
  constructor({ asignacionMateriaId, diaSemana, horaInicio, horaFin, aula = null, carreraIds = [] }) {
    this.asignacionMateriaId = asignacionMateriaId;
    this.diaSemana = diaSemana;
    this.horaInicio = horaInicio;
    this.horaFin = horaFin;
    this.aula = typeof aula === 'string' && aula.trim() ? aula.trim() : null;
    this.carreraIds = [...new Set((carreraIds ?? []).map(String))];
    this.validar();
  }

  validar() {
    if (!this.asignacionMateriaId) {
      throw new Error('La sesión necesita una asignación de materia.');
    }
    if (!Number.isInteger(this.diaSemana) || this.diaSemana < 1 || this.diaSemana > 7) {
      throw new Error('El día de la semana debe ser un número del 1 (lunes) al 7 (domingo).');
    }
    if (!FORMATO_HORA.test(this.horaInicio) || !FORMATO_HORA.test(this.horaFin)) {
      throw new Error('Las horas deben tener el formato HH:mm (24 horas).');
    }
    if (this.horaFin <= this.horaInicio) {
      throw new Error('La hora final debe ser posterior a la inicial.');
    }
  }
}