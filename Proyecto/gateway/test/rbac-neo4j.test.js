import assert from 'node:assert/strict';
import test from 'node:test';
import { parse } from 'graphql';

import { mutationFieldNames, rbacPlugin } from '../src/rbac-neo4j.js';

// Neo4j falso: así pruebo el plugin sin levantar Docker.
// permisos = { 'gql:algo': { publica, roles: [ids que sí pueden] } }
function neo4jFalso(permisos) {
  return async (userId, path) => {
    const regla = permisos[path];
    if (!regla) return { existe: false, publica: false, autorizado: false };
    return {
      existe: true,
      publica: regla.publica === true,
      autorizado: (regla.usuarios ?? []).includes(userId)
    };
  };
}

// Simula lo que hace Apollo: parsea el documento y llama didResolveOperation.
async function ejecutarPlugin(plugin, query, actor) {
  const document = parse(query);
  const operation = document.definitions.find((d) => d.kind === 'OperationDefinition');
  const hooks = await plugin.requestDidStart();
  return hooks.didResolveOperation({
    operation,
    document,
    contextValue: { authentication: { actor }, ip: '127.0.0.1' }
  });
}

const permisos = {
  'gql:login': { publica: true },
  'gql:registrarEquipo': { usuarios: ['entrenador-1', 'admin-1'] }
};

test('deja pasar una mutación si Neo4j encuentra el permiso (directo o heredado)', async () => {
  const plugin = rbacPlugin({ consultarPermiso: neo4jFalso(permisos) });
  await ejecutarPlugin(
    plugin,
    'mutation { registrarEquipo(nombre: "A", deporte: "B", categoria: "C") { id } }',
    { id: 'admin-1', rol: 'ADMIN' }
  );
});

test('bloquea con 403 FORBIDDEN y avisa a auditoría si el rol no tiene permiso', async () => {
  const denegados = [];
  const plugin = rbacPlugin({
    consultarPermiso: neo4jFalso(permisos),
    onAccessDenied: (evento) => denegados.push(evento)
  });

  await assert.rejects(
    () => ejecutarPlugin(
      plugin,
      'mutation { registrarEquipo(nombre: "A", deporte: "B", categoria: "C") { id } }',
      { id: 'estudiante-1', rol: 'ESTUDIANTE' }
    ),
    (error) => error.extensions.code === 'FORBIDDEN' && error.extensions.http.status === 403
  );
  assert.equal(denegados.length, 1);
  assert.equal(denegados[0].path, 'gql:registrarEquipo');
});

test('las mutaciones públicas pasan sin sesión y las privadas piden 401', async () => {
  const plugin = rbacPlugin({ consultarPermiso: neo4jFalso(permisos) });

  await ejecutarPlugin(plugin, 'mutation { login(email: "a", password: "b") { token } }', null);

  await assert.rejects(
    () => ejecutarPlugin(
      plugin,
      'mutation { registrarEquipo(nombre: "A", deporte: "B", categoria: "C") { id } }',
      null
    ),
    (error) => error.extensions.code === 'UNAUTHENTICATED'
  );
});

test('una mutación que no está en el catálogo se bloquea', async () => {
  const plugin = rbacPlugin({ consultarPermiso: neo4jFalso(permisos) });
  await assert.rejects(
    () => ejecutarPlugin(plugin, 'mutation { borrarTodo }', { id: 'admin-1', rol: 'ADMIN' }),
    (error) => error.extensions.code === 'FORBIDDEN'
  );
});

test('si Neo4j falla, no deja pasar la mutación (fail-closed)', async () => {
  const plugin = rbacPlugin({
    consultarPermiso: async () => { throw new Error('Neo4j caído'); }
  });
  await assert.rejects(
    () => ejecutarPlugin(
      plugin,
      'mutation { registrarEquipo(nombre: "A", deporte: "B", categoria: "C") { id } }',
      { id: 'admin-1', rol: 'ADMIN' }
    ),
    (error) => error.extensions.http.status === 503
  );
});

test('las queries no se revisan contra Neo4j', async () => {
  let llamadas = 0;
  const plugin = rbacPlugin({ consultarPermiso: async () => { llamadas++; } });
  await ejecutarPlugin(plugin, 'query { equipos { id } }', null);
  assert.equal(llamadas, 0);
});

test('usa el nombre real aunque venga con alias o dentro de un fragmento', () => {
  const document = parse(`
    mutation {
      inocente: registrarEquipo(nombre: "A", deporte: "B", categoria: "C") { id }
      ...Escondido
    }
    fragment Escondido on Mutation { crearRol(nombre: "X") { id } }
  `);
  const operation = document.definitions[0];
  const fragments = { Escondido: document.definitions[1] };

  assert.deepEqual(mutationFieldNames(operation, fragments), ['registrarEquipo', 'crearRol']);
});
