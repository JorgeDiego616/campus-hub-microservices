import { Espacio, TIPOS_ESPACIO } from '../domain/entities.js';
import { performance } from 'node:perf_hooks';

const CACHE_PREFIX = 'cache:espacio';

function cacheValue(espacio) {
  if (!espacio) return null;

  return {
    id: espacio.id,
    nombre: espacio.nombre,
    tipo: espacio.tipo,
    edificio: espacio.edificio,
    piso: espacio.piso,
    descripcion: espacio.descripcion,
    coordenadas: espacio.coordenadas
      ? {
          latitud: espacio.coordenadas.latitud,
          longitud: espacio.coordenadas.longitud
        }
      : null,
    activo: espacio.activo
  };
}

function filterSegment(value) {
  if (value === undefined) return 'ausente';
  if (value === null) return 'null';
  return encodeURIComponent(String(value));
}

function espaciosCacheKey({ tipo, activo }) {
  return `cache:espacios:tipo:${filterSegment(tipo)}:activo:${filterSegment(activo)}`;
}

function logQuery({ query, cacheStatus, source, redisReadMs, totalMs }) {
  console.log(
    `[cache] consulta=${query} resultado=${cacheStatus} fuente=${source} ` +
      `lecturaRedisMs=${redisReadMs.toFixed(2)} totalMs=${totalMs.toFixed(2)}`
  );
}

export function createMapaUseCases({ repository, eventPublisher, cache }) {
  async function invalidarEspacios() {
    // Incluye cache:espacio:<id> y cache:espacios:<filtros>, sin tocar otras
    // claves Redis y sin usar KEYS.
    await cache.invalidateByPrefix(CACHE_PREFIX);
  }

  async function crearEspacio({
    nombre,
    tipo,
    edificio,
    piso,
    descripcion = '',
    coordenadas = null
  }) {
    const espacio = new Espacio(
      null,
      nombre,
      tipo,
      edificio,
      piso,
      descripcion,
      coordenadas,
      true
    );

    const creado = await repository.create(espacio);

    await invalidarEspacios();

    await eventPublisher.publish('ESPACIO_CREADO', {
      espacioId: creado.id,
      nombre: creado.nombre,
      tipo: creado.tipo,
      edificio: creado.edificio
    });

    return creado;
  }

  async function obtenerEspacio(id) {
    const key = `${CACHE_PREFIX}:${id}`;
    const start = performance.now();
    const redisStart = performance.now();
    const cached = await cache.getJson(key);
    const redisReadMs = performance.now() - redisStart;

    if (cached.status === 'HIT') {
      logQuery({
        query: `espacio(${id})`,
        cacheStatus: 'HIT',
        source: 'Redis',
        redisReadMs,
        totalMs: performance.now() - start
      });
      return cached.value;
    }

    const espacio = await repository.findById(id);

    if (espacio) {
      await cache.setJson(key, cacheValue(espacio));
    }

    logQuery({
      query: `espacio(${id})`,
      cacheStatus: cached.status === 'UNAVAILABLE' ? 'UNAVAILABLE' : 'MISS',
      source: 'MongoDB',
      redisReadMs,
      totalMs: performance.now() - start
    });

    return espacio;
  }

  async function listarEspacios({ tipo, activo } = {}) {
    const filters = { tipo, activo };
    const key = espaciosCacheKey(filters);
    const start = performance.now();
    const redisStart = performance.now();
    const cached = await cache.getJson(key);
    const redisReadMs = performance.now() - redisStart;

    if (cached.status === 'HIT') {
      logQuery({
        query: `espacios(${JSON.stringify(filters)})`,
        cacheStatus: 'HIT',
        source: 'Redis',
        redisReadMs,
        totalMs: performance.now() - start
      });
      return cached.value;
    }

    const espacios = await repository.findAll(filters);
    await cache.setJson(key, espacios.map(cacheValue));

    logQuery({
      query: `espacios(${JSON.stringify(filters)})`,
      cacheStatus: cached.status === 'UNAVAILABLE' ? 'UNAVAILABLE' : 'MISS',
      source: 'MongoDB',
      redisReadMs,
      totalMs: performance.now() - start
    });

    return espacios;
  }

  async function desactivarEspacio(id) {
    const espacio = await repository.requireById(id);

    const espacioDominio = new Espacio(
      espacio.id,
      espacio.nombre,
      espacio.tipo,
      espacio.edificio,
      espacio.piso,
      espacio.descripcion,
      espacio.coordenadas,
      espacio.activo
    );

    espacioDominio.desactivar();

    const actualizado = await repository.update(
      espacio.id,
      {
        activo: espacioDominio.activo
      }
    );

    await invalidarEspacios();

    await eventPublisher.publish('ESPACIO_DESACTIVADO', {
      espacioId: actualizado.id,
      nombre: actualizado.nombre,
      tipo: actualizado.tipo,
      edificio: actualizado.edificio
    });

    return actualizado;
  }

  async function activarEspacio(id) {
    const espacio = await repository.requireById(id);

    const espacioDominio = new Espacio(
      espacio.id,
      espacio.nombre,
      espacio.tipo,
      espacio.edificio,
      espacio.piso,
      espacio.descripcion,
      espacio.coordenadas,
      espacio.activo
    );

    espacioDominio.activar();

    const actualizado = await repository.update(
      espacio.id,
      {
        activo: espacioDominio.activo
      }
    );

    await invalidarEspacios();

    await eventPublisher.publish('ESPACIO_ACTIVADO', {
      espacioId: actualizado.id,
      nombre: actualizado.nombre,
      tipo: actualizado.tipo,
      edificio: actualizado.edificio
    });

    return actualizado;
  }

  async function validarEspacioDisponible(id) {
    const espacio = await repository.requireById(id);

    const espacioDominio = new Espacio(
      espacio.id,
      espacio.nombre,
      espacio.tipo,
      espacio.edificio,
      espacio.piso,
      espacio.descripcion,
      espacio.coordenadas,
      espacio.activo
    );

    espacioDominio.validarDisponible();

    return true;
  }

  return {
    crearEspacio,
    obtenerEspacio,
    listarEspacios,
    desactivarEspacio,
    activarEspacio,
    validarEspacioDisponible,
    tiposEspacio: TIPOS_ESPACIO
  };
}
