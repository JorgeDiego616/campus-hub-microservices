import amqp from 'amqplib';

const QUEUE_NAME = 'transmisiones-auditoria';
const RECONNECT_DELAY = 5000;

// Fail-safe: si RabbitMQ se cae, Deportes tiene que seguir funcionando.
// Antes no había listener de 'error' en la conexión, entonces al hacer
// docker stop de RabbitMQ, amqplib emitía 'error' y Node tumbaba el proceso.
// También el channel se quedaba cerrado y sendToQueue lanzaba "Channel closed".
export async function createRabbitPublisher(rabbitMqUrl) {
  let channel = null;
  let reintentoProgramado = false;

  // Un solo reintento a la vez; la bandera evita que se junten varios.
  function programarReconexion() {
    if (reintentoProgramado) return;
    reintentoProgramado = true;

    setTimeout(() => {
      reintentoProgramado = false;
      conectar();
    }, RECONNECT_DELAY);
  }

  async function conectar() {
    try {
      const connection = await amqp.connect(rabbitMqUrl);

      // Con estos listeners el error solo se registra, ya no truena el proceso.
      connection.on('error', (error) => {
        console.warn('⚠️ RabbitMQ error en Deportes:', error.message);
      });

      // Al cerrarse, channel = null para que publish no use un canal muerto.
      connection.on('close', () => {
        console.warn('⚠️ RabbitMQ cerrado en Deportes. Reintentando...');
        channel = null;
        programarReconexion();
      });

      channel = await connection.createChannel();

      channel.on('error', (error) => {
        console.warn('⚠️ Canal RabbitMQ con error en Deportes:', error.message);
      });

      await channel.assertQueue(QUEUE_NAME, {
        durable: true
      });

      console.log('RabbitMQ conectado. Canal listo para Deportes.');

    } catch (error) {
      console.warn(
        '⚠️ RabbitMQ no disponible en Deportes:',
        error.message
      );
      channel = null;
      programarReconexion();
    }
  }

  await conectar();

  return {
    async publish(event, payload) {
      if (!channel) {
        console.warn(
          `⚠️ Evento ${event} no enviado porque RabbitMQ no está disponible.`
        );
        return;
      }

      const message = {
        event,
        payload: {
          ...payload,
          fecha: new Date()
        }
      };

      // Si el canal se cerró justo ahora, lo atrapo para no romper la mutación.
      try {
        channel.sendToQueue(
          QUEUE_NAME,
          Buffer.from(JSON.stringify(message)),
          {
            persistent: true
          }
        );

        console.log(
          `📨 Evento '${event}' enviado a RabbitMQ.`
        );
      } catch (error) {
        console.warn(
          `⚠️ Evento ${event} no enviado:`,
          error.message
        );
      }
    }
  };
}
