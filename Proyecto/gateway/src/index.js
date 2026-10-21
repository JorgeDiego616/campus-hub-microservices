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
  authenticateAuthorizationHeader,
  requireJwtSecret
} from './authentication.js';

const jwtSecret = requireJwtSecret(process.env.JWT_SECRET);

const gateway = new ApolloGateway({
  supergraphSdl: new IntrospectAndCompose({
    subgraphs: [
      {
        name: 'seguridad',
        url: process.env.SEGURIDAD_URL || 'http://localhost:4005/'
      },
      {
        name: 'academico',
        url: process.env.ACADEMICO_URL || 'http://localhost:4004/'
      },
      {
        name: 'deportes',
        url: process.env.DEPORTES_URL || 'http://localhost:4001/'
      },
      {
        name: 'mapa',
        url: process.env.MAPA_URL || 'http://localhost:4002/'
      },
      {
        name: 'auditoria',
        url: process.env.AUDITORIA_URL || 'http://localhost:4003/'
      }
    ]
  }),
  buildService({ url }) {
    return new RemoteGraphQLDataSource({
      url,
      willSendRequest({ request, context }) {
        applyAuthenticatedHeaders(
          request.http.headers,
          context?.authentication
        );
      }
    });
  }
});

const server = new ApolloServer({
  gateway
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
    authentication: authenticateAuthorizationHeader(
      req.headers.authorization,
      jwtSecret
    )
  })
});

console.log(
  `🚀 API Gateway de Campus Hub levantado exitosamente en: ${url}`
);
