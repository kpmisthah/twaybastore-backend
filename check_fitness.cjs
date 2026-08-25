const mongoose = require("mongoose");

mongoose.connect("mongodb+srv://twaybastore_db_user:Twayba76512q@cluster0.vtowr7z.mongodb.net/twayba?retryWrites=true&w=majority")
  .then(async () => {
    const products = await mongoose.connection.db.collection('products').find({ category: "Fitness" }).toArray();
    console.log("Total fitness products:", products.length);
    products.forEach(p => {
      console.log(`- ${p.name} | subCategory: ${p.subCategory}`);
    });
    process.exit(0);
  })
  .catch(console.error);
