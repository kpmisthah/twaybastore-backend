import dotenv from 'dotenv';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import User from './models/User.js';

dotenv.config();

mongoose.connect(process.env.MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(async () => {
    // 1. Get or create a dummy user
    let user = await User.findOne({ email: 'test@example.com' });
    if (!user) {
      user = await User.create({ email: 'test@example.com', password: 'password123', fullName: 'Test User' });
    }
    
    // 2. Generate token
    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: '1h' });
    console.log(token);
    console.log(user._id.toString());
    process.exit(0);
  });
