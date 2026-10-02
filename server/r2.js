import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import path from 'path';
import crypto from 'crypto';
import dotenv from 'dotenv';

dotenv.config();

const endpoint = process.env.R2_ENDPOINT || `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
const bucketName = process.env.R2_BUCKET_NAME || 'chibiflex-bucket';
const publicUrl = (process.env.R2_PUBLIC_URL || '').replace(/\/+$/, '');

export const s3 = new S3Client({
  region: 'auto',
  endpoint: endpoint,
  credentials: {
    accessKeyId: (process.env.R2_ACCESS_KEY_ID || '').trim(),
    secretAccessKey: (process.env.R2_SECRET_ACCESS_KEY || '').trim(),
  },
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
});

/**
 * Uploads a file buffer to Cloudflare R2
 * @param {Buffer} buffer - File buffer
 * @param {string} originalname - Original file name
 * @param {string} mimetype - File mime type
 * @param {string} category - Category prefix folder
 * @returns {Promise<{ imageUrl: string, imageKey: string }>}
 */
export async function uploadToR2(buffer, originalname, mimetype, category = 'models') {
  const ext = path.extname(originalname).toLowerCase() || '.webp';
  const randomHash = crypto.randomBytes(8).toString('hex');
  const safeBaseName = path.basename(originalname, ext).replace(/[^a-zA-Z0-9-_]/g, '_');
  const key = `${category}/${Date.now()}-${randomHash}-${safeBaseName}${ext}`;

  await s3.send(
    new PutObjectCommand({
      Bucket: bucketName,
      Key: key,
      Body: buffer,
      ContentType: mimetype || 'image/webp',
    })
  );

  const imageUrl = `${publicUrl}/${key}`;
  return { imageUrl, imageKey: key };
}

/**
 * Deletes a file from Cloudflare R2
 * @param {string} imageKey - S3 object key
 */
export async function deleteFromR2(imageKey) {
  if (!imageKey) return;
  try {
    await s3.send(
      new DeleteObjectCommand({
        Bucket: bucketName,
        Key: imageKey,
      })
    );
  } catch (err) {
    console.error(`Failed to delete key "${imageKey}" from R2:`, err.message);
  }
}
