const mongoose = require('mongoose');
const messageSchema = new mongoose.Schema({
  sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  recipient: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  itemId: { type: mongoose.Schema.Types.ObjectId, ref: 'Item', required: true },
  text: { type: String, required: true },
  timestamp: { type: Date, default: Date.now }
}, { timestamps: true });
module.exports = mongoose.model('Message', messageSchema);