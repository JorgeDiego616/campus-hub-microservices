import 'dotenv/config';

import { ApolloServer } from '@apollo/server';
import { startStandaloneServer } from '@apollo/server/standalone';
import { buildSubgraphSchema } from '@apollo/subgraph';
import { parse } from 'graphql';

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import mongoose from 'mongoose';

import { runtimeConfig } from './infrastructure/runtime-config.js';
import {
  createEquipoRepository,
  createEventoRepository,
  createRegistroEventoRepository
} from './infrastructure/mongoose-repositories.js';
import { createRabbitPublisher } from './infrastructure/rabbitmq-event-publisher.js';
import { createSportsUseCases } from './application/sports-use-cases.js';
import { createEventosUseCases } from './application/eventos-use-cases.js';
import { actorFromGatewayRequest } from './infrastructure/gateway-identity.js';

import {
  assertCanReadSports,
  assertCanManageSports,
  assertCanReadEvents
} from './domain/authorization.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const typeDefs = parse(
  fs.readFileSync(
    path.join(__dirname, 'schema.graphql'),
    'utf8'
  )
);

// --------------------------------------------------
// MongoDB
// --------------------------------------------------

async function conectarBaseDatos() {
  try {
    await mongoose.connect(runtimeConfig.mongoUri);

    console.log(
      '🔥 Conexión exitosa a MongoDB (deportes-service).'
    );
  } catch (error) {
    console.error(
      '❌ Error de conexión a MongoDB:',
      error.message
    );

    process.exit(1);
  }
}

// --------------------------------------------------
// Inicialización de dependencias
// --------------------------------------------------

async function main() {
  await conectarBaseDatos();

  const equipoRepository = createEquipoRepository();

  const eventPublisher = await createRabbitPublisher(
    runtimeConfig.rabbitMqUrl
  );

  const useCases = createSportsUseCases({
    repositories: {
      equipoRepository
    },
    eventPublisher
  });

  // Eventos y QR van en sus propios casos de uso (eventos-use-cases.js)
  // para no revolverlos con equipos y prácticas. Comparten el publicador.
  const eventosUseCases = createEventosUseCases({
    repositories: {
      eventoRepository: createEventoRepository(),
      registroEventoRepository: createRegistroEventoRepository()
    },
    eventPublisher
  });

  // ------------------------------------------------
  // GraphQL
  // ------------------------------------------------

  const resolvers = {
    Query: {
      verEquipo: async (_, { id }, { actor }) => {
        assertCanReadSports(actor);
        return useCases.verEquipo(id);
      },

      allEquipos: async (_, __, { actor }) => {
        assertCanReadSports(actor);
        return useCases.allEquipos();
      },

      reportePracticasPorDeporte: async (_, __, { actor }) => {
        assertCanReadSports(actor);
        return useCases.reportePracticasPorDeporte();
      },

      // ---------- Eventos y QR ----------
      // Las queries no pasan por el RBAC de Neo4j del Gateway (ese solo
      // revisa mutaciones), por eso aquí se pide sesión sí o sí.
      eventos: async (_, __, { actor }) => {
        assertCanReadEvents(actor);
        return eventosUseCases.eventos(actor);
      },

      evento: async (_, { id }, { actor }) => {
        assertCanReadEvents(actor);
        return eventosUseCases.evento(actor, id);
      },

      capacidadDeEvento: async (_, { eventoId }, { actor }) => {
        assertCanReadEvents(actor);
        return eventosUseCases.capacidadDeEvento(eventoId);
      },

      // Quién puede ver la lista (dueño o ADMIN) lo revisa el caso de uso,
      // porque necesita leer primero el evento para saber quién lo creó.
      registrosDeEvento: async (_, { eventoId }, { actor }) => {
        assertCanReadEvents(actor);
        return eventosUseCases.registrosDeEvento(actor, eventoId);
      }
    },

    Mutation: {
      registrarEquipo: async (_, { nombre, deporte, categoria }, { actor }) => {
        assertCanManageSports(actor);
        // Le paso el actor para que el evento de auditoría diga quién fue y su IP.
        return useCases.registrarEquipo(actor, { nombre, deporte, categoria });
      },

      registrarPractica: async (
        _,
        { equipoId, fecha, horaInicio, horaFin, ubicacionId },
        { actor }
      ) => {
        assertCanManageSports(actor);
        return useCases.registrarPractica(actor, {
          equipoId,
          fecha,
          horaInicio,
          horaFin,
          ubicacionId
        });
      },

      // El rol lo decide primero Neo4j en el Gateway; aquí va la segunda capa
      // (sesión obligatoria) y el caso de uso revisa lo que depende del
      // evento (ej. solo un gestor puede dar de alta un evento nuevo).
      crearEvento: async (_, { input }, { actor }) => {
        assertCanReadEvents(actor);
        return eventosUseCases.crearEvento(actor, input);
      },

      registrarAsistente: async (_, { input }, { actor }) => {
        assertCanReadEvents(actor);
        return eventosUseCases.registrarAsistente(actor, input);
      },

      crearQR: async (_, { input }, { actor }) => {
        assertCanReadEvents(actor);
        return eventosUseCases.crearQR(actor, input);
      }
    },

    Equipo: {
      __resolveReference: async (reference) => {
        return useCases.verEquipo(reference.id);
      }
    }
  };

  // ------------------------------------------------
  // Apollo Server
  // ------------------------------------------------

  const server = new ApolloServer({
    schema: buildSubgraphSchema([
      {
        typeDefs,
        resolvers
      }
    ])
  });

  const port = runtimeConfig.port;

  const { url } = await startStandaloneServer(server, {
    listen: {
      port
    },
    context: async ({ req }) => ({
      actor: actorFromGatewayRequest(req, runtimeConfig.jwtSecret)
    })
  });

  console.log(
    `🏅 Subgrafo de Deportes levantado exitosamente en: ${url}`
  );
}

main().catch((error) => {
  console.error(
    '❌ Error fatal al iniciar el subgrafo de Deportes:',
    error
  );

  process.exit(1);
});