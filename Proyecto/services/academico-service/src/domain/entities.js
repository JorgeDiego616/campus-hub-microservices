import { ErrorDeDominio } from './errors.js';

// Las reglas de negocio lanzan ErrorDeDominio (antes new Error) para que
// lleguen al cliente como BAD_USER_INPUT y no como error interno.

export class PerfilAcademico {
  constructor({ usuarioId, carreraId, semestre, creditosAcumulados = 0 }) {
    if (!usuarioId || !carreraId) throw new ErrorDeDominio('El perfil académico requiere usuario y carrera.');
    if (!Number.isInteger(semestre) || semestre < 1) throw new ErrorDeDominio('El semestre debe ser un entero positivo.');
    if (creditosAcumulados < 0) throw new ErrorDeDominio('Los créditos acumulados no pueden ser negativos.');
    Object.assign(this, { usuarioId, carreraId, semestre, creditosAcumulados });
  }
}

export class Carrera {
  constructor({ nombre }) {
    if (!nombre?.trim()) throw new ErrorDeDominio('El nombre de la carrera es obligatorio.');
    this.nombre = nombre.trim();
  }
}

export class Materia {
  constructor({ nombre, creditos }) {
    if (!nombre?.trim()) throw new ErrorDeDominio('El nombre de la materia es obligatorio.');
    if (!Number.isFinite(creditos) || creditos < 0) throw new ErrorDeDominio('Los créditos deben ser un número no negativo.');
    Object.assign(this, { nombre: nombre.trim(), creditos });
  }
}

export class Periodo {
  constructor({ nombre, fechaInicio, fechaFin }) {
    if (!nombre?.trim()) throw new ErrorDeDominio('El nombre del periodo es obligatorio.');
    this.fechaInicio = new Date(fechaInicio);
    this.fechaFin = new Date(fechaFin);
    if (Number.isNaN(this.fechaInicio.valueOf()) || Number.isNaN(this.fechaFin.valueOf()) || this.fechaFin < this.fechaInicio) {
      throw new ErrorDeDominio('El rango de fechas del periodo no es válido.');
    }
    this.nombre = nombre.trim();
  }

  contiene(fecha) {
    const fechaExamen = new Date(fecha);
    return !Number.isNaN(fechaExamen.valueOf()) && fechaExamen >= this.fechaInicio && fechaExamen <= this.fechaFin;
  }
}

export class AsignacionMateria {
  constructor({ materiaId, profesorId, periodoId, grupo }) {
    if (!materiaId || !profesorId || !periodoId || !grupo?.trim()) {
      throw new ErrorDeDominio('La asignación requiere materia, profesor, periodo y grupo.');
    }
    Object.assign(this, { materiaId, profesorId, periodoId, grupo: grupo.trim() });
  }
}

export class Inscripcion {
  constructor({ alumnoId, asignacionMateriaId, estado = 'ACTIVA' }) {
    if (!alumnoId || !asignacionMateriaId) throw new ErrorDeDominio('La inscripción requiere alumno y asignación.');
    Object.assign(this, { alumnoId, asignacionMateriaId, estado });
  }

  static asegurarNoDuplicada(existe) {
    if (existe) throw new ErrorDeDominio('El alumno ya está inscrito en esta asignación de materia.');
  }
}

export class Calificacion {
  constructor({ inscripcionId, valor, fechaRegistro = new Date() }) {
    if (!inscripcionId) throw new ErrorDeDominio('La calificación debe pertenecer a una inscripción.');
    if (!Number.isFinite(valor) || valor < 0 || valor > 10) throw new ErrorDeDominio('La calificación debe estar entre 0 y 10.');
    Object.assign(this, { inscripcionId, valor, fechaRegistro: new Date(fechaRegistro) });
  }
}

export class Falta {
  constructor({ inscripcionId, fecha, tipo, observacion }) {
    if (!inscripcionId || !fecha || !tipo?.trim()) throw new ErrorDeDominio('La falta requiere inscripción, fecha y tipo.');
    const fechaFalta = new Date(fecha);
    if (Number.isNaN(fechaFalta.valueOf())) throw new ErrorDeDominio('La fecha de la falta no es válida.');
    Object.assign(this, { inscripcionId, fecha: fechaFalta, tipo: tipo.trim(), observacion: observacion?.trim() || null });
  }
}

export class Examen {
  constructor({ asignacionMateriaId, periodoId, fecha, ubicacionId }) {
    if (!asignacionMateriaId || !periodoId || !fecha || !ubicacionId) {
      throw new ErrorDeDominio('El examen requiere asignación, periodo, fecha y ubicación.');
    }
    this.fecha = new Date(fecha);
    if (Number.isNaN(this.fecha.valueOf())) throw new ErrorDeDominio('La fecha del examen no es válida.');
    Object.assign(this, { asignacionMateriaId, periodoId, ubicacionId });
  }

  validarPeriodo(periodo, periodoDeAsignacionId) {
    if (String(periodoDeAsignacionId) !== String(this.periodoId)) {
      throw new ErrorDeDominio('El examen debe utilizar el periodo de su asignación.');
    }
    if (!periodo.contiene(this.fecha)) throw new ErrorDeDominio('El examen no puede registrarse fuera del periodo correspondiente.');
  }
}

class RegistroHoras {
  constructor({ alumnoId, periodoId, horas, concepto }) {
    if (!alumnoId || !periodoId || !concepto?.trim()) throw new ErrorDeDominio('El registro de horas requiere alumno, periodo y concepto.');
    if (!Number.isFinite(horas) || horas < 0) throw new ErrorDeDominio('Las horas deben ser un número no negativo.');
    Object.assign(this, { alumnoId, periodoId, horas, concepto: concepto.trim() });
  }
}

export class HorasBecarias extends RegistroHoras {}
export class HorasComplementarias extends RegistroHoras {}
