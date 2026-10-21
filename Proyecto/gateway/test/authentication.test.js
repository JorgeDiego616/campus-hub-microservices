import assert from 'node:assert/strict';
import test from 'node:test';
import jwt from 'jsonwebtoken';

import {
  applyAuthenticatedHeaders,
  authenticateAuthorizationHeader
} from '../src/authentication.js';

const testSecret = 'gateway-test-secret';

test('acepta un JWT válido y propaga solo su identidad', () => {
  const token = jwt.sign(
    { id: 'usuario-admin', rol: 'ADMIN' },
    testSecret,
    { expiresIn: '1h' }
  );
  const authentication = authenticateAuthorizationHeader(
    `Bearer ${token}`,
    testSecret
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

test('rechaza token inválido, expirado o ausente y elimina encabezados suplantados', () => {
  const expiredToken = jwt.sign(
    { id: 'usuario-admin', rol: 'ADMIN' },
    testSecret,
    { expiresIn: -1 }
  );

  for (const authorization of [
    undefined,
    'Bearer token-inválido',
    `Bearer ${expiredToken}`
  ]) {
    const authentication = authenticateAuthorizationHeader(
      authorization,
      testSecret
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
