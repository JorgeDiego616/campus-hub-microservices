import amqp from 'amqplib';
import cassandra from 'cassandra-driver';

import { runtimeConfig } from './infrastructure/runtime-config.js';

// Worker consumidor de auditoría.
// Lo separé de index.js para que quede claro qué parte es el servidor GraphQL
// (consultar logs) y qué parte es el worker (leer RabbitMQ y escribir en ScyllaDB).
// index.js solo le pasa la conexión de ScyllaDB ya lista y lo arranca.
//
// Lo importante del worker:
// - prefetch(50): RabbitMQ no me manda más de 50 mensajes sin confirmar, así
//   Node no se llena de memoria si llega una avalancha de eventos (contrapresión).
// - { prepare: true }: la consulta se prepara una vez y los valores viajan aparte,
//   entonces no se puede inyectar CQL y además es más rápido.
// - ack manual: solo quito el mensaje de la cola cuando ScyllaDB ya lo guardó.

const QUEUE_NAME = 'transmisiones-auditoria';
const DLQ_NAME = 'transmisiones-auditoria.dlq';

const PREFETCH_LIMIT = 50;
const MAX_RETRIES = 3;
const RECONNECT_DELAY = 5000;

// fecha_dia de hoy (AAAA-MM-DD, en UTC); index.js lo usa cuando no le pasan fecha.
export function bucketDeHoy() {
  return new Date().toISOString().slice(0, 10);
}

// --------------------------------------------------
// UTILIDAD DE ESPERA
// --------------------------------------------------

