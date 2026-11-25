import 'dotenv/config';

import { ApolloServer } from '@apollo/server';
import { ApolloServerPluginDrainHttpServer } from '@apollo/server/plugin/drainHttpServer';
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
import { esperarSubgrafos } from './esperar-subgrafos.js';
import { obtenerClienteInfo, aplicarHeadersCliente } from './client-info.js';
import { crearFormatError } from './format-error.js';
import { crearServidorHttp, crearManejadorHttp } from './servidor-http.js';
import { crearManejadorRest } from './rest-eventos.js';

const jwtSecret = requireJwtSecret(process.env.JWT_SECRET);  // lee el JWT_SECRET

// En la nube va Caddy delante del Gateway; ahí pongo TRUST_PROXY=true para
// leer la IP real de X-Forwarded-For. En local se queda en false (no hay
// proxy y así nadie puede inventarse su IP con ese header).
const confiarEnProxy = process.env.TRUST_PROXY === 'true';
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

// Saqué la lista a una constante porque ahora la uso dos veces:
// para esperar a los subgrafos y para componer el supergrafo.
const subgraphs = [ // Manda llamar a los servicios de seguridad, academico, deportes, mapa y auditoria
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
];

// Antes de componer espero a que todos contesten; si no, IntrospectAndCompose
// truena a los ~9 s cuando falta alguno y se cae todo el Gateway.
await esperarSubgrafos(subgraphs);

const gateway = new ApolloGateway({  // crea un gateway de Apollo
  supergraphSdl: new IntrospectAndCompose({ subgraphs }),
  buildService({ url }) {
    return new RemoteGraphQLDataSource({
      url,
      willSendRequest({ request, context }) { // agrega los headers de autenticación a cada request que se envía a los subservicios
        applyAuthenticatedHeaders(
          request.http.headers,
          context?.authentication
        );
        // También les paso la IP y el user-agent del cliente real; si no,
        // seguridad y académico solo ven la conexión del Gateway ("::1").
        aplicarHeadersCliente(request.http.headers, context?.cliente);
      }
    });
  }
});

// Antes el contexto estaba escrito dentro de startStandaloneServer. Lo saqué
// a una función porque ahora lo usan dos entradas: GraphQL y el adaptador
// REST de eventos/QR. Así las dos validan la sesión exactamente igual.
async function construirContexto(req) {
  const cliente = obtenerClienteInfo(req, confiarEnProxy);

  return {
    authentication: await authenticateActiveSession(
      req.headers.authorization,
      jwtSecret,
      sessionStore
    ),
    cliente, // se reenvía a los subgrafos en willSendRequest
    ip: cliente.ip // la usa el evento ACCESS_DENIED del plugin RBAC
  };
}

// El servidor HTTP lo creo yo (servidor-http.js) en lugar de
// startStandaloneServer, para poder atender las rutas REST de la app.
// Primero se crea el servidor y luego Apollo, porque el plugin de drain
// necesita el servidor para cerrar bien las conexiones al apagar.
const servidorHttp = crearServidorHttp();

const server = new ApolloServer({
  gateway,
  // Desenvuelve los errores de los subgrafos (sin URLs internas) y, en la
  // nube (NODE_ENV=production), esconde los mensajes de errores internos.
  formatError: crearFormatError({
    produccion: process.env.NODE_ENV === 'production'
  }),
  plugins: [
    // Lo mismo que agregaba startStandaloneServer: al apagar (Ctrl+C o
    // docker stop) deja terminar las peticiones que ya estaban en curso.
    ApolloServerPluginDrainHttpServer({ httpServer: servidorHttp }),
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

// El adaptador REST ejecuta su operación GraphQL aquí mismo con
// executeOperation: pasa por el plugin RBAC, formatError y los subgrafos
// igual que una petición normal, con el contexto que ya armé.
async function ejecutarOperacion(query, variables, contextValue) {
  const respuesta = await server.executeOperation({ query, variables }, { contextValue });

  if (respuesta.body.kind !== 'single') {
    throw new Error('El adaptador REST no soporta respuestas incrementales.');
  }

  return respuesta.body.singleResult;
}

await server.start();

servidorHttp.on('request', crearManejadorHttp({
  apollo: server,
  construirContexto,
  manejadorRest: crearManejadorRest({ ejecutarOperacion, construirContexto })
}));

await new Promise((resolve, reject) => {
  servidorHttp.once('error', reject); // ej. EADDRINUSE: que truene con el error real
  servidorHttp.listen({ port }, resolve);
});

console.log(
  `🚀 API Gateway de Campus Hub levantado exitosamente en: http://localhost:${port}/`
);
console.log(
  '[gateway] REST de eventos/QR para la app: POST /qr, GET /events/{id}/capacity, /events, /registrations'
);
