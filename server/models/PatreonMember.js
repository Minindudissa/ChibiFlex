import mongoose from 'mongoose';

const patreonMemberSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      default: 'Patreon Member',
      trim: true,
    },
    email: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
      index: true,
    },
    tier: {
      type: String,
      default: 'Free',
      trim: true,
    },
    patronStatus: {
      type: String,
      default: 'Free Member',
      trim: true,
    },
    isFreeMember: {
      type: String,
      default: 'Yes',
    },
    userId: {
      type: String,
      trim: true,
    },
    patronageSinceDate: {
      type: Date,
      default: Date.now,
    },
    status: {
      type: String,
      enum: ['active', 'inactive', 'unsubscribed'],
      default: 'active',
    },
    notes: {
      type: String,
      default: '',
    },
    emailsSent: [
      {
        templateKey: { type: String },
        subject: { type: String },
        sentAt: { type: Date, default: Date.now },
      },
    ],
  },
  {
    timestamps: true,
  }
);

export const PatreonMember = mongoose.model('PatreonMember', patreonMemberSchema, 'patreon_members');
