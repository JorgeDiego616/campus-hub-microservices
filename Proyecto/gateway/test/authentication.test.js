import assert from 'node:assert/strict';
import test from 'node:test';
import jwt from 'jsonwebtoken';

import {
  applyAuthenticatedHeaders,
  authenticateActiveSession,
  authenticateAuthorizationHeader
} from '../src/authentication.js';

const testSecret = 'gateway-test-secret';

test('acepta un JWT con sesión Redis activa y propaga solo su identidad', async () => {
  const token = jwt.sign(
    { id: 'usuario-admin', rol: 'ADMIN', jti: 'sesion-activa' },
    testSecret,
    { expiresIn: '1h' }
  );
  const authentication = await authenticateActiveSession(
    `Bearer ${token}`,
    testSecret,
    {
      async hasMatchingSession({ jti, actor }) {
        return jti === 'sesion-activa' && actor.id === 'usuario-admin';
      }
    }
  );
  const headers = new Headers({
    authorization: 'Bearer token-falsificado',
    'x-user-id': 'suplantado',
    'x-user-role': 'ADMIN'
  });

  applyAuthenticatedHeaders(headers, authentication);

  assert.deepEqual(authentication.actor, {
    id: 'usuario-admin',
    rol: 'ADMIN'
  });
  assert.equal(headers.get('authorization'), `Bearer ${token}`);
  assert.equal(headers.get('x-user-id'), 'usuario-admin');
  assert.equal(headers.get('x-user-role'), 'ADMIN');
});

test('rechaza token inválido, expirado, sin sesión o ausente y elimina encabezados suplantados', async () => {
  const expiredToken = jwt.sign(
    { id: 'usuario-admin', rol: 'ADMIN', jti: 'sesion-expirada' },
    testSecret,
    { expiresIn: -1 }
  );

  for (const authorization of [
    undefined,
    'Bearer token-inválido',
    `Bearer ${expiredToken}`
  ]) {
    const authentication = await authenticateActiveSession(
      authorization,
      testSecret,
      { async hasMatchingSession() { return false; } }
    );
    const headers = new Headers({
      'x-user-id': 'suplantado',
      'x-user-role': 'ADMIN'
    });

    applyAuthenticatedHeaders(headers, authentication);

    assert.equal(authentication.actor, null);
    assert.equal(headers.get('authorization'), null);
    assert.equal(headers.get('x-user-id'), null);
    assert.equal(headers.get('x-user-role'), null);
  }
});

test('exige jti y rechaza una sesión Redis que no corresponde al usuario', async () => {
  const tokenWithoutJti = jwt.sign(
    { id: 'usuario-admin', rol: 'ADMIN' },
    testSecret,
    { expiresIn: '1h' }
  );
  const tokenWithJti = jwt.sign(
    { id: 'usuario-admin', rol: 'ADMIN', jti: 'sesion-ajena' },
    testSecret,
    { expiresIn: '1h' }
  );

  assert.equal(
    authenticateAuthorizationHeader(`Bearer ${tokenWithoutJti}`, testSecret).actor,
    null
  );
  assert.equal(
    (await authenticateActiveSession(`Bearer ${tokenWithJti}`, testSecret, {
      async hasMatchingSession() { return false; }
    })).actor,
    null
  );
});

test('propaga roles dinámicos con formato válido sin convertirlos en ADMIN', async () => {
  const token = jwt.sign(
    { id: 'usuario-coordinador', rol: 'COORDINADOR', jti: 'sesion-dinamica' },
    testSecret,
    { expiresIn: '1h' }
  );

  const authentication = await authenticateActiveSession(
    `Bearer ${token}`,
    testSecret,
    { async hasMatchingSession() { return true; } }
  );

  assert.deepEqual(authentication.actor, {
    id: 'usuario-coordinador',
    rol: 'COORDINADOR'
  });
});
