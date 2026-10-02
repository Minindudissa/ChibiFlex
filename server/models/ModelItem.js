import mongoose from 'mongoose';

const modelItemSchema = new mongoose.Schema({
  title: {
    type: String,
    trim: true,
    default: '',
  },
  category: {
    type: String,
    required: true,
    trim: true,
    lowercase: true,
    index: true,
  },
  imageUrl: {
    type: String,
    required: true,
  },
  imageKey: {
    type: String,
    default: '',
  },
  order: {
    type: Number,
    default: 0,
  },
  isCurrentMonthly: {
    type: Boolean,
    default: false,
    index: true,
  },
  releaseMonth: {
    type: String,
    trim: true,
    default: '',
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

export const ModelItem = mongoose.model('ModelItem', modelItemSchema);
