const mongoose = require('mongoose');

mongoose.connect('mongodb+srv://twaybastore_db_user:Twayba76512q@cluster0.vtowr7z.mongodb.net/twayba?retryWrites=true&w=majority')
  .then(async () => {
    const db = mongoose.connection.db;
    const order = await db.collection('orders').findOne({ paymentIntentId: 'pi_3TR8htCpt7rCmR8A0OpZI4IO' });
    console.log(JSON.stringify(order, null, 2));
    process.exit(0);
  })
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
