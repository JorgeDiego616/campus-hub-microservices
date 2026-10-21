import { createClient } from 'redis';

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Adaptador Redis de mejor esfuerzo. MongoDB nunca depende de que Redis esté
 * disponible: todos los métodos devuelven un estado que permite al caso de uso
 * continuar con su fuente persistente.
 */
export function createRedisCache({
  url,
  ttlSeconds = 60,
  client = createClient({ url })
}) {
  let connectionAttempted = false;

  client.on('error', (error) => {
    console.warn(`[cache] Redis no disponible: ${formatError(error)}`);
  });

  async function connect() {
    if (connectionAttempted || client.isOpen) return;

    connectionAttempted = true;

    try {
      await client.connect();
      console.log('[cache] Conexión Redis lista.');
    } catch (error) {
      console.warn(`[cache] No se pudo conectar a Redis; se usará MongoDB: ${formatError(error)}`);
    }
  }

  function unavailable() {
    return !client.isReady;
  }

  async function getJson(key) {
    if (unavailable()) return { status: 'UNAVAILABLE', value: null };

    try {
      const value = await client.get(key);

      if (value === null) return { status: 'MISS', value: null };

      return { status: 'HIT', value: JSON.parse(value) };
    } catch (error) {
      console.warn(`[cache] Error al leer ${key}; se usará MongoDB: ${formatError(error)}`);
      return { status: 'UNAVAILABLE', value: null };
    }
  }

  async function setJson(key, value) {
    if (unavailable()) return false;

    try {
      await client.setEx(key, ttlSeconds, JSON.stringify(value));
      return true;
    } catch (error) {
      console.warn(`[cache] Error al guardar ${key}: ${formatError(error)}`);
      return false;
    }
  }

  async function invalidateByPrefix(prefix) {
    if (unavailable()) return false;

    try {
      let deletedKeys = 0;

      // redis@5 scanIterator devuelve lotes de claves (string[]), no una
      // clave individual. Se elimina cada lote plano para evitar pasar un
      // arreglo anidado a DEL y no acumular todas las claves en memoria.
      for await (const keys of client.scanIterator({
        MATCH: `${prefix}*`,
        COUNT: 100
      })) {
        if (keys.length === 0) continue;
        await client.del(keys);
        deletedKeys += keys.length;
      }

      console.log(`[cache] Invalidación ${prefix}*: ${deletedKeys} clave(s).`);
      return true;
    } catch (error) {
      console.warn(`[cache] Error al invalidar ${prefix}*: ${formatError(error)}`);
      return false;
    }
  }

  return {
    connect,
    getJson,
    setJson,
    invalidateByPrefix
  };
}
