require('dotenv').config();
const mongoose = require('mongoose');
const Product = require('./models/Product');

mongoose.connect(process.env.MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(async () => {
    const product = await Product.findOne();
    console.log(product._id);
    console.log(product.price);
    process.exit(0);
  });