function esperar(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// --------------------------------------------------
// PROCESAMIENTO DE EVENTOS
// --------------------------------------------------

// Recibe auditDb como parámetro porque la conexión ahora se crea en index.js.
async function guardarEvento(auditDb, evento) {
  if (!auditDb) {
    throw new Error(
      'ScyllaDB no está disponible. No se puede guardar el evento.'
    );
  }

  // tipo_evento es parte de la clave de partición, no puede venir vacío.
  // Si viene mal, lanzo error y el mensaje se va a reintentos/DLQ.
  if (typeof evento?.event !== 'string' || evento.event.trim().length === 0) {
    throw new Error('El evento no trae tipo (event).');
  }

  const payload = evento.payload ?? {};

  // Uso la hora en que pasó el evento (la manda el productor), no la hora en que
  // el worker lo procesa. Si el mensaje se reintentó o estuvo en cola, la hora
  // forense sigue siendo la real. Si no trae fecha válida, uso la de ahora.
  let momento = new Date(payload.timestamp ?? payload.fecha ?? Date.now());
  if (Number.isNaN(momento.getTime())) momento = new Date();

  // fecha_dia sale del mismo momento para que siempre caiga en la partición correcta.
  const fechaDia = momento.toISOString().slice(0, 10);

  // timeuuid generado con la misma fecha del evento (lleva el tiempo adentro).
  const eventoId = cassandra.types.TimeUuid.fromDate(momento);

  const toText = (valor) => (valor === undefined || valor === null ? null : String(valor));

  // Batch para escribir el log y el índice del día juntos.
  // Los dos van con prepare: true (valores aparte = sin inyección CQL).
  await auditDb.batch(
    [
      {
        query: `
          INSERT INTO logs_eventos
            (fecha_dia, tipo_evento, timestamp, evento_id, usuario_id, ip_origen, severidad, detalle)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `,
        params: [
          fechaDia,
          evento.event,
          momento,
          eventoId,
          toText(payload.usuario_id),
          toText(payload.ip_origen),
          toText(payload.severidad),
          JSON.stringify(payload)
        ]
      },
      {
        query: 'INSERT INTO tipos_evento_por_dia (fecha_dia, tipo_evento) VALUES (?, ?)',
        params: [fechaDia, evento.event]
      }
    ],
    { prepare: true }
  );

  console.log(
    `💾 Evento ${evento.event} guardado en ScyllaDB.`
  );
}

// --------------------------------------------------
// REINTENTOS Y DEAD LETTER QUEUE
// --------------------------------------------------

async function manejarErrorMensaje(channel, msg, error) {
  const headers = msg.properties.headers || {};

  const intentos = Number(
    headers['x-retry-count'] || 0
  );

  try {
    if (intentos < MAX_RETRIES) {

      channel.sendToQueue(
        QUEUE_NAME,
        msg.content,
        {
          persistent: true,
          contentType: msg.properties.contentType,
          headers: {
            ...headers,
            'x-retry-count': intentos + 1
          }
        }
      );

      await channel.waitForConfirms();

      channel.ack(msg);

      console.warn(
        `🔄 Mensaje reencolado. Reintento ${intentos + 1}/${MAX_RETRIES}.`
      );

    } else {

      channel.sendToQueue(
        DLQ_NAME,
        msg.content,
        {
          persistent: true,
          contentType: msg.properties.contentType,
          headers: {
            ...headers,
            'x-retry-count': intentos,
            'x-error-message': error.message
          }
        }
      );

      await channel.waitForConfirms();

      channel.ack(msg);

      console.error(
        `☠️ Mensaje enviado a Dead Letter Queue después de ${MAX_RETRIES} reintentos.`
      );
    }

  } catch (publishError) {

    console.error(
      '❌ No se pudo reenviar el mensaje:',
      publishError.message
    );

    try {
      channel.nack(msg, false, true);
    } catch {
      console.error(
        'El canal se cerró antes de poder reencolar el mensaje.'
      );
    }
  }
}

// --------------------------------------------------
// CONSUMIDOR RABBITMQ
// --------------------------------------------------

export async function startRabbitConsumer(auditDb) {

  if (!auditDb) {
    console.error(
      '⚠️ Worker detenido: ScyllaDB no está disponible. Los mensajes permanecerán en RabbitMQ.'
    );
    return;
  }

  while (true) {

    let conn = null;
    let channel = null;

    try {

      console.log(
        '🐇 Conectando consumidor con RabbitMQ...'
      );

      conn = await amqp.connect(
        runtimeConfig.rabbitMqUrl
      );

      channel = await conn.createConfirmChannel();

      conn.on('error', error => {
        console.error(
          'RabbitMQ connection error:',
          error.message
        );
      });

      await channel.assertQueue(
        QUEUE_NAME,
        { durable: true }
      );

      await channel.assertQueue(
        DLQ_NAME,
        { durable: true }
      );

      await channel.prefetch(PREFETCH_LIMIT);

      console.log(
        `📥 Worker conectado. Prefetch configurado en ${PREFETCH_LIMIT}.`
      );

      console.log(
        `📥 Escuchando eventos en [${QUEUE_NAME}].`
      );

      await channel.consume(
        QUEUE_NAME,
        async msg => {

          if (msg === null) return;

          try {

            const content = JSON.parse(
              msg.content.toString()
            );

            console.log(
              '📨 Evento recibido de la cola:',
              content
            );

            await guardarEvento(auditDb, content);

            channel.ack(msg);

          } catch (error) {

            console.error(
              '❌ Error procesando evento:',
              error.message
            );

            await manejarErrorMensaje(
              channel,
              msg,
              error
            );
          }
        },
        { noAck: false }
      );

      await new Promise(resolve => {
        conn.once('close', resolve);
      });

      console.warn(
        '⚠️ Conexión RabbitMQ cerrada.'
      );

    } catch (error) {

      console.error(
        '❌ Error en el Worker RabbitMQ:',
        error.message
      );

    } finally {

      try {
        if (channel) {
          await channel.close();
        }
      } catch {}

      try {
        if (conn) {
          await conn.close();
        }
      } catch {}
    }

    console.log(
      `🔄 Intentando reconectar RabbitMQ en ${RECONNECT_DELAY / 1000} segundos...`
    );

    await esperar(RECONNECT_DELAY);
  }
}
