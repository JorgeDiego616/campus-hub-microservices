
import amqp from 'amqplib';

const QUEUE_NAME = 'transmisiones-auditoria';
const RECONNECT_DELAY = 5000;

let connection = null;
let channel = null;
let reintentoProgramado = false;

// Antes, si RabbitMQ se reiniciaba, la auditoría quedaba apagada hasta
// reiniciar seguridad-service. Ahora vuelvo a intentar conectar cada 5 s.
// La sesión del usuario nunca espera esto: corre en segundo plano.
// La bandera es para no programar dos reintentos a la vez (error + close).
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

    await channel.assertQueue(QUEUE_NAME, {
      durable: true
    });

    connection.on('error', (error) => {
      console.warn('[RabbitMQ] Error de conexión:', error.message);
    });

    connection.on('close', () => {
      console.warn('[RabbitMQ] Conexión cerrada. Modo degradado, reintentando...');
      connection = null;
      channel = null;
      programarReconexion(url);
    });

    console.log(
      `🐇 RabbitMQ conectado. Productor activo en [${QUEUE_NAME}].`
    );

    return true;

  } catch (error) {
    console.warn(
      '[RabbitMQ] Broker no disponible. Continuando sin auditoría:',
      error.message
    );

    connection = null;
    channel = null;

    // Si no estaba arriba al arrancar, también sigo intentando.
    programarReconexion(url);

    return false;
  }
}

export function emitirEventoSeguridad(evento) {
  if (!channel) {
    console.warn(
      '[RabbitMQ] Evento omitido: no existe conexión con el broker.'
    );
    return false;
  }

  try {
    const timestamp = new Date().toISOString();

    // Se conserva la estructura que actualmente consume Auditoría:
    // { event, payload }
    const mensaje = {
      event: evento.tipo_evento,
      payload: {
        ...evento,
        fecha: timestamp,
        timestamp,
        fecha_dia: timestamp.slice(0, 10)
      }
    };

    const buffer = Buffer.from(JSON.stringify(mensaje));

    const enviado = channel.sendToQueue(
      QUEUE_NAME,
      buffer,
      { persistent: true }
    );

    if (!enviado) {
      console.warn(
        '[RabbitMQ] Buffer de escritura lleno. Existe contrapresión.'
      );
    } else {
      console.log(
        `📨 Evento ${evento.tipo_evento} enviado a RabbitMQ.`
      );
    }

    return enviado;

  } catch (error) {
    console.warn(
      '[RabbitMQ] Error no bloqueante al emitir evento:',
      error.message
    );

    return false;
  }
}
