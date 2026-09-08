import 'dotenv/config';

import { ApolloServer } from '@apollo/server';
import { startStandaloneServer } from '@apollo/server/standalone';
import {
  ApolloGateway,
  IntrospectAndCompose
} from '@apollo/gateway';

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
      }
    ]
  })
});

const server = new ApolloServer({
  gateway
});

const port = Number.parseInt(
  process.env.PORT_GATEWAY || '4000',
  10
);

const { url } = await startStandaloneServer(server, {
  listen: {
    port
  }
});

console.log(
  `🚀 API Gateway de Campus Hub levantado exitosamente en: ${url}`
);