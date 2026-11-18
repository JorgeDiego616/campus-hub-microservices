import amqp from 'amqplib';

// Productor de eventos de seguridad del Gateway.
// Uso la misma cola que seguridad-service ('transmisiones-auditoria') para que
// el worker de auditoría guarde también los ACCESS_DENIED en ScyllaDB sin
// cambiar nada del lado del consumidor.
// Es fail-safe: si RabbitMQ no está, el Gateway sigue funcionando normal.

const QUEUE_NAME = 'transmisiones-auditoria';
const RECONNECT_DELAY = 5000;

let connection = null;
let channel = null;
let reintentoProgramado = false;

// Si se cae o no conecta, vuelvo a intentar en 5 s.
// La bandera evita que se junten varios setTimeout (error + close).
function programarReconexion(url) {
  if (reintentoProgramado) return;
  reintentoProgramado = true;

  setTimeout(() => {
    reintentoProgramado = false;
    initRabbitMQ(url);
  }, RECONNECT_DELAY);
}

export async function initRabbitMQ(url) {
  try {
    connection = await amqp.connect(url);
    channel = await connection.createChannel();

    await channel.assertQueue(QUEUE_NAME, { durable: true });

    connection.on('error', (error) => {
      console.warn(`[gateway] RabbitMQ error de conexión: ${error.message}`);
    });

    connection.on('close', () => {
      console.warn('[gateway] RabbitMQ cerrado. Modo degradado, reintentando...');
      connection = null;
      channel = null;
      programarReconexion(url);
    });

    console.log(`[gateway] RabbitMQ conectado. Productor activo en [${QUEUE_NAME}].`);
    return true;
  } catch (error) {
    console.warn(`[gateway] RabbitMQ no disponible, sigo sin auditoría: ${error.message}`);
    connection = null;
    channel = null;
    programarReconexion(url);
    return false;
  }
}

export function emitirEventoSeguridad(evento) {
  if (!channel) return false;

  try {
    const timestamp = new Date().toISOString();

    // Misma forma { event, payload } que usa seguridad-service,
    // porque así es como lo lee el worker de auditoría.
    // CWE-532: aquí solo van ids, rol y la operación; nunca el token.
    const mensaje = {
      event: evento.tipo_evento,
      payload: {
        ...evento,
        fecha: timestamp,
        timestamp,
        fecha_dia: timestamp.slice(0, 10)
      }
    };

    return channel.sendToQueue(
      QUEUE_NAME,
      Buffer.from(JSON.stringify(mensaje)),
      { persistent: true }
    );
  } catch (error) {
    console.warn(`[gateway] Error no bloqueante al emitir evento: ${error.message}`);
    return false;
  }
}
