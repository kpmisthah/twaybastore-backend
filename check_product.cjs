const mongoose = require('mongoose');
mongoose.connect('mongodb+srv://twaybastore_db_user:Twayba76512q@cluster0.vtowr7z.mongodb.net/twayba?retryWrites=true&w=majority')
  .then(async () => {
    const db = mongoose.connection.db;
    const product = await db.collection('products').findOne({ _id: new mongoose.Types.ObjectId("695150b2e70d67167c9cf4a0") });
    console.log(JSON.stringify(product, null, 2));
    process.exit(0);
  })
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
