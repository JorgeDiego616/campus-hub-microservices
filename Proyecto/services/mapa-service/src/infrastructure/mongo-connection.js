import mongoose from 'mongoose';
import { runtimeConfig } from './runtime-config.js';

export async function connectMongo() {
  try {
    await mongoose.connect(runtimeConfig.mongoUri);

    console.log('🔥 Conexión exitosa a MongoDB (mapa-service).');
  } catch (error) {
    console.error(
      '❌ Error de conexión a MongoDB (mapa-service):',
      error.message
    );

    throw error;
  }
}