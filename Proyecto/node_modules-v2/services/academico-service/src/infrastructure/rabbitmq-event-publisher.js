import amqp from 'amqplib';

const RECONNECT_DELAY = 5000;

// Fail-safe: si RabbitMQ se cae, académico tiene que seguir guardando en MongoDB.
// Antes no escuchaba 'error' en la conexión; cuando RabbitMQ se apagaba, amqplib
// emitía 'error' sin nadie escuchando y Node tumbaba todo el proceso.
// Además el channel se quedaba "muerto" y publish() lanzaba "Channel closed".
export class RabbitMqEventPublisher {
  constructor(url, queue = 'transmisiones-auditoria') { this.url = url; this.queue = queue; this.channel = null; this.reintentoProgramado = false; }

  async connect() {
    try {
      const connection = await amqp.connect(this.url);
      // Con esto el 'error' ya no truena el proceso, solo lo registro.
      connection.on('error', (error) => console.warn(`⚠️ RabbitMQ (academico): ${error.message}`));
      // Al cerrarse dejo channel en null para que publish() no use un canal cerrado.
      connection.on('close', () => { this.channel = null; this.programarReconexion(); });
      this.channel = await connection.createChannel();
      this.channel.on('error', (error) => console.warn(`⚠️ Canal RabbitMQ (academico): ${error.message}`));
      await this.channel.assertQueue(this.queue, { durable: true });
    } catch (error) {
      // Si no conecta, también sigo intentando en segundo plano.
      this.channel = null;
      this.programarReconexion();
      throw error;
    }
  }

  // Un solo reintento a la vez (la bandera evita juntar varios setTimeout).
  programarReconexion() {
    if (this.reintentoProgramado) return;
    this.reintentoProgramado = true;
    setTimeout(() => {
      this.reintentoProgramado = false;
      this.connect()
        .then(() => console.log('🐇 RabbitMQ (academico) reconectado.'))
        .catch(() => {});
    }, RECONNECT_DELAY);
  }

  async publish(event, payload) {
    if (!this.channel) return;
    // El try/catch es para que un fallo de auditoría nunca rompa la mutación.
    try {
      this.channel.sendToQueue(this.queue, Buffer.from(JSON.stringify({ event, payload: { ...payload, fecha: new Date() } })), { persistent: true });
    } catch (error) {
      console.warn(`⚠️ Evento ${event} no enviado (RabbitMQ): ${error.message}`);
    }
  }
}
