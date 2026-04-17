require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const Razorpay = require('razorpay');

const Item = require('./models/Item');
const User = require('./models/User');
const Booking = require('./models/Booking');

const app = express();
app.use(cors()); 
app.use(express.json()); 

mongoose.connect(process.env.MONGO_URI).then(() => console.log('✅ Backend Engine Online'));

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

const storage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: { folder: 'easy-renting', allowed_formats: ['jpg', 'png', 'jpeg'] },
});
const upload = multer({ storage: storage });

// --- RAZORPAY CONFIG ---
// ⚠️ Replace these with your actual keys from the Razorpay Dashboard
const razorpayInstance = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID || 'rzp_test_SeWuMDlMo3ENSg',
  key_secret: process.env.RAZORPAY_KEY_SECRET || 'kjY2LgvU4jBogJfhmfJFZ0ok'
});

const protect = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ message: "Auth required" });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded.userId; 
    next();
  } catch (error) { res.status(401).json({ message: "Session expired" }); }
};

// --- AUTH ---
app.post('/api/auth/register', async (req, res) => {
  try {
    const hashedPassword = await bcrypt.hash(req.body.password, 10);
    const newUser = new User({ email: req.body.email, password: hashedPassword });
    await newUser.save();
    res.status(201).json({ message: 'User created' });
  } catch (err) { res.status(400).json({ message: 'User exists' }); }
});

app.post('/api/auth/login', async (req, res) => {
  const user = await User.findOne({ email: req.body.email });
  if (user && (await bcrypt.compare(req.body.password, user.password))) {
    const token = jwt.sign({ userId: user._id }, process.env.JWT_SECRET, { expiresIn: '1h' });
    res.json({ token, userId: user._id });
  } else { res.status(401).json({ message: 'Invalid credentials' }); }
});

// --- ITEMS ---
app.get('/api/items', async (req, res) => {
  const items = await Item.find().populate('user', 'email');
  const itemsWithStock = await Promise.all(items.map(async (item) => {
    const activeBookings = await Booking.countDocuments({ item: item._id, status: 'Confirmed' });
    return { ...item._doc, availableQuantity: item.quantity - activeBookings };
  }));
  res.json(itemsWithStock);
});

app.get('/api/items/my', protect, async (req, res) => {
  const items = await Item.find({ user: req.user });
  res.json(items);
});

app.get('/api/items/:id', async (req, res) => {
  try {
    const item = await Item.findById(req.params.id).populate('user', 'email');
    const activeBookings = await Booking.countDocuments({ item: item._id, status: 'Confirmed' });
    res.json({ ...item._doc, availableQuantity: item.quantity - activeBookings });
  } catch (err) { res.status(404).json({ message: "Not found" }); }
});

app.post('/api/items', protect, upload.array('images', 5), async (req, res) => {
  try {
    const imageUrls = req.files.map(file => file.path);
    const newItem = new Item({ ...req.body, user: req.user, imageUrls });
    await newItem.save();
    res.status(201).json(newItem);
  } catch (err) { res.status(500).json({ message: 'Error' }); }
});

app.put('/api/items/:id', protect, upload.array('images', 5), async (req, res) => {
  try {
    const item = await Item.findById(req.params.id);
    if (item.user.toString() !== req.user) return res.status(401).json({ message: "Unauthorized" });
    let keptUrls = req.body.existingImages ? (Array.isArray(req.body.existingImages) ? req.body.existingImages : [req.body.existingImages]) : [];
    const newUrls = req.files.map(file => file.path);
    const updated = await Item.findByIdAndUpdate(req.params.id, { ...req.body, imageUrls: [...keptUrls, ...newUrls] }, { new: true });
    res.json(updated);
  } catch (err) { res.status(500).json({ message: "Update failed" }); }
});

app.delete('/api/items/:id', protect, async (req, res) => {
  const item = await Item.findById(req.params.id);
  if (item && item.user.toString() === req.user) { await item.deleteOne(); res.json({ message: "Deleted" }); }
});

// --- PAYMENTS & BOOKINGS ---
app.post('/api/payments/create-order', protect, async (req, res) => {
  try {
    const { amount } = req.body; 
    const options = {
      amount: Math.round(amount * 100), // Rounds to prevent decimal crashing
      currency: "INR", // REQUIRED BY RAZORPAY TEST ACCOUNTS
      receipt: `receipt_${Date.now()}`
    };
    const order = await razorpayInstance.orders.create(options);
    res.json(order);
  } catch (err) { 
    console.error("Razorpay Error:", err);
    res.status(500).json({ message: "Failed to initialize payment gateway" }); 
  }
});


// Add this below the other booking routes
app.get('/api/bookings/owner', protect, async (req, res) => {
  try {
    // Fetch all bookings where this user is the seller
    const bookings = await Booking.find({ seller: req.user })
      .populate('item', 'title imageUrls pricePerDay')
      .populate('buyer', 'email _id') // Gets the customer's email
      .sort({ createdAt: -1 }); // Shows newest orders first
    res.json(bookings);
  } catch (err) { 
    res.status(500).json({ message: "Failed to fetch owner dashboard data" }); 
  }
});

app.post('/api/bookings', protect, async (req, res) => {
  try {
    // We don't even need sellerId from the frontend anymore
    const { itemId, totalPrice, startDate, endDate, razorpayPaymentId, razorpayOrderId, razorpaySignature } = req.body;

    const secret = process.env.RAZORPAY_KEY_SECRET || 'kjY2LgvU4jBogJfhmfJFZ0ok'; // Your real secret
    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(razorpayOrderId + "|" + razorpayPaymentId);
    const generatedSignature = hmac.digest('hex');

    if (generatedSignature !== razorpaySignature) {
      return res.status(400).json({ message: "Payment verification failed." });
    }

    // Lookup the item from the database
    const item = await Item.findById(itemId);
    
    const overlapping = await Booking.countDocuments({ item: itemId, status: 'Confirmed', $or: [{ startDate: { $lte: new Date(endDate) }, endDate: { $gte: new Date(startDate) } }] });
    if (overlapping >= item.quantity) return res.status(400).json({ message: "Stock became unavailable." });

    // THE FIX: Assign the seller directly from the database item!
    const newBooking = new Booking({ 
      item: itemId, 
      buyer: req.user, 
      seller: item.user, // Guaranteed to be the correct Owner ID
      totalPrice, 
      startDate, 
      endDate, 
      paymentId: razorpayPaymentId 
    });
    
    await newBooking.save();
    res.status(201).json(newBooking);
  } catch (err) { 
    console.error("Booking Error:", err);
    res.status(500).json({ message: "Booking failed" }); 
  }
});

app.get('/api/bookings/my', protect, async (req, res) => {
  const bookings = await Booking.find({ buyer: req.user }).populate('item');
  res.json(bookings);
});


// --- OWNER DASHBOARD ROUTE ---
app.get('/api/bookings/owner', protect, async (req, res) => {
  try {
    // Standard Mongoose query
    const bookings = await Booking.find({ seller: req.user })
      .populate('item', 'title imageUrls pricePerDay')
      .populate('buyer', 'email _id') 
      .sort({ createdAt: -1 }); 
      
    res.json(bookings);
  } catch (err) { 
    console.error("Owner Dashboard Error:", err);
    res.status(500).json({ message: "Failed to fetch owner dashboard data" }); 
  }
});

app.listen(5000, () => console.log('🚀 Port 5000 Live'));