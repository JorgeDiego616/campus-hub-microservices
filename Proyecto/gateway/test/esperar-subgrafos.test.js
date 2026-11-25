import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';

import { esperarSubgrafos, subgrafoResponde } from '../src/esperar-subgrafos.js';

const subgraphs = [
  { name: 'seguridad', url: 'http://seguridad/' },
  { name: 'academico', url: 'http://academico/' }
];

test('sigue cuando todos los subgrafos responden a la primera', async () => {
  let llamadas = 0;
  await esperarSubgrafos(subgraphs, {
    esperaMs: 0,
    responde: async () => {
      llamadas++;
      return true;
    }
  });
  assert.equal(llamadas, 2);
});

test('espera a un subgrafo que tarda en prender', async () => {
  // academico "prende" hasta el tercer intento
  let intentosAcademico = 0;
  await esperarSubgrafos(subgraphs, {
    esperaMs: 0,
    responde: async (url) => {
      if (url !== 'http://academico/') return true;
      intentosAcademico++;
      return intentosAcademico >= 3;
    }
  });
  assert.equal(intentosAcademico, 3);
});

test('truena con mensaje claro si un subgrafo nunca responde', async () => {
  await assert.rejects(
    esperarSubgrafos(subgraphs, {
      intentos: 2,
      esperaMs: 0,
      responde: async (url) => url !== 'http://academico/'
    }),
    /Subgrafos sin responder después de 2 intentos/
  );
});

test('subgrafoResponde: true con un servidor real y false si no hay nadie', async () => {
  const servidor = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"data":{"__typename":"Query"}}');
  });
  await new Promise((resolve) => servidor.listen(0, resolve));
  const { port } = servidor.address();

  try {
    assert.equal(await subgrafoResponde(`http://127.0.0.1:${port}/`), true);
  } finally {
    await new Promise((resolve) => servidor.close(resolve));
  }

  // mismo puerto, ya cerrado: nadie escucha
  assert.equal(await subgrafoResponde(`http://127.0.0.1:${port}/`), false);
});
