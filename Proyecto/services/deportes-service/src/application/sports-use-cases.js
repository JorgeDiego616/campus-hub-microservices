import { Equipo } from '../domain/entities.js';

// Datos de "quién y desde dónde" que el worker de auditoría guarda en
// columnas propias (usuario_id, ip_origen, severidad). Antes los eventos de
// deportes no los traían y en ScyllaDB quedaban en null, entonces no se
// sabía quién había registrado un equipo o una práctica.
// Mismos nombres de campo que usa académico en CONSULTA_DATOS_SENSIBLES.
export function datosAuditoria(actor) {
  return {
    usuario_id: actor?.id ?? null,
    ip_origen: actor?.ip_origen || 'UNKNOWN',
    jti: actor?.jti ?? null,
    severidad: 'INFO',
    metadata: { rol: actor?.rol ?? null }
  };
}

export function createSportsUseCases({ repositories, eventPublisher }) {
  const {
    equipoRepository
  } = repositories;

  // Ahora recibo el actor primero (igual que los casos de uso de académico)
  // para poder decir en el evento quién hizo el registro.
  async function registrarEquipo(actor, { nombre, deporte, categoria }) {
    const equipo = new Equipo(
      null,
      nombre?.trim(),
      deporte?.trim(),
      // En la BD todas están en mayúsculas ("MIXTO"); así "mixto" también vale.
      typeof categoria === 'string' ? categoria.trim().toUpperCase() : categoria,
      []
    );

    equipo.validarDatos();

    const creado = await equipoRepository.create(equipo);

    await eventPublisher.publish('EQUIPO_REGISTRADO', {
      ...datosAuditoria(actor),
      operacion: 'registrarEquipo',
      id: creado.id,
      nombre: creado.nombre,
      deporte: creado.deporte,
      categoria: creado.categoria
    });

    return creado;
  }

  async function registrarPractica(actor, {
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
      ...datosAuditoria(actor),
      operacion: 'registrarPractica',
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