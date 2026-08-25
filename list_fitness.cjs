const mongoose = require("mongoose");

mongoose.connect("mongodb+srv://twaybastore_db_user:Twayba76512q@cluster0.vtowr7z.mongodb.net/twayba?retryWrites=true&w=majority")
  .then(async () => {
    const products = await mongoose.connection.db.collection('products').find({ category: "Fitness" }).toArray();
    
    let supplements = [];
    let accessories = [];

    for (let p of products) {
      if (p.subCategory === "Supplements") {
        supplements.push(p.name);
      } else {
        accessories.push(p.name);
      }
    }
    
    const fs = require("fs");
    let output = "## Supplements (3)\n";
    supplements.forEach(s => output += `- ${s}\n`);
    output += "\n## Fitness Accessories (76)\n";
    accessories.forEach(a => output += `- ${a}\n`);
    
    fs.writeFileSync("/home/misthah/Documents/Coding/work/ecommerce/Twayba_backend-master/fitness_list.md", output);
    console.log("Done");
    process.exit(0);
  })
  .catch(console.error);
