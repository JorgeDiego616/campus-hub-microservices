import { createClient } from 'redis';

// Caché tolerante a fallas: si Redis no responde, devuelve null y el sistema usa MongoDB.
export function createCache(url) {
  const client = createClient({ url });
  client.on('error', (error) => console.warn(`⚠️ Redis (academico): ${error.message}`));

  // Sin await: si Redis no está, el servicio arranca igual y funciona sin caché.
  client
    .connect()
    .then(() => console.log('⚡ Redis conectado (caché de horarios).'))
    .catch((error) => console.warn(`⚠️ Redis no disponible; se trabajará sin caché: ${error.message}`));

  return {
    async get(key) {
      if (!client.isReady) return null;
      try {
        const value = await client.get(key);
        if (value === null) {
          console.log(`📦 CACHE MISS: ${key}`);
          return null;
        }
        console.log(`📦 CACHE HIT: ${key}`);
        return JSON.parse(value);
      } catch (error) {
        console.warn(`⚠️ Error leyendo la caché: ${error.message}`);
        return null;
      }
    },

    async set(key, value, ttlSeconds) {
      if (!client.isReady) return;
      try {
        await client.setEx(key, ttlSeconds, JSON.stringify(value));
        console.log(`📦 CACHE SET: ${key} (TTL: ${ttlSeconds}s)`);
      } catch (error) {
        console.warn(`⚠️ Error guardando en la caché: ${error.message}`);
      }
    },

    async del(keys) {
      if (!keys.length || !client.isReady) return;
      try {
        await client.del(keys);
        console.log(`📦 CACHE DEL: ${keys.join(', ')}`);
      } catch (error) {
        console.warn(`⚠️ Error invalidando la caché: ${error.message}`);
      }
    }
  };
}