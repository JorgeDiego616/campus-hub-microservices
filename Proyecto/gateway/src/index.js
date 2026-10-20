import 'dotenv/config';

import { ApolloServer } from '@apollo/server';
import { startStandaloneServer } from '@apollo/server/standalone';
import {
  ApolloGateway,
  IntrospectAndCompose,
  RemoteGraphQLDataSource
} from '@apollo/gateway';
import { createClient } from 'redis';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('❌ Falta JWT_SECRET en el .env del gateway (debe ser el mismo que usa seguridad).');
  process.exit(1);
}

// Redis: se usa para comprobar que la sesión (session:<jti>) sigue activa
const redisClient = createClient({
  url: process.env.REDIS_URL || 'redis://:password123@localhost:6380'
});
redisClient.on('error', (error) => console.warn('⚠️ Redis (gateway):', error.message));
redisClient
  .connect()
  .then(() => console.log('⚡ Redis conectado en el gateway.'))
  .catch((error) => console.warn('⚠️ Redis no disponible en el gateway:', error.message));

// Reenvía el token y la identidad ya validada a cada subgrafo
class AuthDataSource extends RemoteGraphQLDataSource {
  willSendRequest({ request, context }) {
    if (context.authorization) {
      request.http.headers.set('authorization', context.authorization);
    }
    if (context.user) {
      request.http.headers.set('x-user-id', context.user.id);
      request.http.headers.set('x-user-role', context.user.rol);
    }
  }
}

const gateway = new ApolloGateway({
  supergraphSdl: new IntrospectAndCompose({
    subgraphs: [
      { name: 'seguridad', url: process.env.SEGURIDAD_URL || 'http://localhost:4005/' },
      { name: 'academico', url: process.env.ACADEMICO_URL || 'http://localhost:4004/' },
      { name: 'deportes', url: process.env.DEPORTES_URL || 'http://localhost:4001/' },
      { name: 'mapa', url: process.env.MAPA_URL || 'http://localhost:4002/' }
    ]
  }),
  buildService({ url }) {
    return new AuthDataSource({ url });
  }
});

const server = new ApolloServer({ gateway });

const port = Number.parseInt(process.env.PORT_GATEWAY || '4000', 10);

const { url } = await startStandaloneServer(server, {
  listen: { port },
  context: async ({ req }) => {
    const authorization = req.headers.authorization || '';
    let user = null;

    if (authorization.startsWith('Bearer ') && redisClient.isReady) {
      try {
        // 1) ¿La firma es válida y no expiró?
        const decoded = jwt.verify(authorization.split(' ')[1], JWT_SECRET);
        // 2) ¿La sesión sigue viva en Redis?
        const sesion = await redisClient.get(`session:${decoded.jti}`);
        if (sesion) user = { id: decoded.id, rol: decoded.rol };
        else console.warn(`🔒 GATEWAY SESIÓN EXPIRADA: jti=${decoded.jti}, userId=${decoded.id}`);
      } catch (error) {
        console.warn('Gateway: token inválido o expirado:', error.message);
      }
    }

    return { authorization, user };
  }
});

console.log(`🚀 API Gateway de Campus Hub levantado exitosamente en: ${url}`);