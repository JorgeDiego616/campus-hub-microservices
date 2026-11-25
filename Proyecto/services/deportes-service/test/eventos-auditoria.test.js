import assert from 'node:assert/strict';
import test from 'node:test';
import jwt from 'jsonwebtoken';

import { createSportsUseCases } from '../src/application/sports-use-cases.js';
import { actorFromGatewayRequest } from '../src/infrastructure/gateway-identity.js';

// Antes los eventos de deportes llegaban a ScyllaDB con ip_origen = null y sin
// usuario_id. Aquí reviso que ahora sí lleven quién fue y desde qué IP.
// Uso un repositorio y un publicador falsos para no tocar Mongo ni RabbitMQ.

const secreto = 'deportes-test-secret';
const entrenador = { id: 'coach-1', rol: 'ENTRENADOR', ip_origen: '189.2.3.4', jti: 'sesion-1' };

function crearCasosDeUso() {
  const eventos = [];
  const equipo = { id: 'eq-1', nombre: 'Halcones', deporte: 'Fútbol', categoria: 'Varonil', practicas: [] };

  const useCases = createSportsUseCases({
    repositories: {
      equipoRepository: {
        async create(e) { return { ...e, id: 'eq-1' }; },
        async requireById() { return equipo; },
        async addPractica(_id, practica) {
          return { ...equipo, practicas: [{ ...practica, id: 'pr-1' }] };
        }
      }
    },
    eventPublisher: { async publish(event, payload) { eventos.push({ event, payload }); } }
  });

  return { useCases, eventos };
}

test('EQUIPO_REGISTRADO lleva usuario_id, ip_origen, jti y severidad', async () => {
  const { useCases, eventos } = crearCasosDeUso();
  await useCases.registrarEquipo(entrenador, { nombre: 'Halcones', deporte: 'Fútbol', categoria: 'varonil' }); // en minúsculas: se normaliza

  const { event, payload } = eventos[0];
  assert.equal(event, 'EQUIPO_REGISTRADO');
  assert.equal(payload.usuario_id, 'coach-1');
  assert.equal(payload.ip_origen, '189.2.3.4');
  assert.equal(payload.jti, 'sesion-1');
  assert.equal(payload.severidad, 'INFO');
  assert.equal(payload.metadata.rol, 'ENTRENADOR');
  assert.equal(payload.nombre, 'Halcones'); // los datos de antes siguen ahí
});

test('PRACTICA_REGISTRADA también lleva quién y desde dónde', async () => {
  const { useCases, eventos } = crearCasosDeUso();
  await useCases.registrarPractica(entrenador, {
    equipoId: 'eq-1', fecha: '2026-12-01', horaInicio: '10:00', horaFin: '11:00', ubicacionId: 'cancha-1'
  });

  const { event, payload } = eventos[0];
  assert.equal(event, 'PRACTICA_REGISTRADA');
  assert.equal(payload.usuario_id, 'coach-1');
  assert.equal(payload.ip_origen, '189.2.3.4');
  assert.equal(payload.practicaId, 'pr-1');
});

test('si el actor no trae IP queda UNKNOWN (nunca null)', async () => {
  const { useCases, eventos } = crearCasosDeUso();
  await useCases.registrarEquipo({ id: 'coach-1', rol: 'ENTRENADOR' }, { nombre: 'A', deporte: 'B', categoria: 'MIXTO' });
  assert.equal(eventos[0].payload.ip_origen, 'UNKNOWN');
});

test('la identidad del Gateway trae ip_origen (x-forwarded-for) y jti', () => {
  const token = jwt.sign({ id: 'coach-1', rol: 'ENTRENADOR', jti: 'sesion-1' }, secreto, { expiresIn: '1h' });
  const actor = actorFromGatewayRequest({
    headers: {
      authorization: `Bearer ${token}`,
      'x-user-id': 'coach-1',
      'x-user-role': 'ENTRENADOR',
      'x-forwarded-for': '189.2.3.4'
    }
  }, secreto);

  assert.deepEqual(actor, { id: 'coach-1', rol: 'ENTRENADOR', ip_origen: '189.2.3.4', jti: 'sesion-1' });
});

test('la identidad sigue rechazando x-user-* que no coinciden con el JWT', () => {
  const token = jwt.sign({ id: 'coach-1', rol: 'ENTRENADOR', jti: 'sesion-1' }, secreto, { expiresIn: '1h' });
  const actor = actorFromGatewayRequest({
    headers: { authorization: `Bearer ${token}`, 'x-user-id': 'otro', 'x-user-role': 'ADMIN' }
  }, secreto);
  assert.equal(actor, null);
});
