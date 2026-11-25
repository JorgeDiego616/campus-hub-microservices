import neo4j from 'neo4j-driver';

// Antes leía process.env directo con defaults viejos ('password' y el puerto
// 7687 de localhost). Ahora tomo todo del runtime-config para que el perfil
// local/docker decida a qué Neo4j conectarme.
import { runtimeConfig } from './runtime-config.js';

let driver;

export function getDriver() {
  if (!driver) {
    driver = neo4j.driver(
      runtimeConfig.neo4jUri,
      neo4j.auth.basic(
        runtimeConfig.neo4jUser,
        runtimeConfig.neo4jPassword
      )
    );
  }
  return driver;
}
