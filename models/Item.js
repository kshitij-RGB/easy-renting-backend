const mongoose = require('mongoose');

const itemSchema = new mongoose.Schema({
  title: { type: String, required: true },
  description: { type: String, required: true },
  pricePerDay: { type: Number, required: true },
  quantity: { type: Number, default: 1 },
  category: { type: String, default: 'Other' }, // NEW: Category Field
  imageUrls: [{ type: String }], 
  city: { type: String, default: 'Indore' }, // NEW: City Field
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }
}, { timestamps: true }); // NEW: Enables sorting by newest

module.exports = mongoose.model('Item', itemSchema);