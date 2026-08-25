const mongoose = require("mongoose");

mongoose.connect("mongodb+srv://twaybastore_db_user:Twayba76512q@cluster0.vtowr7z.mongodb.net/twayba?retryWrites=true&w=majority")
  .then(async () => {
    const products = await mongoose.connection.db.collection('products').find({ category: "Fitness" }).toArray();
    console.log("Total fitness products:", products.length);
    
    let accCount = 0;
    let suppCount = 0;

    for (let p of products) {
      const name = p.name.toLowerCase();
      let sub = "Fitness Accessories";
      
      if (name.includes("protein") || name.includes("creatine") || name.includes("whey") || name.includes("mass gainer") || name.includes("superior")) {
        sub = "Supplements";
        suppCount++;
      } else {
        accCount++;
      }
      
      await mongoose.connection.db.collection('products').updateOne(
        { _id: p._id },
        { $set: { subCategory: sub } }
      );
      
      console.log(`Updated: ${p.name} -> ${sub}`);
    }
    
    console.log(`Done! Accessories: ${accCount}, Supplements: ${suppCount}`);
    process.exit(0);
  })
  .catch(console.error);
