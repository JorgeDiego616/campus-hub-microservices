import assert from 'node:assert/strict';
import test from 'node:test';

import { crearFormatError, MENSAJE_ERROR_INTERNO } from '../src/format-error.js';

// Forma real que devolvía el Gateway cuando deportes respondía 401.
const errorEnvuelto = {
  message: '401: Unauthorized',
  path: ['allEquipos'],
  extensions: {
    code: 'UNAUTHENTICATED',
    response: {
      url: 'http://localhost:4001/',
      status: 401,
      statusText: 'Unauthorized',
      body: {
        errors: [{
          message: 'Se requiere una identidad autenticada.',
          extensions: { code: 'UNAUTHENTICATED' }
        }]
      }
    }
  }
};

const silencioso = () => {};

test('desenvuelve el error del subgrafo y ya no filtra la URL interna', () => {
  const r = crearFormatError({ log: silencioso })(errorEnvuelto);
  assert.equal(r.message, 'Se requiere una identidad autenticada.');
  assert.equal(r.extensions.code, 'UNAUTHENTICATED');
  assert.deepEqual(r.path, ['allEquipos']);
  assert.equal(JSON.stringify(r).includes('localhost:4001'), false);
});

test('en producción oculta el mensaje de los errores internos', () => {
  const logs = [];
  const r = crearFormatError({ produccion: true, log: (...a) => logs.push(a.join(' ')) })({
    message: 'Cast to ObjectId failed for value "xx" at path "_id" for model "Usuario"',
    extensions: { code: 'INTERNAL_SERVER_ERROR', stacktrace: ['C:\\Users\\...'] }
  });
  assert.equal(r.message, MENSAJE_ERROR_INTERNO);
  assert.equal(r.extensions.stacktrace, undefined);
  assert.match(logs[0], /Cast to ObjectId/); // el original sí queda en el log
});

test('en producción NO oculta errores de usuario (BAD_USER_INPUT, FORBIDDEN...)', () => {
  const r = crearFormatError({ produccion: true, log: silencioso })({
    message: 'La matrícula debe contener solo dígitos, entre 6 y 10 caracteres.',
    extensions: { code: 'BAD_USER_INPUT' }
  });
  assert.match(r.message, /matrícula/);
});

test('en local deja el mensaje interno para poder depurar', () => {
  const r = crearFormatError({ produccion: false, log: silencioso })({
    message: 'Cast to ObjectId failed',
    extensions: { code: 'INTERNAL_SERVER_ERROR' }
  });
  assert.equal(r.message, 'Cast to ObjectId failed');
});

test('un error envuelto sin código interno cuenta como interno', () => {
  const r = crearFormatError({ produccion: true, log: silencioso })({
    message: '500: Internal Server Error',
    extensions: { response: { url: 'http://x:1/', body: { errors: [{ message: 'detalle feo' }] } } }
  });
  assert.equal(r.message, MENSAJE_ERROR_INTERNO);
  assert.equal(r.extensions.code, 'INTERNAL_SERVER_ERROR');
});
