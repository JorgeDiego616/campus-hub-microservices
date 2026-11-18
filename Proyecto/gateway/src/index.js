import 'dotenv/config';

import { ApolloServer } from '@apollo/server';
import { startStandaloneServer } from '@apollo/server/standalone';
import {
  ApolloGateway,
  IntrospectAndCompose,
  RemoteGraphQLDataSource
} from '@apollo/gateway';
import {
  applyAuthenticatedHeaders,
  authenticateActiveSession,
  requireJwtSecret
} from './authentication.js';
import { createRedisSessionStore } from './redis-session-store.js';
import { createRbacGraph, rbacPlugin } from './rbac-neo4j.js';
import { initRabbitMQ, emitirEventoSeguridad } from './rabbitmq.js';

const jwtSecret = requireJwtSecret(process.env.JWT_SECRET);  // lee el JWT_SECRET
const redisUrl = process.env.REDIS_URL;  // lee el REDIS_URL

if (typeof redisUrl !== 'string' || redisUrl.trim().length === 0) {
  throw new Error(
    'REDIS_URL es obligatorio en Gateway para validar sesiones JWT activas.'
  );
}  // valida que REDIS_URL esté presente y no sea vacío

const sessionStore = createRedisSessionStore(redisUrl);  // crea un store de sesiones en Redis
await sessionStore.connect(); // conecta al store de sesiones en Redis

// Neo4j es quien decide si una mutación se puede ejecutar (RBAC).
// Los valores por defecto son los puertos que publica Docker Compose.
const rbacGraph = createRbacGraph({
  uri: process.env.NEO4J_URI || 'bolt://localhost:7688',
  user: process.env.NEO4J_USER || 'neo4j',
  password: process.env.NEO4J_PASSWORD || 'password123'
});

// RabbitMQ solo es para auditar los 403; si no conecta, el Gateway arranca igual.
await initRabbitMQ(process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost:5673');

const gateway = new ApolloGateway({  // crea un gateway de Apollo
  supergraphSdl: new IntrospectAndCompose({
    subgraphs: [ // Manda llamar a los servicios de seguridad, academico, deportes, mapa y auditoria
      {
        name: 'seguridad',
        url: process.env.SEGURIDAD_URL || 'http://localhost:4005/' // sino está definido seguridad, usa localhost:4005
      },
      {
        name: 'academico',
        url: process.env.ACADEMICO_URL || 'http://localhost:4004/' // sino está definido academico, usa localhost:4004
      },
      {
        name: 'deportes',
        url: process.env.DEPORTES_URL || 'http://localhost:4001/' // sino está definido deportes, usa localhost:4001
      },
      {
        name: 'mapa',
        url: process.env.MAPA_URL || 'http://localhost:4002/' // sino está definido mapa, usa localhost:4002
      },
      {
        name: 'auditoria',
        url: process.env.AUDITORIA_URL || 'http://localhost:4003/' // sino está definido auditoria, usa localhost:4003
      }
    ]
  }),
  buildService({ url }) {
    return new RemoteGraphQLDataSource({
      url,
      willSendRequest({ request, context }) { // agrega los headers de autenticación a cada request que se envía a los subservicios
        applyAuthenticatedHeaders(
          request.http.headers,
          context?.authentication
        );
      }
    });
  }
});

const server = new ApolloServer({
  gateway,
  plugins: [
    // Revisa cada mutación contra Neo4j antes de mandarla a los subgrafos.
    rbacPlugin({
      consultarPermiso: rbacGraph.consultarPermiso,
      // Si se bloquea, mando el intento a auditoría (sin token, solo ids).
      onAccessDenied: ({ actor, path, ip, motivo }) => {
        emitirEventoSeguridad({
          tipo_evento: 'ACCESS_DENIED',
          usuario_id: actor.id,
          ip_origen: ip || 'UNKNOWN',
          exito: false,
          motivo,
          metadata: {
            rol: actor.rol,
            operacion: path
          }
        });
      }
    })
  ]
});

const configuredPort = Number.parseInt(
  process.env.PORT_GATEWAY || '4000',
  10
);
const port =
  Number.isInteger(configuredPort) && configuredPort > 0
    ? configuredPort
    : 4000;

const { url } = await startStandaloneServer(server, {
  listen: {
    port
  },
  context: async ({ req }) => ({
    authentication: await authenticateActiveSession(
      req.headers.authorization,
      jwtSecret,
      sessionStore
    ),
    ip: req.socket?.remoteAddress // la IP solo se usa para el evento ACCESS_DENIED
  })
});

console.log(
  `🚀 API Gateway de Campus Hub levantado exitosamente en: ${url}`
);
