import mongoose from 'mongoose';

const otpVerificationSchema = new mongoose.Schema({
  email: {
    type: String,
    required: true,
    trim: true,
    lowercase: true,
    index: true,
  },
  otp: {
    type: String,
    required: true,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  expiresAt: {
    type: Date,
    required: true,
    index: { expires: 0 }, // MongoDB TTL auto-cleanup after expiry
  },
  verified: {
    type: Boolean,
    default: false,
  },
});

export const OtpVerification = mongoose.model('OtpVerification', otpVerificationSchema);
