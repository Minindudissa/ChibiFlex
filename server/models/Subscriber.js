import mongoose from 'mongoose';

const subscriberSchema = new mongoose.Schema({
  email: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    lowercase: true,
    index: true,
  },
  subscribedAt: {
    type: Date,
    default: Date.now,
  },
  source: {
    type: String,
    default: 'free-model-download',
  },
  status: {
    type: String,
    default: 'active',
  },
  isVerified: {
    type: Boolean,
    default: true,
  },
});

export const Subscriber = mongoose.model('Subscriber', subscriberSchema);
