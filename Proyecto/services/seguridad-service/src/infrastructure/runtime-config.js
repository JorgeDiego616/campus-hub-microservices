const infrastructureProfiles = {
  local: {
    mongoUri: 'mongodb://admin:password123@localhost:27018/seguridad?authSource=admin',
    rabbitMqUrl: 'amqp://guest:guest@localhost:5673'
  },
  docker: {
    mongoUri: 'mongodb://admin:password123@mongodb:27017/seguridad?authSource=admin',
    rabbitMqUrl: 'amqp://guest:guest@rabbitmq:5672'
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
  jwtSecret,
  port:
    Number.isInteger(configuredPort) && configuredPort > 0
      ? configuredPort
      : 4005
};
