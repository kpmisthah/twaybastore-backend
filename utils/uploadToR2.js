import { PutObjectCommand } from "@aws-sdk/client-s3";
import { v4 as uuidv4 } from "uuid";
import { r2 } from "./r2Client.js";

export const uploadToR2 = async (file) => {
  const ext = file.originalname.split(".").pop();
  const key = `products/${uuidv4()}.${ext}`;

  await r2.send(
    new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: key,
      Body: file.buffer,
      ContentType: file.mimetype,
    })
  );

  return `${process.env.R2_PUBLIC_URL}/${key}`;
};