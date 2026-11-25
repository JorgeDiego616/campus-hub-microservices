// Nota para mí: antes aquí solo estaban Mongo y Rabbit. Redis y Neo4j se
// leían sueltos en index.js y database.js, con defaults que no eran los de
// nuestro compose (localhost:6379 y neo4j://localhost:7687 con 'password').
// Entonces con INFRASTRUCTURE_MODE=docker seguía buscando localhost y
// tronaba. Ahora los 4 salen del perfil, igual que en academico-service.
const infrastructureProfiles = {
  local: {
    mongoUri: 'mongodb://admin:password123@localhost:27018/seguridad?authSource=admin',
    rabbitMqUrl: 'amqp://guest:guest@localhost:5673',
    redisUrl: 'redis://default:password123@localhost:6380',
    neo4jUri: 'bolt://localhost:7688'
  },
  docker: {
    // En docker uso el nombre del servicio del compose y el puerto interno.
    mongoUri: 'mongodb://admin:password123@mongodb:27017/seguridad?authSource=admin',
    rabbitMqUrl: 'amqp://guest:guest@rabbitmq:5672',
    redisUrl: 'redis://default:password123@redis-stack:6379',
    neo4jUri: 'bolt://neo4j:7687'
  }
};

function infrastructureProfile() {
  const mode = process.env.INFRASTRUCTURE_MODE || 'local';
  const profile = infrastructureProfiles[mode];

  if (!profile) {
    throw new Error('INFRASTRUCTURE_MODE debe ser "local" o "docker".');
  }

  return profile;
}

const profile = infrastructureProfile();
const jwtSecret = process.env.JWT_SECRET;

if (typeof jwtSecret !== 'string' || jwtSecret.trim().length === 0) {
  throw new Error(
    'JWT_SECRET es obligatorio en seguridad-service para firmar tokens.'
  );
}

const configuredPort = Number.parseInt(
  process.env.PORT_SEGURIDAD || '4005',
  10
);

export const runtimeConfig = {
  mongoUri: process.env.MONGODB_URI || profile.mongoUri,
  rabbitMqUrl: process.env.RABBITMQ_URL || profile.rabbitMqUrl,
  // Si pongo la variable en el .env le gana al perfil (sirve en la nube).
  redisUrl: process.env.REDIS_URL || profile.redisUrl,
  neo4jUri: process.env.NEO4J_URI || profile.neo4jUri,
  // Usuario y contraseña son iguales en local y docker (los del compose).
  neo4jUser: process.env.NEO4J_USER || 'neo4j',
  neo4jPassword: process.env.NEO4J_PASSWORD || 'password123',
  jwtSecret,
  port:
    Number.isInteger(configuredPort) && configuredPort > 0
      ? configuredPort
      : 4005
};
