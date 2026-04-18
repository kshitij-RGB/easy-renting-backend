const mongoose = require('mongoose');

const itemSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  title: { type: String, required: true },
  description: { type: String, required: true },
  pricePerDay: { type: Number, required: true },
  quantity: { type: Number, default: 1 },
  category: { type: String, default: 'Other' },
  imageUrls: [{ type: String }], 
  city: { type: String, default: 'Indore' } // New field added safely!
}, { timestamps: true });

module.exports = mongoose.model('Item', itemSchema);