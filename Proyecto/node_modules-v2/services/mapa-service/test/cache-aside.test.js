import assert from 'node:assert/strict';
import test from 'node:test';

import { createMapaUseCases } from '../src/application/mapa-use-cases.js';
import { createRedisCache } from '../src/infrastructure/redis-cache.js';

const espacio = {
  id: 'espacio-1',
  nombre: 'Cancha central',
  tipo: 'CANCHA',
  edificio: 'A',
  piso: 1,
  descripcion: '',
  coordenadas: null,
  activo: true
};

function createFakeRedisClient({ batches = [], scanError } = {}) {
  return {
    isOpen: false,
    isReady: true,
    on() {},
    async *scanIterator() {
      if (scanError) throw scanError;
      yield* batches;
    },
    async del(keys) {
      this.deletedBatches.push(keys);
      return keys.length;
    },
    deletedBatches: []
  };
}

test('invalida lotes SCAN planos con DEL en redis@5', async () => {
  const client = createFakeRedisClient({
    batches: [
      ['cache:espacio:espacio-1', 'cache:espacios:tipo:ausente:activo:ausente'],
      ['cache:espacios:tipo:CANCHA:activo:true']
    ]
  });
  const cache = createRedisCache({
    url: 'redis://unused',
    client
  });

  const invalidated = await cache.invalidateByPrefix('cache:espacio');

  assert.equal(invalidated, true);
  assert.deepEqual(client.deletedBatches, [
    ['cache:espacio:espacio-1', 'cache:espacios:tipo:ausente:activo:ausente'],
    ['cache:espacios:tipo:CANCHA:activo:true']
  ]);
  assert.ok(client.deletedBatches.flat().every((key) => typeof key === 'string'));
});

test('una falla de Redis durante SCAN no propaga el error', async () => {
  const client = createFakeRedisClient({
    scanError: new Error('Redis desconectado')
  });
  const cache = createRedisCache({
    url: 'redis://unused',
    client
  });

  const invalidated = await cache.invalidateByPrefix('cache:espacio');

  assert.equal(invalidated, false);
  assert.deepEqual(client.deletedBatches, []);
});

test('las mutaciones invalidan después de MongoDB y conservan eventos si Redis falla', async () => {
  const invalidationPrefixes = [];
  const publishedEvents = [];
  const executionOrder = [];
  const cache = {
    async getJson() {
      return { status: 'UNAVAILABLE', value: null };
    },
    async setJson() {
      return false;
    },
    async invalidateByPrefix(prefix) {
      executionOrder.push('invalidate');
      invalidationPrefixes.push(prefix);
      return false;
    }
  };
  const repository = {
    async create() {
      executionOrder.push('create');
      return { ...espacio, id: 'espacio-2' };
    },
    async requireById() {
      executionOrder.push('require');
      return espacio;
    },
    async update(id, changes) {
      executionOrder.push(`update:${changes.activo}`);
      return { ...espacio, id, ...changes };
    },
    async findById() {
      return espacio;
    },
    async findAll() {
      return [espacio];
    }
  };
  const useCases = createMapaUseCases({
    repository,
    cache,
    eventPublisher: {
      async publish(type) {
        executionOrder.push(`event:${type}`);
        publishedEvents.push(type);
      }
    }
  });

  await useCases.crearEspacio({
    nombre: 'Nueva cancha',
    tipo: 'CANCHA',
    edificio: 'A',
    piso: 1
  });
  await useCases.desactivarEspacio('espacio-1');
  await useCases.activarEspacio('espacio-1');

  assert.deepEqual(invalidationPrefixes, [
    'cache:espacio',
    'cache:espacio',
    'cache:espacio'
  ]);
  assert.deepEqual(publishedEvents, [
    'ESPACIO_CREADO',
    'ESPACIO_DESACTIVADO',
    'ESPACIO_ACTIVADO'
  ]);
  assert.deepEqual(executionOrder, [
    'create',
    'invalidate',
    'event:ESPACIO_CREADO',
    'require',
    'update:false',
    'invalidate',
    'event:ESPACIO_DESACTIVADO',
    'require',
    'update:true',
    'invalidate',
    'event:ESPACIO_ACTIVADO'
  ]);
});
