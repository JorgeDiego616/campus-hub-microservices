import { Equipo } from '../domain/entities.js';

export function createSportsUseCases({ repositories, eventPublisher }) {
  const {
    equipoRepository
  } = repositories;

  async function registrarEquipo({ nombre, deporte, categoria }) {
    const equipo = new Equipo(
      null,
      nombre,
      deporte,
      categoria,
      []
    );

    const creado = await equipoRepository.create(equipo);

    await eventPublisher.publish('EQUIPO_REGISTRADO', {
      id: creado.id,
      nombre: creado.nombre,
      deporte: creado.deporte,
      categoria: creado.categoria
    });

    return creado;
  }

  async function registrarPractica({
    equipoId,
    fecha,
    horaInicio,
    horaFin,
    ubicacionId
  }) {
    const equipo = await equipoRepository.requireById(equipoId);

    const equipoDominio = new Equipo(
      equipo.id,
      equipo.nombre,
      equipo.deporte,
      equipo.categoria,
      equipo.practicas
    );

    equipoDominio.validarHorarioPractica({
      fecha,
      horaInicio,
      horaFin,
      ubicacionId
    });

    const practica = {
      fecha,
      horaInicio,
      horaFin,
      ubicacionId
    };

    const actualizado = await equipoRepository.addPractica(
      equipoId,
      practica
    );

    const practicaGuardada =
      actualizado.practicas[actualizado.practicas.length - 1];

    await eventPublisher.publish('PRACTICA_REGISTRADA', {
      equipoId: actualizado.id,
      practicaId: practicaGuardada.id,
      ubicacionId: practicaGuardada.ubicacionId,
      fecha: practicaGuardada.fecha,
      horaInicio: practicaGuardada.horaInicio,
      horaFin: practicaGuardada.horaFin
    });

    return practicaGuardada;
  }

  async function reportePracticasPorDeporte() {
    return equipoRepository.reportePracticasPorDeporte();
  }

  async function verEquipo(id) {
    return equipoRepository.findById(id);
  }

  async function allEquipos() {
    return equipoRepository.findAll();
  }

  return {
    registrarEquipo,
    registrarPractica,
    reportePracticasPorDeporte,
    verEquipo,
    allEquipos
  };
}