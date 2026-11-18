
import 'dotenv/config';

import { ApolloServer } from '@apollo/server';
import { startStandaloneServer } from '@apollo/server/standalone';
import { buildSubgraphSchema } from '@apollo/subgraph';
import { parse } from 'graphql';

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import cassandra from 'cassandra-driver';

import { runtimeConfig } from './infrastructure/runtime-config.js';
import { actorFromGatewayRequest } from './infrastructure/gateway-identity.js';
import { assertCanViewAudit } from './domain/authorization.js';
import { startRabbitConsumer, bucketDeHoy } from './worker-auditoria.js';

// --------------------------------------------------
// CONFIGURACIÓN
// --------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const typeDefs = parse(
  fs.readFileSync(
    path.join(__dirname, 'schema.graphql'),
    'utf8'
  )
);


// --------------------------------------------------
// SCYLLADB
// --------------------------------------------------

const scyllaClient = new cassandra.Client({
  contactPoints: [runtimeConfig.scyllaHost],
  localDataCenter: 'datacenter1',
  keyspace: 'system',
  protocolOptions: {
    port: runtimeConfig.scyllaPort
  }
});

async function initScyllaSchema() {
  try {
    await scyllaClient.connect();

    await scyllaClient.execute(`
      CREATE KEYSPACE IF NOT EXISTS auditoria
      WITH replication = {
        'class': 'SimpleStrategy',
        'replication_factor': 1
      }
    `);

    const clientAudit = new cassandra.Client({
      contactPoints: [runtimeConfig.scyllaHost],
      localDataCenter: 'datacenter1',
      keyspace: 'auditoria',
      protocolOptions: {
        port: runtimeConfig.scyllaPort
      }
    });

    await clientAudit.connect();

    // Diseño Query-First: primero pensé la pregunta y luego la tabla.
    // La pregunta forense es: "¿qué eventos de tipo X pasaron el día D, del más
    // reciente al más viejo?". Por eso:
    // - Clave de partición compuesta ((fecha_dia, tipo_evento)): cada día y tipo
    //   vive en su propia partición, así no se hace una partición gigante por día
    //   (por ejemplo un ataque de LOGIN_FAILED no llena la partición de los demás).
    // - Clustering (timestamp, evento_id): dentro de la partición quedan
    //   ordenados físicamente en disco por tiempo, DESC = lo más nuevo primero.
    // - evento_id es timeuuid: lleva el tiempo adentro y nunca se repite, aunque
    //   dos eventos caigan en el mismo milisegundo.
    // - default_time_to_live = 12 meses (31536000 s): los logs expiran solos.
    // La tabla vieja logs_auditoria no la borro, solo deja de usarse.
    await clientAudit.execute(`
      CREATE TABLE IF NOT EXISTS logs_eventos (
        fecha_dia text,
        tipo_evento text,
        timestamp timestamp,
        evento_id timeuuid,
        usuario_id text,
        ip_origen text,
        severidad text,
        detalle text,
        PRIMARY KEY ((fecha_dia, tipo_evento), timestamp, evento_id)
      ) WITH CLUSTERING ORDER BY (timestamp DESC, evento_id DESC)
        AND default_time_to_live = 31536000
    `);

    // Tabla de apoyo (también Query-First): como la partición pide el tipo de
    // evento, necesito saber qué tipos hubo en un día para poder consultarlos
    // todos sin hacer un SELECT sin WHERE (que recorre todo el cluster).
    await clientAudit.execute(`
      CREATE TABLE IF NOT EXISTS tipos_evento_por_dia (
        fecha_dia text,
        tipo_evento text,
        PRIMARY KEY (fecha_dia, tipo_evento)
      ) WITH default_time_to_live = 31536000
    `);

    console.log(
      'ScyllaDB (Dominio de Auditoría) conectado y esquema de base de datos verificado.'
    );

    return clientAudit;

  } catch (err) {
    console.warn(
      '⚠️ No se pudo iniciar ScyllaDB:',
      err.message
    );

    return null;
  }
}

const auditDb = await initScyllaSchema();

// --------------------------------------------------
// WORKER CONSUMIDOR (RabbitMQ -> ScyllaDB)
// --------------------------------------------------

// El worker vive en worker-auditoria.js; aquí solo lo arranco con la
// conexión de ScyllaDB. Corre en segundo plano y no bloquea el servidor GraphQL.
startRabbitConsumer(auditDb).catch(error => {
  console.error(
    'Error fatal del Worker:',
    error.message
  );
});

// --------------------------------------------------
// GRAPHQL RESOLVERS
// --------------------------------------------------

const resolvers = {

  Query: {

    // tipoEvento y fecha son opcionales para no romper a quien ya la usaba.
    // Sin fecha uso el día de hoy; sin tipoEvento consulto todos los del día.
    buscarLogsAuditoria: async (_, { limite, tipoEvento, fecha }, { actor }) => {

      assertCanViewAudit(actor);

      if (!auditDb) return [];

      const fechaDia = fecha ?? bucketDeHoy();

      // Validar antes de consultar: la fecha debe ser AAAA-MM-DD y el límite razonable.
      if (!/^\d{4}-\d{2}-\d{2}$/.test(fechaDia)) return [];
      const limiteSeguro = Math.min(Math.max(limite, 1), 500);

      try {

        // 1) ¿Qué tipos de evento hubo ese día? (o solo el que me pidieron)
        let tipos = [tipoEvento];

        if (!tipoEvento) {
          const resultTipos = await auditDb.execute(
            'SELECT tipo_evento FROM tipos_evento_por_dia WHERE fecha_dia = ?',
            [fechaDia],
            { prepare: true }
          );
          tipos = resultTipos.rows.map(row => row.tipo_evento);
        }

        // 2) Una consulta por partición (fecha_dia, tipo_evento). Cada una ya
        //    viene ordenada DESC desde disco; solo junto y vuelvo a ordenar.
        const porTipo = await Promise.all(
          tipos.map(tipo => auditDb.execute(
            `
              SELECT evento_id, tipo_evento, timestamp, detalle
              FROM logs_eventos
              WHERE fecha_dia = ? AND tipo_evento = ?
              LIMIT ?
            `,
            [fechaDia, tipo, limiteSeguro],
            { prepare: true }
          ))
        );

        return porTipo
          .flatMap(result => result.rows)
          .sort((a, b) => b.timestamp - a.timestamp)
          .slice(0, limiteSeguro)
          .map(row => ({
            id: row.evento_id.toString(),
            evento: row.tipo_evento,
            detalle: row.detalle,
            fecha: row.timestamp.toISOString()
          }));

      } catch (error) {

        console.error(
          'Error al consultar ScyllaDB:',
          error.message
        );

        return [];
      }
    }
  }
};

// --------------------------------------------------
// APOLLO SERVER
// --------------------------------------------------

const server = new ApolloServer({
  schema: buildSubgraphSchema([
    { typeDefs, resolvers }
  ])
});

const port = runtimeConfig.port;

const { url } = await startStandaloneServer(
  server,
  {
    listen: { port },

    context: async ({ req }) => ({
      actor: actorFromGatewayRequest(req, runtimeConfig.jwtSecret)
    })
  }
);

console.log(
  `🚀 📊 Subgrafo de Auditoría (ScyllaDB + RabbitMQ Consumer) levantado exitosamente en: ${url}`
);