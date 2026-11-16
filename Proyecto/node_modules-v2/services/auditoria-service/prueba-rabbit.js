import amqp from 'amqplib';

const conn = await amqp.connect('amqp://guest:guest@localhost:5673');
const ch = await conn.createConfirmChannel();

ch.sendToQueue(
  'transmisiones-auditoria',
  Buffer.from('{esto-no-es-json'),
  { persistent: true }
);

await ch.waitForConfirms();

console.log('Mensaje de prueba publicado correctamente');

await ch.close();
await conn.close();
