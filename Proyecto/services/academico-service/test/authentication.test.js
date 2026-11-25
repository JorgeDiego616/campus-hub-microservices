import assert from 'node:assert/strict';
import test from 'node:test';
import jwt from 'jsonwebtoken';

import { AcademicUseCases } from '../src/application/academic-use-cases.js';
import { actorFromGatewayRequest } from '../src/infrastructure/gateway-identity.js';

const testSecret = 'academic-test-secret';

function validGatewayRequest() {
  const token = jwt.sign(
    { id: 'usuario-admin', rol: 'ADMIN', jti: 'sesion-academica' },
    testSecret,
    { expiresIn: '1h' }
  );

  return {
    headers: {
      authorization: `Bearer ${token}`,
      'x-user-id': 'usuario-admin',
      'x-user-role': 'ADMIN'
    }
  };
}

// Desde el commit f46bd09 el actor también trae ip_origen y jti (los usa el
// evento CONSULTA_DATOS_SENSIBLES). El código estaba bien; la prueba seguía
// esperando solo { id, rol } y por eso fallaba. Sin socket ni header la IP
// queda en 'UNKNOWN'.
test('acepta la identidad del Gateway únicamente si coincide con el JWT', () => {
  assert.deepEqual(
    actorFromGatewayRequest(validGatewayRequest(), testSecret),
    { id: 'usuario-admin', rol: 'ADMIN', ip_origen: 'UNKNOWN', jti: 'sesion-academica' }
  );
});

// El Gateway ahora manda la IP real del cliente en x-forwarded-for
// (gateway/src/client-info.js); académico la usa para la auditoría.
test('usa la IP que manda el Gateway en x-forwarded-for', () => {
  const request = validGatewayRequest();
  request.headers['x-forwarded-for'] = '189.2.3.4';
  assert.equal(actorFromGatewayRequest(request, testSecret).ip_origen, '189.2.3.4');
});

test('rechaza encabezados x-user falsificados o que no coinciden con el JWT', () => {
  assert.equal(
    actorFromGatewayRequest({
      headers: {
        'x-user-id': 'usuario-admin',
        'x-user-role': 'ADMIN'
      }
    }, testSecret),
    null
  );

  const request = validGatewayRequest();
  request.headers['x-user-id'] = 'otra-persona';
  assert.equal(actorFromGatewayRequest(request, testSecret), null);
});

test('acepta un rol dinámico autenticado, sin conceder permisos ADMIN', async () => {
  const token = jwt.sign(
    { id: 'usuario-coordinador', rol: 'COORDINADOR', jti: 'sesion-dinamica' },
    testSecret,
    { expiresIn: '1h' }
  );
  const actor = actorFromGatewayRequest({
    headers: {
      authorization: `Bearer ${token}`,
      'x-user-id': 'usuario-coordinador',
      'x-user-role': 'COORDINADOR'
    }
  }, testSecret);
  const useCases = new AcademicUseCases({
    repositories: { materias: { async create() {} } },
    eventPublisher: { async publish() {} }
  });

  assert.deepEqual(actor, {
    id: 'usuario-coordinador',
    rol: 'COORDINADOR',
    ip_origen: 'UNKNOWN',
    jti: 'sesion-dinamica'
  });
  await assert.rejects(
    () => useCases.crearMateria(actor, { nombre: 'Física', creditos: 8 }),
    /Solo ADMIN/
  );
});

test('crearMateria permite el actor ADMIN validado y conserva autorización por rol', async () => {
  const actor = actorFromGatewayRequest(validGatewayRequest(), testSecret);
  const created = [];
  const useCases = new AcademicUseCases({
    repositories: {
      materias: {
        async create(materia) {
          created.push(materia);
          return { id: 'materia-1', ...materia };
        }
      }
    },
    eventPublisher: { async publish() {} }
  });

  const result = await useCases.crearMateria(actor, {
    nombre: 'Matemáticas',
    creditos: 8
  });

  assert.deepEqual(result, {
    id: 'materia-1',
    nombre: 'Matemáticas',
    creditos: 8
  });
  assert.equal(created.length, 1);
  await assert.rejects(
    () => useCases.crearMateria({ id: 'usuario-1', rol: 'ESTUDIANTE' }, {
      nombre: 'Física',
      creditos: 8
    }),
    /Solo ADMIN/
  );
});
