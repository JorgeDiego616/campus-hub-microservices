import mongoose from 'mongoose';
export async function connectMongo(mongoUri) { await mongoose.connect(mongoUri); }
