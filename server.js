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

// ==========================================
// --- 1. AUTH ROUTES ---
// ==========================================
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
    const token = jwt.sign({ userId: user._id }, process.env.JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, userId: user._id });
  } else { res.status(401).json({ message: 'Invalid credentials' }); }
});

// ==========================================
// --- 2. ITEM ROUTES ---
// ==========================================
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

// ==========================================
// --- 3. BOOKING & PAYMENT ROUTES ---
// ==========================================
app.post('/api/payments/create-order', protect, async (req, res) => {
  try {
    const { amount } = req.body; 
    const options = {
      amount: Math.round(amount * 100), 
      currency: "INR", 
      receipt: `receipt_${Date.now()}`
    };
    const order = await razorpayInstance.orders.create(options);
    res.json(order);
  } catch (err) { 
    console.error("Razorpay Error:", err);
    res.status(500).json({ message: "Failed to initialize payment gateway" }); 
  }
});

app.get('/api/bookings/owner', protect, async (req, res) => {
  try {
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

app.get('/api/bookings/my', protect, async (req, res) => {
  const bookings = await Booking.find({ buyer: req.user }).populate('item');
  res.json(bookings);
});

// CALENDAR ROUTE: Fetches dates to block on the frontend
// CALENDAR ROUTE: Only fetches dates that are COMPLETELY out of stock
app.get('/api/bookings/item/:itemId/dates', async (req, res) => {
  try {
    const { itemId } = req.params;
    
    // 1. Get the item so we know its max quantity
    const item = await Item.findById(itemId);
    if (!item) return res.status(404).json({ success: false, message: "Item not found" });

    // 2. Get all confirmed bookings for this item
    const bookings = await Booking.find({ item: itemId, status: 'Confirmed' });

    // 3. Create a dictionary to count how many times each specific date is booked
    const dateCounts = {};
    
    bookings.forEach(booking => {
      let curr = new Date(booking.startDate);
      const end = new Date(booking.endDate);
      
      // Loop through every single day of this booking
      while (curr <= end) {
        const dateStr = curr.toISOString().split('T')[0]; // Looks like '2026-04-18'
        dateCounts[dateStr] = (dateCounts[dateStr] || 0) + 1; // Add 1 to the count for this day
        curr.setDate(curr.getDate() + 1); // Move to next day
      }
    });

    // 4. Figure out which dates have hit the maximum quantity limit
    const fullyBookedDates = [];
    for (const [dateStr, count] of Object.entries(dateCounts)) {
      if (count >= item.quantity) {
        fullyBookedDates.push(dateStr); // Only block it if ALL stock is gone
      }
    }

    // Send only the fully booked dates to the frontend
    res.json({ success: true, fullyBookedDates: fullyBookedDates });
  } catch (error) {
    console.error("Error fetching dates:", error);
    res.status(500).json({ success: false, message: "Could not fetch booked dates" });
  }
});

app.post('/api/bookings', protect, async (req, res) => {
  try {
    const { itemId, totalPrice, startDate, endDate, razorpayPaymentId, razorpayOrderId, razorpaySignature } = req.body;

    const secret = process.env.RAZORPAY_KEY_SECRET || 'kjY2LgvU4jBogJfhmfJFZ0ok'; 
    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(razorpayOrderId + "|" + razorpayPaymentId);
    const generatedSignature = hmac.digest('hex');

    if (generatedSignature !== razorpaySignature) {
      return res.status(400).json({ message: "Payment verification failed." });
    }

    const item = await Item.findById(itemId);
    const overlapping = await Booking.countDocuments({ item: itemId, status: 'Confirmed', $or: [{ startDate: { $lte: new Date(endDate) }, endDate: { $gte: new Date(startDate) } }] });
    if (overlapping >= item.quantity) return res.status(400).json({ message: "Stock became unavailable." });

    const newBooking = new Booking({ 
      item: itemId, 
      buyer: req.user, 
      seller: item.user, 
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

app.listen(5000, () => console.log('🚀 Port 5000 Live'));