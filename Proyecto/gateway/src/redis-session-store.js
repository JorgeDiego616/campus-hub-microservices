import { createClient } from 'redis';

export function createRedisSessionStore(url) {
  const client = createClient({ url });

  client.on('error', (error) => {
    console.warn(`[gateway] Redis de sesiones: ${error.message}`);
  });

  return {
    async connect() {
      await client.connect();
      console.log('[gateway] Redis de sesiones conectado.');
    },

    async hasMatchingSession({ jti, actor }) {
      if (!client.isReady) return false;

      try {
        const rawSession = await client.get(`session:${jti}`);
        if (!rawSession) return false;

        const session = JSON.parse(rawSession);
        return (
          String(session.userId) === String(actor.id) &&
          session.rol === actor.rol
        );
      } catch (error) {
        console.warn(`[gateway] No se pudo validar la sesión Redis: ${error.message}`);
        return false;
      }
    }
  };
}
