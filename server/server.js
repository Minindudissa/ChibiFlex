import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import multer from 'multer';
import jwt from 'jsonwebtoken';
import nodemailer from 'nodemailer';
import dns from 'dns/promises';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ModelItem } from './models/ModelItem.js';
import { Subscriber } from './models/Subscriber.js';
import { Setting } from './models/Setting.js';
import { Category } from './models/Category.js';
import { OtpVerification } from './models/OtpVerification.js';
import { PatreonMember } from './models/PatreonMember.js';
import { PATREON_TEMPLATES, renderPatreonEmail } from './patreonEmailTemplates.js';
import { uploadToR2, deleteFromR2 } from './r2.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || 'chibiflex_secret_key_2025';
const DEFAULT_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Multer memory storage for direct R2 streaming
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB limit
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed!'), false);
    }
  },
});

// Admin Auth Middleware
const requireAdmin = (req, res, next) => {
  let token = null;
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.split(' ')[1];
  } else if (req.query && req.query.token) {
    token = req.query.token;
  }

  if (!token) {
    return res.status(401).json({ error: 'Unauthorized. Please login.' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.admin = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired session. Please login again.' });
  }
};

// -------------------------------------------------------------
// Database Initialization & Default Settings
// -------------------------------------------------------------
async function initDefaults() {
  const driveSetting = await Setting.findOne({ key: 'googleDriveLink' });
  if (!driveSetting) {
    await Setting.create({
      key: 'googleDriveLink',
      value: 'https://drive.google.com/drive/folders/1ChibiFlexFreeModelsSampleLink',
    });
  }

  const passSetting = await Setting.findOne({ key: 'adminPassword' });
  if (!passSetting) {
    await Setting.create({
      key: 'adminPassword',
      value: DEFAULT_PASSWORD,
    });
  }

  const smtpSetting = await Setting.findOne({ key: 'smtpSettings' });
  if (!smtpSetting) {
    await Setting.create({
      key: 'smtpSettings',
      value: {
        host: 'smtp.gmail.com',
        port: 465,
        secure: true,
        user: '',
        pass: '',
        from: 'ChibiFlex <noreply@chibiflex.com>',
      },
    });
  }

  const thankYouSetting = await Setting.findOne({ key: 'thankYouEmailSettings' });
  if (!thankYouSetting) {
    await Setting.create({
      key: 'thankYouEmailSettings',
      value: {
        enabled: true,
        subject: '🎁 Your Free Chibi Flex 3D Models Are Ready To Download!',
        customNote: '',
      },
    });
  }

  const followUpSetting = await Setting.findOne({ key: 'followUpEmailSettings' });
  if (!followUpSetting) {
    await Setting.create({
      key: 'followUpEmailSettings',
      value: {
        enabled: true,
        delayDays: 4,
        subject: '🧸 Did you get a chance to print your Chibi Flex models yet? (+ exclusive designs waiting!)',
        heading: 'How Did Your 3D Prints Turn Out? 🖨️✨',
        message: "Hey there!\n\nIt's been a few days since you downloaded your free Chibi Flex articulated 3MF models. We hope they printed smoothly on your build plate!\n\nDid your flexi joints move freely? We'd love to hear how your prints turned out. If you've enjoyed these models, you will absolutely LOVE what we have inside our Patreon community!",
        patreonPitch: "Every month, our members get:\n⭐ 5+ Brand-New Exclusive Articulated Designs\n💼 Commercial License (Sell physical 3D prints of all our models!)\n🎁 Instant Access to the Giant Welcome Pack (20+ premium designs)\n🗳️ Vote on upcoming monthly models in community design polls",
        customNote: '',
      },
    });
  }

  // Initialize activeMonthlyRelease setting if none exists
  const activeReleaseSetting = await Setting.findOne({ key: 'activeMonthlyRelease' });
  if (!activeReleaseSetting) {
    await Setting.create({
      key: 'activeMonthlyRelease',
      value: {
        title: 'April Releases',
        month: 'April',
        year: 2026,
        updatedAt: new Date(),
      },
    });
  }

  // Migrate legacy 'monthly-releases' category models to public-releases with isCurrentMonthly = true
  const legacyMonthlyCat = await Category.findOne({ slug: 'monthly-releases' });
  if (legacyMonthlyCat) {
    await ModelItem.updateMany(
      { category: 'monthly-releases' },
      { $set: { category: 'public-releases', isCurrentMonthly: true } }
    );
    await Category.deleteOne({ slug: 'monthly-releases' });
  }

  // Seed default 4 official categories if missing
  const officialCategories = [
    { name: 'Public Releases', slug: 'public-releases', order: 1, description: 'All public flexi models available to everyone' },
    { name: 'Exclusive Designs', slug: 'exclusives', order: 2, description: 'Retired and exclusive member-only designs' },
    { name: 'Patreon Welcome Pack', slug: 'welcome-pack', order: 3, description: 'Models granted to new Patreon subscribers' },
    { name: 'Free Models', slug: 'free-models', order: 4, description: 'Complimentary 3MF designs for newcomers' },
  ];

  for (const cat of officialCategories) {
    const exists = await Category.findOne({ slug: cat.slug });
    if (!exists) {
      await Category.create(cat);
    }
  }

  // Seed initial Patreon members from CSV if available
  await seedPatreonMembersFromCSV();
}

async function seedPatreonMembersFromCSV() {
  try {
    const csvPath = path.join(__dirname, 'data', 'patreon_free_members.csv');
    if (!fs.existsSync(csvPath)) return;

    const content = fs.readFileSync(csvPath, 'utf-8');
    const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (lines.length <= 1) return;

    const bulkOps = [];
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      const parts = line.split(',');
      const name = parts[0]?.trim() || 'Patreon Member';
      const email = parts[1]?.trim().toLowerCase();
      const patronStatus = parts[3]?.trim() || 'Free Member';
      const isFreeMember = parts[5]?.trim() || 'Yes';
      const tier = parts[10]?.trim() || 'Free';
      const patronageSinceDate = parts[18]?.trim();
      const userId = parts[22]?.trim() || '';

      if (email && email.includes('@')) {
        bulkOps.push({
          updateOne: {
            filter: { email },
            update: {
              $setOnInsert: {
                name,
                email,
                tier,
                patronStatus,
                isFreeMember,
                userId,
                patronageSinceDate: patronageSinceDate ? new Date(patronageSinceDate) : new Date(),
                status: 'active',
              },
            },
            upsert: true,
          },
        });
      }
    }

    if (bulkOps.length > 0) {
      const result = await PatreonMember.bulkWrite(bulkOps);
      if (result.upsertedCount > 0) {
        console.log(`✅ Seeded ${result.upsertedCount} Patreon free members into database.`);
      }
    }
  } catch (err) {
    console.error('Error seeding Patreon members from CSV:', err);
  }
}

// -------------------------------------------------------------
// CATEGORIES ROUTES (Public & Admin)
// -------------------------------------------------------------

// Get All Categories (with model count for each)
app.get('/api/categories', async (req, res) => {
  try {
    const categories = await Category.find().sort({ order: 1, createdAt: 1 });
    
    // Add modelCount for each category
    const categoriesWithCount = await Promise.all(
      categories.map(async (cat) => {
        const count = await ModelItem.countDocuments({ category: cat.slug });
        return {
          ...cat.toObject(),
          modelCount: count,
        };
      })
    );

    res.json(categoriesWithCount);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch categories' });
  }
});

// Create Category (Admin)
app.post('/api/categories', requireAdmin, async (req, res) => {
  try {
    const { name, slug, description, order } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Category name is required.' });
    }

    const cleanName = name.trim();
    // Auto-generate slug from name if not provided
    const cleanSlug = (slug || cleanName)
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');

    const existing = await Category.findOne({ slug: cleanSlug });
    if (existing) {
      return res.status(400).json({ error: `Category with slug "${cleanSlug}" already exists.` });
    }

    const newCategory = await Category.create({
      name: cleanName,
      slug: cleanSlug,
      description: (description || '').trim(),
      order: Number(order) || 0,
    });

    res.status(201).json({ success: true, category: newCategory });
  } catch (err) {
    console.error('Create category error:', err);
    res.status(500).json({ error: 'Failed to create category: ' + err.message });
  }
});

// Update / Edit Category (Admin)
app.put('/api/categories/:id', requireAdmin, async (req, res) => {
  try {
    const { name, slug, description, order } = req.body;
    const category = await Category.findById(req.params.id);
    if (!category) {
      return res.status(404).json({ error: 'Category not found.' });
    }

    const oldSlug = category.slug;
    let newSlug = oldSlug;

    if (slug && slug.trim()) {
      newSlug = slug
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');

      // If slug is changing, verify it doesn't conflict with another category
      if (newSlug !== oldSlug) {
        const conflict = await Category.findOne({ slug: newSlug, _id: { $ne: category._id } });
        if (conflict) {
          return res.status(400).json({ error: `Category with slug "${newSlug}" already exists.` });
        }
      }
    }

    if (name) category.name = name.trim();
    category.slug = newSlug;
    if (description !== undefined) category.description = description.trim();
    if (order !== undefined) category.order = Number(order);

    await category.save();

    // If slug changed, update all models that used the old slug so they don't break
    if (newSlug !== oldSlug) {
      await ModelItem.updateMany({ category: oldSlug }, { $set: { category: newSlug } });
    }

    res.json({ success: true, category });
  } catch (err) {
    console.error('Update category error:', err);
    res.status(500).json({ error: 'Failed to update category: ' + err.message });
  }
});

// Delete Category (Admin)
app.delete('/api/categories/:id', requireAdmin, async (req, res) => {
  try {
    const category = await Category.findById(req.params.id);
    if (!category) {
      return res.status(404).json({ error: 'Category not found.' });
    }

    const modelCount = await ModelItem.countDocuments({ category: category.slug });
    const { force } = req.query;

    if (modelCount > 0 && force !== 'true') {
      return res.status(400).json({
        error: `Cannot delete "${category.name}" because it contains ${modelCount} model(s). Please delete or reassign those models first, or pass force=true.`,
        modelCount,
      });
    }

    await Category.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: `Category "${category.name}" deleted successfully.` });
  } catch (err) {
    console.error('Delete category error:', err);
    res.status(500).json({ error: 'Failed to delete category' });
  }
});

// -------------------------------------------------------------
// 1. PUBLIC ROUTES
// -------------------------------------------------------------

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date() });
});

// Get Models (Public)
app.get('/api/models', async (req, res) => {
  try {
    const { category, monthly, isCurrentMonthly } = req.query;
    let filter = {};

    if (monthly === 'current' || isCurrentMonthly === 'true') {
      filter.isCurrentMonthly = true;
    } else if (category) {
      filter.category = category;
    }

    const models = await ModelItem.find(filter).sort({ createdAt: -1 });
    res.json(models);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch models' });
  }
});

// Get Public Settings (e.g. Google Drive Link status & Active Monthly Release)
app.get('/api/settings/public', async (req, res) => {
  try {
    const driveSetting = await Setting.findOne({ key: 'googleDriveLink' });
    const activeReleaseSetting = await Setting.findOne({ key: 'activeMonthlyRelease' });

    res.json({
      googleDriveConfigured: Boolean(driveSetting?.value),
      activeMonthlyRelease: activeReleaseSetting?.value || {
        title: "This Month's Releases",
        month: 'Current',
        year: new Date().getFullYear(),
      },
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get public settings' });
  }
});

// -------------------------------------------------------------
// EMAIL VALIDATION & OTP HELPERS
// -------------------------------------------------------------
const DISPOSABLE_EMAIL_DOMAINS = new Set([
  'mailinator.com', 'tempmail.com', 'temp-mail.org', '10minutemail.com',
  'guerrillamail.com', 'throwawaymail.com', 'yopmail.com', 'sharklasers.com',
  'guerrillamailblock.com', 'dispostable.com', 'trashmail.com', 'getnada.com',
  'nada.ltd', 'mohmal.com', 'inboxkitten.com', 'burnermail.io',
  'fakemailgenerator.com', 'tempail.com', 'emailondeck.com', 'crazymailing.com',
  'mytemp.email', 'generator.email', 'trashmail.net', 'dropmail.me',
  'airmail.news', 'disposablemail.com', 'temp-mail.io', '10mail.org',
  'guerrillamail.net', 'guerrillamail.org', 'guerrillamail.biz', 'grr.la',
  'spam4.me', 'bccto.me', 'chacuo.net', '027168.com'
]);

async function validateEmailAddress(email) {
  if (!email || typeof email !== 'string') {
    return { valid: false, error: 'Email address is required.' };
  }
  const cleanEmail = email.trim().toLowerCase();
  const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
  if (!emailRegex.test(cleanEmail) || cleanEmail.length > 254) {
    return { valid: false, error: 'Please provide a valid email address.' };
  }

  const domain = cleanEmail.split('@')[1];
  if (DISPOSABLE_EMAIL_DOMAINS.has(domain)) {
    return {
      valid: false,
      error: 'Temporary or disposable emails are not allowed. Please enter your real email.',
    };
  }

  // Verify Domain MX Records with 3.5s timeout
  try {
    const mxPromise = dns.resolveMx(domain);
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('DNS Timeout')), 3500)
    );
    const addresses = await Promise.race([mxPromise, timeoutPromise]);
    if (!addresses || addresses.length === 0) {
      return { valid: false, error: 'The email domain does not have active mail servers (MX records).' };
    }
  } catch (err) {
    if (err.code === 'ENOTFOUND' || err.code === 'ENODATA') {
      return { valid: false, error: 'The specified email domain does not exist.' };
    }
    // Network / DNS timeout -> fail open to avoid blocking legitimate users during transient network lag
  }

  return { valid: true, cleanEmail };
}

async function getMailTransporter() {
  const smtpSetting = await Setting.findOne({ key: 'smtpSettings' });
  const smtp = smtpSetting?.value;
  if (!smtp || !smtp.user || !smtp.pass) {
    throw new Error('SMTP credentials not configured. Please configure SMTP in Settings.');
  }

  const transporter = nodemailer.createTransport({
    host: smtp.host || 'smtp.gmail.com',
    port: Number(smtp.port) || 465,
    secure: Number(smtp.port) === 465,
    auth: {
      user: smtp.user,
      pass: smtp.pass,
    },
  });

  const from = smtp.from || `"Chibi Flex" <${smtp.user}>`;
  return { transporter, from };
}

function getOtpHtmlEmail(otp) {
  return `
  <!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Chibi Flex Verification Code</title>
  </head>
  <body style="margin: 0; padding: 0; background-color: #0b0c10; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #ffffff;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color: #0b0c10; padding: 40px 15px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" style="max-width: 520px; background: linear-gradient(145deg, #151722, #0d0f17); border: 1px solid rgba(255, 255, 255, 0.12); border-radius: 20px; overflow: hidden; box-shadow: 0 20px 45px rgba(0, 0, 0, 0.7);" cellspacing="0" cellpadding="0" border="0">
            <!-- Header -->
            <tr>
              <td style="padding: 35px 35px 20px 35px; text-align: center; border-bottom: 1px solid rgba(255, 255, 255, 0.08);">
                <h1 style="margin: 0; font-size: 26px; font-weight: 800; letter-spacing: -0.5px; color: #ffffff;">
                  🧸 <span style="background: linear-gradient(135deg, #00d2ff, #3a7bd5); -webkit-background-clip: text; -webkit-text-fill-color: transparent;">Chibi Flex</span>
                </h1>
                <p style="margin: 6px 0 0 0; font-size: 13px; color: #94a3b8; letter-spacing: 0.5px; text-transform: uppercase;">Cute 3D Printable Flexi Models</p>
              </td>
            </tr>
            <!-- Main Content -->
            <tr>
              <td style="padding: 35px 35px 25px 35px; text-align: center;">
                <h2 style="margin: 0 0 12px 0; font-size: 20px; font-weight: 700; color: #f8fafc;">Verify Your Email Address</h2>
                <p style="margin: 0 0 24px 0; font-size: 15px; line-height: 1.6; color: #cbd5e1;">
                  Welcome! Use the 6-digit verification code below to confirm your email and immediately unlock your <strong>Free 3D Printable Models</strong> download link.
                </p>
                <!-- OTP Box -->
                <div style="background: rgba(0, 210, 255, 0.08); border: 2px dashed #00d2ff; border-radius: 14px; padding: 18px 10px; margin: 0 auto 24px auto; max-width: 300px;">
                  <span style="font-family: 'Courier New', Courier, monospace; font-size: 38px; font-weight: 800; letter-spacing: 8px; color: #00d2ff; display: inline-block;">${otp}</span>
                </div>
                <p style="margin: 0; font-size: 13px; color: #94a3b8;">
                  ⏱️ This code will expire in <strong>10 minutes</strong>.
                </p>
              </td>
            </tr>
            <!-- Security Note & Footer -->
            <tr>
              <td style="padding: 22px 35px; background-color: rgba(0, 0, 0, 0.35); border-top: 1px solid rgba(255, 255, 255, 0.08); text-align: center;">
                <p style="margin: 0 0 8px 0; font-size: 12px; color: #64748b; line-height: 1.5;">
                  If you didn't request this code or sign up on Chibi Flex, you can safely ignore this email.
                </p>
                <p style="margin: 0; font-size: 12px; color: #475569;">
                  &copy; ${new Date().getFullYear()} Chibi Flex. All rights reserved.
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
  </html>
  `;
}

function getThankYouHtmlEmail(driveLink, customNote = '') {
  const currentYear = new Date().getFullYear();
  const safeDriveLink = driveLink || 'https://drive.google.com';

  const customNoteHtml = customNote && customNote.trim()
    ? `
      <div style="background: rgba(0, 210, 255, 0.08); border-left: 4px solid #00d2ff; padding: 14px 18px; border-radius: 8px; margin: 20px 0; text-align: left;">
        <p style="margin: 0; font-size: 14px; line-height: 1.6; color: #e2e8f0; font-style: italic;">
          "${customNote.trim().replace(/</g, '&lt;').replace(/>/g, '&gt;')}"
        </p>
      </div>
    `
    : '';

  return `
  <!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Thank You for Downloading Chibi Flex Free Models</title>
  </head>
  <body style="margin: 0; padding: 0; background-color: #0b0c10; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #ffffff;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color: #0b0c10; padding: 40px 15px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" style="max-width: 580px; background: linear-gradient(145deg, #151722, #0d0f17); border: 1px solid rgba(255, 255, 255, 0.12); border-radius: 20px; overflow: hidden; box-shadow: 0 20px 45px rgba(0, 0, 0, 0.7);" cellspacing="0" cellpadding="0" border="0">
            <!-- Header -->
            <tr>
              <td style="padding: 35px 35px 22px 35px; text-align: center; border-bottom: 1px solid rgba(255, 255, 255, 0.08);">
                <h1 style="margin: 0; font-size: 28px; font-weight: 800; letter-spacing: -0.5px; color: #ffffff;">
                  🧸 <span style="background: linear-gradient(135deg, #00d2ff, #3a7bd5); -webkit-background-clip: text; -webkit-text-fill-color: transparent;">Chibi Flex</span>
                </h1>
                <p style="margin: 6px 0 0 0; font-size: 13px; color: #94a3b8; letter-spacing: 0.5px; text-transform: uppercase;">Cute 3D Printable Flexi Models</p>
              </td>
            </tr>

            <!-- Main Content -->
            <tr>
              <td style="padding: 35px 35px 25px 35px; text-align: center;">
                <div style="display: inline-block; width: 56px; height: 56px; line-height: 56px; border-radius: 50%; background: rgba(16, 185, 129, 0.15); border: 1px solid rgba(16, 185, 129, 0.4); font-size: 28px; margin-bottom: 18px;">
                  🎁
                </div>
                <h2 style="margin: 0 0 14px 0; font-size: 22px; font-weight: 800; color: #ffffff; letter-spacing: -0.3px;">
                  Thank You for Downloading!
                </h2>
                <p style="margin: 0 0 20px 0; font-size: 15px; line-height: 1.6; color: #cbd5e1;">
                  Welcome to the <strong>Chibi Flex</strong> family! Your complimentary articulated 3D printable models are ready to download via Google Drive.
                </p>

                ${customNoteHtml}

                <!-- Download CTA Button -->
                <table role="presentation" cellspacing="0" cellpadding="0" border="0" align="center" style="margin: 28px auto 16px auto;">
                  <tr>
                    <td align="center" style="border-radius: 14px; background: linear-gradient(135deg, #00d2ff 0%, #3a7bd5 100%); box-shadow: 0 10px 25px rgba(0, 210, 255, 0.35);">
                      <a href="${safeDriveLink}" target="_blank" style="padding: 16px 36px; border-radius: 14px; font-size: 16px; font-weight: 800; color: #ffffff; text-decoration: none; display: inline-block; letter-spacing: 0.3px;">
                        📥 Download Free 3D Models (Google Drive) &rarr;
                      </a>
                    </td>
                  </tr>
                </table>

                <p style="margin: 0 0 28px 0; font-size: 12px; color: #94a3b8; word-break: break-all; line-height: 1.5;">
                  Direct link: <a href="${safeDriveLink}" target="_blank" style="color: #00d2ff; text-decoration: underline;">${safeDriveLink}</a>
                </p>

                <!-- Printing Guide & What's Included -->
                <div style="background: rgba(255, 255, 255, 0.03); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 14px; padding: 20px 22px; text-align: left; margin-bottom: 28px;">
                  <h3 style="margin: 0 0 12px 0; font-size: 14px; font-weight: 700; color: #38bdf8; text-transform: uppercase; letter-spacing: 0.8px;">
                    💡 What's Inside & Printing Tips
                  </h3>
                  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                    <tr>
                      <td style="padding: 5px 0; font-size: 13.5px; color: #e2e8f0; line-height: 1.5;">
                        🧩 <strong>Print-in-Place Articulation:</strong> All joints and hinges print ready-assembled. Zero gluing or hardware required!
                      </td>
                    </tr>
                    <tr>
                      <td style="padding: 5px 0; font-size: 13.5px; color: #e2e8f0; line-height: 1.5;">
                        🎨 <strong>Multi-Color 3MF Files:</strong> Pre-colored and sliced for Bambu Studio, OrcaSlicer, or PrusaSlicer.
                      </td>
                    </tr>
                    <tr>
                      <td style="padding: 5px 0; font-size: 13.5px; color: #e2e8f0; line-height: 1.5;">
                        ⚙️ <strong>Recommended Slicer Settings:</strong> 0.16mm - 0.20mm layer height, 2–3 walls, 15% gyroid infill. No supports needed.
                      </td>
                    </tr>
                  </table>
                </div>

                <!-- Patreon Upsell Banner -->
                <div style="background: linear-gradient(135deg, rgba(236, 72, 153, 0.1), rgba(168, 85, 247, 0.1)); border: 1px solid rgba(236, 72, 153, 0.3); border-radius: 16px; padding: 24px; text-align: center;">
                  <span style="font-size: 12px; font-weight: 800; color: #ec4899; text-transform: uppercase; letter-spacing: 1px;">Join Our Club</span>
                  <h3 style="margin: 6px 0 10px 0; font-size: 18px; font-weight: 800; color: #f8fafc;">
                    Want 5+ New Exclusive Models Monthly? ✨
                  </h3>
                  <p style="margin: 0 0 18px 0; font-size: 13.5px; color: #cbd5e1; line-height: 1.5;">
                    Support Chibi Flex on Patreon to unlock our entire Welcome Pack, monthly member exclusives, design voting, and commercial licensing to sell 3D prints!
                  </p>
                  <table role="presentation" cellspacing="0" cellpadding="0" border="0" align="center">
                    <tr>
                      <td align="center" style="border-radius: 10px; background: linear-gradient(135deg, #ec4899 0%, #a855f7 100%);">
                        <a href="https://www.patreon.com/ChibiFlex" target="_blank" style="padding: 12px 26px; border-radius: 10px; font-size: 14px; font-weight: 700; color: #ffffff; text-decoration: none; display: inline-block;">
                          🧸 Join ChibiFlex on Patreon &rarr;
                        </a>
                      </td>
                    </tr>
                  </table>
                </div>

              </td>
            </tr>

            <!-- Footer -->
            <tr>
              <td style="padding: 24px 35px; background-color: rgba(0, 0, 0, 0.35); border-top: 1px solid rgba(255, 255, 255, 0.08); text-align: center;">
                <p style="margin: 0 0 8px 0; font-size: 13px; color: #94a3b8; font-weight: 600;">
                  Happy 3D Printing! ❤️ The Chibi Flex Team
                </p>
                <p style="margin: 0 0 8px 0; font-size: 11.5px; color: #64748b; line-height: 1.5;">
                  You received this email because you requested the free 3D models download on <a href="https://chibiflex.com" style="color: #64748b; text-decoration: underline;">chibiflex.com</a>.
                </p>
                <p style="margin: 0; font-size: 11.5px; color: #475569;">
                  &copy; ${currentYear} Chibi Flex. All rights reserved.
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
  </html>
  `;
}

async function sendThankYouEmail(toEmail, driveLink) {
  if (!toEmail) return { success: false, reason: 'no-email' };
  try {
    const thankYouSetting = await Setting.findOne({ key: 'thankYouEmailSettings' });
    const settings = thankYouSetting?.value || {
      enabled: true,
      subject: '🎁 Your Free Chibi Flex 3D Models Are Ready To Download!',
      customNote: '',
    };

    if (settings.enabled === false) {
      console.log(`[Thank You Email] Disabled in settings; skipping dispatch to ${toEmail}.`);
      return { success: false, reason: 'disabled' };
    }

    const { transporter, from } = await getMailTransporter();
    let finalDriveLink = driveLink;
    if (!finalDriveLink) {
      const driveSetting = await Setting.findOne({ key: 'googleDriveLink' });
      finalDriveLink = driveSetting ? driveSetting.value : 'https://drive.google.com';
    }

    const subject = settings.subject && settings.subject.trim()
      ? settings.subject.trim()
      : '🎁 Your Free Chibi Flex 3D Models Are Ready To Download!';

    const html = getThankYouHtmlEmail(finalDriveLink, settings.customNote);

    const info = await transporter.sendMail({
      from,
      to: toEmail,
      subject,
      html,
    });

    console.log(`[Thank You Email] Successfully sent to ${toEmail}. Message ID: ${info.messageId}`);
    try {
      await Subscriber.updateOne(
        { email: toEmail.toLowerCase().trim() },
        { $set: { thankYouEmailSentAt: new Date() } }
      );
    } catch (e) {}
    return { success: true, messageId: info.messageId };
  } catch (err) {
    console.error(`[Thank You Email] Failed to send to ${toEmail}:`, err.message || err);
    return { success: false, error: err.message };
  }
}

// -------------------------------------------------------------
// DAY 4 FOLLOW-UP & PATREON UPSELL EMAIL TEMPLATE & DISPATCH
// -------------------------------------------------------------
function getFollowUpHtmlEmail(options = {}) {
  const currentYear = new Date().getFullYear();
  const safeDriveLink = options.driveLink || 'https://drive.google.com';
  const patreonLink = options.patreonLink || 'https://www.patreon.com/ChibiFlex';
  const heading = options.heading || 'How Did Your 3D Prints Turn Out? 🖨️✨';
  const message = options.message || "Hey there!\n\nIt's been a few days since you downloaded your free Chibi Flex articulated 3MF models. We hope they printed smoothly on your build plate!\n\nDid your flexi joints move freely? We'd love to see photos of your makes! If you enjoyed these models, you're going to love what we have inside our Patreon community.";
  const patreonPitch = options.patreonPitch || "Every month, our members get:\n⭐ 5+ Brand-New Exclusive Articulated Designs\n💼 Commercial License (Sell physical 3D prints of all our models!)\n🎁 Instant Access to the Giant Welcome Pack (20+ premium designs)\n🗳️ Vote on upcoming monthly models in community design polls";
  const customNote = options.customNote || '';

  // Format message lines into paragraphs
  const messageHtml = message
    .split('\n\n')
    .filter((p) => p.trim())
    .map((p) => `<p style="margin: 0 0 16px 0; font-size: 15px; line-height: 1.65; color: #cbd5e1;">${p.replace(/\n/g, '<br>').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/&lt;br&gt;/g, '<br>')}</p>`)
    .join('');

  // Format patreon perks into styled list
  const perksHtml = patreonPitch
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      const clean = line.replace(/</g, '&lt;').replace(/>/g, '&gt;');
      return `
        <tr>
          <td style="padding: 7px 0; font-size: 14px; color: #f1f5f9; line-height: 1.5;">
            ${clean}
          </td>
        </tr>
      `;
    })
    .join('');

  const customNoteHtml = customNote && customNote.trim()
    ? `
      <div style="background: rgba(236, 72, 153, 0.1); border-left: 4px solid #ec4899; padding: 14px 18px; border-radius: 8px; margin: 22px 0; text-align: left;">
        <p style="margin: 0; font-size: 14px; line-height: 1.6; color: #fbcfe8; font-style: italic;">
          "${customNote.trim().replace(/</g, '&lt;').replace(/>/g, '&gt;')}"
        </p>
      </div>
    `
    : '';

  return `
  <!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${heading}</title>
  </head>
  <body style="margin: 0; padding: 0; background-color: #0b0c10; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #ffffff;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color: #0b0c10; padding: 40px 15px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" style="max-width: 580px; background: linear-gradient(145deg, #151722, #0d0f17); border: 1px solid rgba(255, 255, 255, 0.12); border-radius: 20px; overflow: hidden; box-shadow: 0 25px 50px rgba(0, 0, 0, 0.75);" cellspacing="0" cellpadding="0" border="0">
            <!-- Header -->
            <tr>
              <td style="padding: 35px 35px 22px 35px; text-align: center; border-bottom: 1px solid rgba(255, 255, 255, 0.08);">
                <h1 style="margin: 0; font-size: 28px; font-weight: 800; letter-spacing: -0.5px; color: #ffffff;">
                  🧸 <span style="background: linear-gradient(135deg, #00d2ff, #3a7bd5); -webkit-background-clip: text; -webkit-text-fill-color: transparent;">Chibi Flex</span>
                </h1>
                <p style="margin: 6px 0 0 0; font-size: 13px; color: #94a3b8; letter-spacing: 0.5px; text-transform: uppercase;">Articulated 3D Printable Flexi Models</p>
              </td>
            </tr>

            <!-- Main Content -->
            <tr>
              <td style="padding: 35px 35px 25px 35px; text-align: center;">
                <div style="display: inline-block; width: 60px; height: 60px; line-height: 60px; border-radius: 50%; background: rgba(236, 72, 153, 0.15); border: 1px solid rgba(236, 72, 153, 0.4); font-size: 30px; margin-bottom: 20px;">
                  🖨️
                </div>
                <h2 style="margin: 0 0 16px 0; font-size: 23px; font-weight: 800; color: #ffffff; letter-spacing: -0.3px;">
                  ${heading.replace(/</g, '&lt;').replace(/>/g, '&gt;')}
                </h2>

                <div style="text-align: left; margin-bottom: 20px;">
                  ${messageHtml}
                </div>

                ${customNoteHtml}

                <!-- Patreon Mega Card (Urgent & Compelling) -->
                <div style="background: linear-gradient(135deg, rgba(236, 72, 153, 0.14), rgba(168, 85, 247, 0.14)); border: 2px solid rgba(236, 72, 153, 0.45); border-radius: 18px; padding: 26px; text-align: center; margin: 26px 0;">
                  <span style="display: inline-block; background: rgba(236, 72, 153, 0.25); color: #f472b6; font-size: 11.5px; font-weight: 800; text-transform: uppercase; letter-spacing: 1.2px; padding: 5px 14px; border-radius: 20px; margin-bottom: 10px;">
                    🔥 Exclusive Patreon Membership
                  </span>
                  <h3 style="margin: 4px 0 12px 0; font-size: 20px; font-weight: 800; color: #ffffff;">
                    Ready To Sell 3D Prints & Unlock 20+ Models?
                  </h3>
                  
                  <div style="background: rgba(0, 0, 0, 0.3); border-radius: 12px; padding: 14px 18px; margin-bottom: 22px; text-align: left;">
                    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                      ${perksHtml}
                    </table>
                  </div>

                  <!-- Big CTA Button -->
                  <table role="presentation" cellspacing="0" cellpadding="0" border="0" align="center">
                    <tr>
                      <td align="center" style="border-radius: 12px; background: linear-gradient(135deg, #ec4899 0%, #a855f7 100%); box-shadow: 0 10px 25px rgba(236, 72, 153, 0.4);">
                        <a href="${patreonLink}" target="_blank" style="padding: 16px 36px; border-radius: 12px; font-size: 16px; font-weight: 800; color: #ffffff; text-decoration: none; display: inline-block; letter-spacing: 0.3px;">
                          ⭐ JOIN CHIBIFLEX PATREON NOW &rarr;
                        </a>
                      </td>
                    </tr>
                  </table>
                  <p style="margin: 12px 0 0 0; font-size: 12.5px; color: #cbd5e1;">Instant access to download everything right away!</p>
                </div>

                <!-- Free Models Reminder Box -->
                <div style="background: rgba(255, 255, 255, 0.03); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 12px; padding: 16px 20px; text-align: center; margin-top: 15px;">
                  <p style="margin: 0 0 8px 0; font-size: 13.5px; color: #94a3b8;">
                    Need to re-download your complimentary free models?
                  </p>
                  <a href="${safeDriveLink}" target="_blank" style="color: #00d2ff; font-weight: 700; font-size: 13.5px; text-decoration: underline;">
                    📥 Open Google Drive Free Models Folder &rarr;
                  </a>
                </div>

              </td>
            </tr>

            <!-- Footer -->
            <tr>
              <td style="padding: 24px 35px; background-color: rgba(0, 0, 0, 0.35); border-top: 1px solid rgba(255, 255, 255, 0.08); text-align: center;">
                <p style="margin: 0 0 8px 0; font-size: 13px; color: #94a3b8; font-weight: 600;">
                  Happy 3D Printing! ❤️ The Chibi Flex Team
                </p>
                <p style="margin: 0 0 8px 0; font-size: 11.5px; color: #64748b; line-height: 1.5;">
                  You received this email because you downloaded free 3D models on <a href="https://chibiflex.com" style="color: #64748b; text-decoration: underline;">chibiflex.com</a>.
                </p>
                <p style="margin: 0; font-size: 11.5px; color: #475569;">
                  &copy; ${currentYear} Chibi Flex. All rights reserved.
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
  </html>
  `;
}

async function sendFollowUpEmail(toEmail, driveLink, customOptions = {}) {
  if (!toEmail) return { success: false, reason: 'no-email' };
  try {
    const followUpSetting = await Setting.findOne({ key: 'followUpEmailSettings' });
    const settings = {
      ...(followUpSetting?.value || {}),
      ...customOptions,
    };

    if (customOptions.force !== true && settings.enabled === false) {
      console.log(`[Follow-Up Email] Disabled in settings; skipping dispatch to ${toEmail}.`);
      return { success: false, reason: 'disabled' };
    }

    const { transporter, from } = await getMailTransporter();
    let finalDriveLink = driveLink || customOptions.driveLink;
    if (!finalDriveLink) {
      const driveSetting = await Setting.findOne({ key: 'googleDriveLink' });
      finalDriveLink = driveSetting ? driveSetting.value : 'https://drive.google.com';
    }

    const subject = settings.subject && settings.subject.trim()
      ? settings.subject.trim()
      : '🧸 Did you get a chance to print your Chibi Flex models yet? (+ exclusive designs waiting!)';

    const html = getFollowUpHtmlEmail({
      ...settings,
      driveLink: finalDriveLink,
      patreonLink: settings.patreonLink || 'https://www.patreon.com/ChibiFlex',
    });

    const info = await transporter.sendMail({
      from,
      to: toEmail,
      subject,
      html,
    });

    console.log(`[Follow-Up Email] Successfully sent to ${toEmail}. Message ID: ${info.messageId}`);
    return { success: true, messageId: info.messageId };
  } catch (err) {
    console.error(`[Follow-Up Email] Failed to send to ${toEmail}:`, err.message || err);
    return { success: false, error: err.message };
  }
}

// Automated Cron: Find and process subscribers due for follow-up email
async function processFollowUpEmails() {
  try {
    const followUpSetting = await Setting.findOne({ key: 'followUpEmailSettings' });
    const settings = followUpSetting?.value || { enabled: true, delayDays: 4 };

    if (settings.enabled === false) {
      return { processed: 0, reason: 'disabled' };
    }

    const delayDays = Number(settings.delayDays) >= 0 ? Number(settings.delayDays) : 4;
    const cutoffDate = new Date(Date.now() - delayDays * 24 * 60 * 60 * 1000);

    // Eligible: active subscribers whose subscribedAt <= cutoffDate, and followUpEmailSentAt is null
    const pendingSubscribers = await Subscriber.find({
      status: 'active',
      isVerified: true,
      followUpEmailSentAt: { $exists: false },
      subscribedAt: { $lte: cutoffDate },
    }).limit(50);

    if (pendingSubscribers.length === 0) {
      return { processed: 0, totalEligible: 0, message: 'No subscribers due for follow-up.' };
    }

    console.log(`[Follow-Up Cron] Found ${pendingSubscribers.length} subscriber(s) due for Day ${delayDays} follow-up.`);

    const driveSetting = await Setting.findOne({ key: 'googleDriveLink' });
    const driveLink = driveSetting ? driveSetting.value : 'https://drive.google.com';

    let sentCount = 0;
    for (const sub of pendingSubscribers) {
      try {
        const res = await sendFollowUpEmail(sub.email, driveLink);
        if (res.success) {
          sub.followUpEmailSentAt = new Date();
          sub.followUpEmailStatus = 'sent';
          await sub.save();
          sentCount++;
        } else {
          sub.followUpEmailStatus = 'failed';
          await sub.save();
        }
      } catch (subErr) {
        console.error(`[Follow-Up Cron] Error processing ${sub.email}:`, subErr);
      }
    }

    console.log(`[Follow-Up Cron] Completed dispatch to ${sentCount}/${pendingSubscribers.length} subscribers.`);
    return { processed: sentCount, totalEligible: pendingSubscribers.length };
  } catch (err) {
    console.error('[Follow-Up Cron] Error:', err);
    return { error: err.message };
  }
}

// -------------------------------------------------------------
// 1. SUBSCRIBE & OTP VERIFICATION ENDPOINTS
// -------------------------------------------------------------

// Step 1: Initiate Subscribe / Request OTP
app.post('/api/subscribe', async (req, res) => {
  try {
    const { email } = req.body;
    const valResult = await validateEmailAddress(email);

    if (!valResult.valid) {
      return res.status(400).json({ error: valResult.error });
    }

    const cleanEmail = valResult.cleanEmail;

    // Check if user is ALREADY SUBSCRIBED and ACTIVE
    const existingSubscriber = await Subscriber.findOne({
      email: cleanEmail,
      status: 'active',
    });

    if (existingSubscriber) {
      // Returning active subscriber -> Instant unlock with ZERO OTP friction!
      const driveSetting = await Setting.findOne({ key: 'googleDriveLink' });
      const driveLink = driveSetting ? driveSetting.value : '';

      // Automatically send Thank You Email with download link to returning subscriber as well
      sendThankYouEmail(cleanEmail, driveLink).catch(err => {
        console.error('Auto Thank You Email error on returning subscriber:', err);
      });

      return res.json({
        success: true,
        alreadySubscribed: true,
        googleDriveLink: driveLink,
        message: 'Welcome back! Your Free 3D Models download is ready.',
      });
    }

    // New visitor -> Generate 6-digit OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();

    // Upsert into OtpVerification
    await OtpVerification.findOneAndUpdate(
      { email: cleanEmail },
      {
        otp,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000), // 10 minutes
        verified: false,
        createdAt: new Date(),
      },
      { upsert: true, returnDocument: 'after' }
    );

    // Send email via Nodemailer
    try {
      const { transporter, from } = await getMailTransporter();
      await transporter.sendMail({
        from,
        to: cleanEmail,
        subject: `Your Chibi Flex Verification Code: ${otp}`,
        html: getOtpHtmlEmail(otp),
      });
    } catch (mailErr) {
      console.error('Mail dispatch error:', mailErr);
      return res.status(500).json({
        error: 'Unable to dispatch verification email. Please ensure your email is correct or try again in a moment.',
      });
    }

    return res.json({
      success: true,
      requiresOtp: true,
      email: cleanEmail,
      message: 'A 6-digit verification code has been sent to your email.',
    });
  } catch (err) {
    console.error('Subscribe error:', err);
    res.status(500).json({ error: 'Subscription failed. Please try again.' });
  }
});

// Step 2: Verify OTP and Unlock Link
app.post('/api/subscribe/verify-otp', async (req, res) => {
  try {
    const { email, otp } = req.body;
    if (!email || !otp) {
      return res.status(400).json({ error: 'Email and verification code are required.' });
    }

    const cleanEmail = email.trim().toLowerCase();
    const cleanOtp = String(otp).trim();

    // Look for valid OTP record
    const record = await OtpVerification.findOne({
      email: cleanEmail,
      otp: cleanOtp,
      expiresAt: { $gt: new Date() },
    });

    if (!record) {
      return res.status(400).json({
        error: 'Invalid or expired verification code. Please check your code or request a new one.',
      });
    }

    // Consume OTP record
    await OtpVerification.deleteOne({ _id: record._id });

    // Create or activate Subscriber record
    let subscriber = await Subscriber.findOne({ email: cleanEmail });
    if (!subscriber) {
      subscriber = await Subscriber.create({
        email: cleanEmail,
        status: 'active',
        isVerified: true,
        source: 'free-model-download',
      });
    } else {
      subscriber.status = 'active';
      subscriber.isVerified = true;
      await subscriber.save();
    }

    // Retrieve Google Drive Link
    const driveSetting = await Setting.findOne({ key: 'googleDriveLink' });
    const driveLink = driveSetting ? driveSetting.value : '';

    // Automatically send Thank You Email with direct download link!
    sendThankYouEmail(cleanEmail, driveLink).catch(err => {
      console.error('Auto Thank You Email error on verify-otp:', err);
    });

    return res.json({
      success: true,
      verified: true,
      googleDriveLink: driveLink,
      message: 'Email verified successfully! Welcome to the Chibi Flex family.',
    });
  } catch (err) {
    console.error('Verify OTP error:', err);
    res.status(500).json({ error: 'Verification failed. Please try again.' });
  }
});

// Step 3: Resend OTP Code
app.post('/api/subscribe/resend-otp', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ error: 'Email is required.' });
    }

    const cleanEmail = email.trim().toLowerCase();

    // If already subscribed, return direct link
    const existing = await Subscriber.findOne({ email: cleanEmail, status: 'active' });
    if (existing) {
      const driveSetting = await Setting.findOne({ key: 'googleDriveLink' });
      return res.json({
        success: true,
        alreadySubscribed: true,
        googleDriveLink: driveSetting?.value || '',
      });
    }

    // Rate-limit check: 30 seconds cooldown
    const lastOtp = await OtpVerification.findOne({ email: cleanEmail });
    if (lastOtp && lastOtp.createdAt) {
      const elapsedMs = Date.now() - new Date(lastOtp.createdAt).getTime();
      if (elapsedMs < 30000) {
        const waitSec = Math.ceil((30000 - elapsedMs) / 1000);
        return res.status(429).json({
          error: `Please wait ${waitSec} more second${waitSec > 1 ? 's' : ''} before requesting another code.`,
        });
      }
    }

    // Generate fresh OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();

    await OtpVerification.findOneAndUpdate(
      { email: cleanEmail },
      {
        otp,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
        verified: false,
        createdAt: new Date(),
      },
      { upsert: true, returnDocument: 'after' }
    );

    // Send fresh email
    try {
      const { transporter, from } = await getMailTransporter();
      await transporter.sendMail({
        from,
        to: cleanEmail,
        subject: `Your Chibi Flex Verification Code: ${otp}`,
        html: getOtpHtmlEmail(otp),
      });
    } catch (mailErr) {
      console.error('Resend mail error:', mailErr);
      return res.status(500).json({ error: 'Failed to send verification code. Please try again.' });
    }

    return res.json({
      success: true,
      message: 'A new 6-digit verification code has been sent to your email.',
    });
  } catch (err) {
    console.error('Resend OTP error:', err);
    res.status(500).json({ error: 'Failed to resend code. Please try again.' });
  }
});

// -------------------------------------------------------------
// 2. ADMIN AUTHENTICATION
// -------------------------------------------------------------
app.post('/api/admin/login', async (req, res) => {
  try {
    const { password } = req.body;
    const passSetting = await Setting.findOne({ key: 'adminPassword' });
    const currentPassword = passSetting ? passSetting.value : DEFAULT_PASSWORD;

    if (password === currentPassword) {
      const token = jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '7d' });
      return res.json({ success: true, token });
    }

    return res.status(401).json({ error: 'Incorrect password.' });
  } catch (err) {
    res.status(500).json({ error: 'Login error' });
  }
});

// -------------------------------------------------------------
// 3. ADMIN MODEL CRUD (R2 Cloudflare)
// -------------------------------------------------------------

// Upload New Model Image
app.post('/api/models', requireAdmin, upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Please upload an image file.' });
    }

    const { category, title, isCurrentMonthly, releaseMonth } = req.body;
    if (!category) {
      return res.status(400).json({ error: 'Category is required.' });
    }

    const isMonthlyBool = isCurrentMonthly === true || isCurrentMonthly === 'true';
    let assignedMonth = (releaseMonth || '').trim();

    if (isMonthlyBool && !assignedMonth) {
      const activeSetting = await Setting.findOne({ key: 'activeMonthlyRelease' });
      assignedMonth = activeSetting?.value?.title || "This Month's Releases";
    }

    // Upload to Cloudflare R2
    const { imageUrl, imageKey } = await uploadToR2(
      req.file.buffer,
      req.file.originalname,
      req.file.mimetype,
      category
    );

    // Save to MongoDB
    const newModel = await ModelItem.create({
      title: title || '',
      category,
      imageUrl,
      imageKey,
      isCurrentMonthly: isMonthlyBool,
      releaseMonth: assignedMonth,
    });

    res.status(201).json({ success: true, model: newModel });
  } catch (err) {
    console.error('Model upload error:', err);
    res.status(500).json({ error: 'Failed to upload image to Cloudflare R2: ' + err.message });
  }
});

// Update Model Metadata
app.put('/api/models/:id', requireAdmin, async (req, res) => {
  try {
    const { title, category, order, isCurrentMonthly, releaseMonth } = req.body;
    const updateFields = {};
    if (title !== undefined) updateFields.title = title;
    if (category !== undefined) updateFields.category = category;
    if (order !== undefined) updateFields.order = Number(order);
    if (isCurrentMonthly !== undefined) {
      updateFields.isCurrentMonthly = isCurrentMonthly === true || isCurrentMonthly === 'true';
      if (updateFields.isCurrentMonthly && !releaseMonth) {
        const activeSetting = await Setting.findOne({ key: 'activeMonthlyRelease' });
        updateFields.releaseMonth = activeSetting?.value?.title || "This Month's Releases";
      }
    }
    if (releaseMonth !== undefined) updateFields.releaseMonth = releaseMonth;

    const updated = await ModelItem.findByIdAndUpdate(
      req.params.id,
      { $set: updateFields },
      { new: true }
    );
    res.json({ success: true, model: updated });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update model' });
  }
});

// Delete Model Image
app.delete('/api/models/:id', requireAdmin, async (req, res) => {
  try {
    const model = await ModelItem.findById(req.params.id);
    if (!model) {
      return res.status(404).json({ error: 'Model not found' });
    }

    // Delete image from Cloudflare R2 if it has an imageKey
    if (model.imageKey) {
      await deleteFromR2(model.imageKey);
    }

    // Delete record from MongoDB
    await ModelItem.findByIdAndDelete(req.params.id);

    res.json({ success: true, message: 'Model deleted successfully' });
  } catch (err) {
    console.error('Delete error:', err);
    res.status(500).json({ error: 'Failed to delete model' });
  }
});

// -------------------------------------------------------------
// MONTHLY RELEASE MANAGER (ADMIN)
// -------------------------------------------------------------

// Get Monthly Release Summary & Active Drop Info
app.get('/api/admin/monthly-release', requireAdmin, async (req, res) => {
  try {
    const activeSetting = await Setting.findOne({ key: 'activeMonthlyRelease' });
    const activeRelease = activeSetting?.value || {
      title: "This Month's Releases",
      month: 'Current',
      year: new Date().getFullYear(),
    };

    const currentModels = await ModelItem.find({ isCurrentMonthly: true }).sort({ createdAt: -1 });
    const publicCount = currentModels.filter(m => m.category === 'public-releases').length;
    const exclusiveCount = currentModels.filter(m => m.category === 'exclusives').length;
    const welcomeCount = currentModels.filter(m => m.category === 'welcome-pack').length;
    const freeCount = currentModels.filter(m => m.category === 'free-models').length;

    res.json({
      activeRelease,
      total: currentModels.length,
      publicCount,
      exclusiveCount,
      welcomeCount,
      freeCount,
      models: currentModels,
    });
  } catch (err) {
    console.error('Fetch monthly release error:', err);
    res.status(500).json({ error: 'Failed to fetch monthly release info' });
  }
});

// Update Active Monthly Release Title / Details
app.put('/api/admin/monthly-release', requireAdmin, async (req, res) => {
  try {
    const { title, month, year } = req.body;
    if (!title || !title.trim()) {
      return res.status(400).json({ error: 'Monthly release title is required.' });
    }

    const updated = await Setting.findOneAndUpdate(
      { key: 'activeMonthlyRelease' },
      {
        value: {
          title: title.trim(),
          month: month || '',
          year: year || new Date().getFullYear(),
          updatedAt: new Date(),
        },
      },
      { upsert: true, new: true }
    );

    res.json({ success: true, activeRelease: updated.value });
  } catch (err) {
    console.error('Update monthly release error:', err);
    res.status(500).json({ error: 'Failed to update monthly release title' });
  }
});

// Rollover to Next Month (Archive current drop from Swiper, keep permanently in categories)
app.post('/api/admin/monthly-release/rollover', requireAdmin, async (req, res) => {
  try {
    const { nextTitle, nextMonth, nextYear } = req.body;
    if (!nextTitle || !nextTitle.trim()) {
      return res.status(400).json({ error: 'Next month release title is required.' });
    }

    // 1. Clear isCurrentMonthly on all previous models (they safely remain in public-releases / exclusives)
    const updateRes = await ModelItem.updateMany(
      { isCurrentMonthly: true },
      { $set: { isCurrentMonthly: false } }
    );

    // 2. Set new activeMonthlyRelease
    const newSetting = await Setting.findOneAndUpdate(
      { key: 'activeMonthlyRelease' },
      {
        value: {
          title: nextTitle.trim(),
          month: nextMonth || '',
          year: nextYear || new Date().getFullYear(),
          updatedAt: new Date(),
        },
      },
      { upsert: true, new: true }
    );

    res.json({
      success: true,
      message: `Rolled over to "${nextTitle.trim()}". ${updateRes.modifiedCount} previous models archived from Swiper (retained in categories).`,
      archivedCount: updateRes.modifiedCount,
      activeRelease: newSetting.value,
    });
  } catch (err) {
    console.error('Rollover error:', err);
    res.status(500).json({ error: 'Failed to perform monthly rollover' });
  }
});

// Toggle a Single Model's Current Monthly Drop Status
app.put('/api/admin/monthly-release/toggle-model/:id', requireAdmin, async (req, res) => {
  try {
    const model = await ModelItem.findById(req.params.id);
    if (!model) return res.status(404).json({ error: 'Model not found' });

    const newStatus = !model.isCurrentMonthly;
    model.isCurrentMonthly = newStatus;

    if (newStatus && !model.releaseMonth) {
      const activeSetting = await Setting.findOne({ key: 'activeMonthlyRelease' });
      model.releaseMonth = activeSetting?.value?.title || "This Month's Releases";
    }

    await model.save();
    res.json({ success: true, isCurrentMonthly: model.isCurrentMonthly, model });
  } catch (err) {
    console.error('Toggle model monthly status error:', err);
    res.status(500).json({ error: 'Failed to toggle model monthly status' });
  }
});

// -------------------------------------------------------------
// 4. ADMIN SUBSCRIBER MANAGEMENT
// -------------------------------------------------------------

async function getAllSubscribersFromDB() {
  let subscribers = await Subscriber.find().sort({ subscribedAt: -1, createdAt: -1 });

  // Fallback: in case MongoDB Atlas collection was created with different casing like 'Subscribers' or 'subscriber'
  if ((!subscribers || subscribers.length === 0) && mongoose.connection?.db) {
    try {
      const collections = await mongoose.connection.db.listCollections().toArray();
      const altCol = collections.find((c) => {
        const lower = c.name.toLowerCase();
        return lower === 'subscribers' || lower === 'subscriber' || lower === 'leads';
      });
      if (altCol && altCol.name !== 'subscribers') {
        console.log(`[Subscribers] Reading from alternative collection: ${altCol.name}`);
        subscribers = await mongoose.connection.db
          .collection(altCol.name)
          .find()
          .sort({ subscribedAt: -1, createdAt: -1 })
          .toArray();
      }
    } catch (colErr) {
      console.warn('Alternative collection lookup error:', colErr);
    }
  }

  return subscribers || [];
}

// List Subscribers
app.get('/api/subscribers', requireAdmin, async (req, res) => {
  try {
    const subscribers = await getAllSubscribersFromDB();
    res.json({
      total: subscribers.length,
      subscribers,
    });
  } catch (err) {
    console.error('Failed to fetch subscribers:', err);
    res.status(500).json({ error: 'Failed to fetch subscribers' });
  }
});

// Export Subscribers to CSV
app.get('/api/subscribers/export', requireAdmin, async (req, res) => {
  try {
    const subscribers = await getAllSubscribersFromDB();
    let csv = 'Email,SubscribedAt,Status\n';
    subscribers.forEach((s) => {
      const dateVal = s.subscribedAt || s.createdAt || new Date();
      csv += `"${s.email}","${new Date(dateVal).toISOString()}","${s.status || 'active'}"\n`;
    });

    res.header('Content-Type', 'text/csv');
    res.attachment(`chibiflex-subscribers-${Date.now()}.csv`);
    return res.send(csv);
  } catch (err) {
    res.status(500).json({ error: 'Failed to export subscribers' });
  }
});

// Delete Subscriber
app.delete('/api/subscribers/:id', requireAdmin, async (req, res) => {
  try {
    await Subscriber.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: 'Subscriber removed' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete subscriber' });
  }
});

// -------------------------------------------------------------
// 5. ADMIN SETTINGS (Google Drive Link, SMTP, Password)
// -------------------------------------------------------------
app.get('/api/settings', requireAdmin, async (req, res) => {
  try {
    const driveSetting = await Setting.findOne({ key: 'googleDriveLink' });
    const smtpSetting = await Setting.findOne({ key: 'smtpSettings' });
    const thankYouSetting = await Setting.findOne({ key: 'thankYouEmailSettings' });
    const followUpSetting = await Setting.findOne({ key: 'followUpEmailSettings' });

    res.json({
      googleDriveLink: driveSetting ? driveSetting.value : '',
      smtpSettings: smtpSetting ? smtpSetting.value : {},
      thankYouEmailSettings: thankYouSetting?.value || {
        enabled: true,
        subject: '🎁 Your Free Chibi Flex 3D Models Are Ready To Download!',
        customNote: '',
      },
      followUpEmailSettings: followUpSetting?.value || {
        enabled: true,
        delayDays: 4,
        subject: '🧸 Did you get a chance to print your Chibi Flex models yet? (+ exclusive designs waiting!)',
        heading: 'How Did Your 3D Prints Turn Out? 🖨️✨',
        message: "Hey there!\n\nIt's been a few days since you downloaded your free Chibi Flex articulated 3MF models. We hope they printed smoothly on your build plate!\n\nDid your flexi joints move freely? We'd love to hear how your prints turned out. If you've enjoyed these models, you will absolutely LOVE what we have inside our Patreon community!",
        patreonPitch: "Every month, our members get:\n⭐ 5+ Brand-New Exclusive Articulated Designs\n💼 Commercial License (Sell physical 3D prints of all our models!)\n🎁 Instant Access to the Giant Welcome Pack (20+ premium designs)\n🗳️ Vote on upcoming monthly models in community design polls",
        customNote: '',
      },
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch settings' });
  }
});

app.put('/api/settings', requireAdmin, async (req, res) => {
  try {
    const { googleDriveLink, smtpSettings, thankYouEmailSettings, followUpEmailSettings, newPassword } = req.body;

    if (googleDriveLink !== undefined) {
      await Setting.findOneAndUpdate(
        { key: 'googleDriveLink' },
        { value: googleDriveLink.trim() },
        { upsert: true }
      );
    }

    if (smtpSettings !== undefined) {
      await Setting.findOneAndUpdate(
        { key: 'smtpSettings' },
        { value: smtpSettings },
        { upsert: true }
      );
    }

    if (thankYouEmailSettings !== undefined) {
      await Setting.findOneAndUpdate(
        { key: 'thankYouEmailSettings' },
        { value: thankYouEmailSettings },
        { upsert: true }
      );
    }

    if (followUpEmailSettings !== undefined) {
      await Setting.findOneAndUpdate(
        { key: 'followUpEmailSettings' },
        { value: followUpEmailSettings },
        { upsert: true }
      );
    }

    if (newPassword && newPassword.trim().length >= 4) {
      await Setting.findOneAndUpdate(
        { key: 'adminPassword' },
        { value: newPassword.trim() },
        { upsert: true }
      );
    }

    res.json({ success: true, message: 'Settings updated successfully' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

// Admin: Send Test Thank You Email
app.post('/api/admin/test-thank-you-email', requireAdmin, async (req, res) => {
  try {
    const { testEmail, subject, customNote } = req.body;
    if (!testEmail || !testEmail.includes('@')) {
      return res.status(400).json({ error: 'Valid test email address is required.' });
    }

    const driveSetting = await Setting.findOne({ key: 'googleDriveLink' });
    const driveLink = driveSetting ? driveSetting.value : 'https://drive.google.com';

    const { transporter, from } = await getMailTransporter();
    const finalSubject = subject && subject.trim()
      ? (subject.startsWith('[TEST]') ? subject.trim() : `[TEST] ${subject.trim()}`)
      : '[TEST] 🎁 Your Free Chibi Flex 3D Models Are Ready To Download!';

    const html = getThankYouHtmlEmail(driveLink, customNote);

    await transporter.sendMail({
      from,
      to: testEmail.trim(),
      subject: finalSubject,
      html,
    });

    res.json({ success: true, message: `Test Thank You email sent successfully to ${testEmail}!` });
  } catch (err) {
    console.error('Test thank you email error:', err);
    res.status(500).json({ error: err.message || 'Failed to send test thank you email.' });
  }
});

// Admin: Preview Thank You Email HTML
app.get('/api/admin/preview-thank-you-email', requireAdmin, async (req, res) => {
  try {
    const driveSetting = await Setting.findOne({ key: 'googleDriveLink' });
    const driveLink = driveSetting ? driveSetting.value : 'https://drive.google.com';
    const thankYouSetting = await Setting.findOne({ key: 'thankYouEmailSettings' });
    const settings = thankYouSetting?.value || {};
    const html = getThankYouHtmlEmail(driveLink, settings.customNote);
    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  } catch (err) {
    res.status(500).send('Error generating email preview');
  }
});

// Admin: Send Thank You Email to Custom Email(s)
app.post('/api/admin/send-thank-you-custom', requireAdmin, async (req, res) => {
  try {
    const { emails, subject, customNote } = req.body;
    if (!Array.isArray(emails) || emails.length === 0) {
      return res.status(400).json({ error: 'Please provide at least one recipient email address.' });
    }

    const cleanEmails = emails
      .map((e) => String(e).trim().toLowerCase())
      .filter((e) => e && e.includes('@'));

    if (cleanEmails.length === 0) {
      return res.status(400).json({ error: 'No valid recipient email addresses found.' });
    }

    const driveSetting = await Setting.findOne({ key: 'googleDriveLink' });
    const driveLink = driveSetting ? driveSetting.value : 'https://drive.google.com';

    const thankYouSetting = await Setting.findOne({ key: 'thankYouEmailSettings' });
    const settings = thankYouSetting?.value || {};

    const finalSubject = subject && subject.trim() ? subject.trim() : (settings.subject || '🎁 Your Free Chibi Flex 3D Models Are Ready To Download!');
    const finalNote = customNote !== undefined ? customNote : (settings.customNote || '');

    const { transporter, from } = await getMailTransporter();
    const html = getThankYouHtmlEmail(driveLink, finalNote);

    let sentCount = 0;
    let failedCount = 0;

    for (const em of cleanEmails) {
      try {
        await transporter.sendMail({
          from,
          to: em,
          subject: finalSubject,
          html,
        });
        sentCount++;
        await Subscriber.updateOne(
          { email: em },
          { $set: { thankYouEmailSentAt: new Date() } }
        );
      } catch (e) {
        console.error(`Failed to send thank you email to ${em}:`, e);
        failedCount++;
      }
    }

    res.json({
      success: true,
      message: `Thank You email dispatched to ${sentCount} recipient(s)${failedCount > 0 ? ` (${failedCount} failed)` : ''}.`,
      sentCount,
      failedCount,
    });
  } catch (err) {
    console.error('Send custom thank you error:', err);
    res.status(500).json({ error: err.message || 'Failed to dispatch emails.' });
  }
});

// Admin: Send Test Follow-Up Email
app.post('/api/admin/test-follow-up-email', requireAdmin, async (req, res) => {
  try {
    const { testEmail, subject, heading, message, patreonPitch, customNote } = req.body;
    if (!testEmail || !testEmail.includes('@')) {
      return res.status(400).json({ error: 'Valid test email address is required.' });
    }

    const driveSetting = await Setting.findOne({ key: 'googleDriveLink' });
    const driveLink = driveSetting ? driveSetting.value : 'https://drive.google.com';

    const { transporter, from } = await getMailTransporter();
    const finalSubject = subject && subject.trim()
      ? (subject.startsWith('[TEST]') ? subject.trim() : `[TEST] ${subject.trim()}`)
      : '[TEST] 🧸 Did you get a chance to print your Chibi Flex models yet?';

    const html = getFollowUpHtmlEmail({
      driveLink,
      heading,
      message,
      patreonPitch,
      customNote,
    });

    await transporter.sendMail({
      from,
      to: testEmail.trim(),
      subject: finalSubject,
      html,
    });

    res.json({ success: true, message: `Test Follow-up email sent successfully to ${testEmail}!` });
  } catch (err) {
    console.error('Test follow-up email error:', err);
    res.status(500).json({ error: err.message || 'Failed to send test follow-up email.' });
  }
});

// Admin: Preview Follow-Up Email HTML
app.get('/api/admin/preview-follow-up-email', requireAdmin, async (req, res) => {
  try {
    const driveSetting = await Setting.findOne({ key: 'googleDriveLink' });
    const driveLink = driveSetting ? driveSetting.value : 'https://drive.google.com';
    const followUpSetting = await Setting.findOne({ key: 'followUpEmailSettings' });
    const settings = followUpSetting?.value || {};
    const html = getFollowUpHtmlEmail({
      ...settings,
      driveLink,
    });
    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  } catch (err) {
    res.status(500).send('Error generating email preview');
  }
});

// Admin: Send Follow-Up Email to Custom Email(s)
app.post('/api/admin/send-follow-up-custom', requireAdmin, async (req, res) => {
  try {
    const { emails, subject, heading, message, patreonPitch, customNote } = req.body;
    if (!Array.isArray(emails) || emails.length === 0) {
      return res.status(400).json({ error: 'Please provide at least one recipient email address.' });
    }

    const cleanEmails = emails
      .map((e) => String(e).trim().toLowerCase())
      .filter((e) => e && e.includes('@'));

    if (cleanEmails.length === 0) {
      return res.status(400).json({ error: 'No valid recipient email addresses found.' });
    }

    const driveSetting = await Setting.findOne({ key: 'googleDriveLink' });
    const driveLink = driveSetting ? driveSetting.value : 'https://drive.google.com';

    const followUpSetting = await Setting.findOne({ key: 'followUpEmailSettings' });
    const defaults = followUpSetting?.value || {};

    const finalSubject = subject && subject.trim() ? subject.trim() : (defaults.subject || '🧸 Did you get a chance to print your Chibi Flex models yet?');
    const { transporter, from } = await getMailTransporter();

    const html = getFollowUpHtmlEmail({
      driveLink,
      heading: heading || defaults.heading,
      message: message || defaults.message,
      patreonPitch: patreonPitch || defaults.patreonPitch,
      customNote: customNote !== undefined ? customNote : defaults.customNote,
    });

    let sentCount = 0;
    let failedCount = 0;

    for (const em of cleanEmails) {
      try {
        await transporter.sendMail({
          from,
          to: em,
          subject: finalSubject,
          html,
        });
        sentCount++;
        await Subscriber.updateOne(
          { email: em },
          { $set: { followUpEmailSentAt: new Date(), followUpEmailStatus: 'sent' } }
        );
      } catch (e) {
        console.error(`Failed to send follow-up email to ${em}:`, e);
        failedCount++;
      }
    }

    res.json({
      success: true,
      message: `Follow-up email dispatched to ${sentCount} recipient(s)${failedCount > 0 ? ` (${failedCount} failed)` : ''}.`,
      sentCount,
      failedCount,
    });
  } catch (err) {
    console.error('Send custom follow-up error:', err);
    res.status(500).json({ error: err.message || 'Failed to dispatch follow-up emails.' });
  }
});

// Admin: Trigger Follow-Up Check Immediately
app.post('/api/admin/run-follow-up-now', requireAdmin, async (req, res) => {
  try {
    const result = await processFollowUpEmails();
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to execute follow-up check.' });
  }
});

// -------------------------------------------------------------
// 6. EMAIL MARKETING (Nodemailer Broadcast)
// -------------------------------------------------------------
app.post('/api/admin/send-email', requireAdmin, async (req, res) => {
  try {
    const { subject, htmlContent, isTest, testEmail, recipientEmails } = req.body;

    if (!subject || !htmlContent) {
      return res.status(400).json({ error: 'Subject and email body are required.' });
    }

    // Retrieve SMTP Settings
    const smtpSetting = await Setting.findOne({ key: 'smtpSettings' });
    const smtp = smtpSetting?.value;

    if (!smtp || !smtp.user || !smtp.pass) {
      return res.status(400).json({
        error: 'SMTP credentials not configured. Please fill in your SMTP details in Settings first.',
      });
    }

    // Configure Nodemailer Transporter
    const transporter = nodemailer.createTransport({
      host: smtp.host || 'smtp.gmail.com',
      port: Number(smtp.port) || 465,
      secure: Number(smtp.port) === 465,
      auth: {
        user: smtp.user,
        pass: smtp.pass,
      },
    });

    // 1. Test email flow
    if (isTest) {
      if (!testEmail || !testEmail.includes('@')) {
        return res.status(400).json({ error: 'Please provide a valid test email address.' });
      }

      await transporter.sendMail({
        from: smtp.from || smtp.user,
        to: testEmail.trim(),
        subject: `[TEST] ${subject}`,
        html: htmlContent,
      });

      return res.json({ success: true, message: `Test email sent successfully to ${testEmail}!` });
    }

    // 2. Determine target emails (either selected users or all active subscribers)
    let targetEmails = [];

    if (Array.isArray(recipientEmails) && recipientEmails.length > 0) {
      targetEmails = recipientEmails
        .map((e) => (typeof e === 'string' ? e.trim().toLowerCase() : ''))
        .filter((e) => e && e.includes('@'));

      if (targetEmails.length === 0) {
        return res.status(400).json({ error: 'No valid recipient email addresses selected.' });
      }
    } else {
      const subscribers = await getAllSubscribersFromDB();
      const activeSubs = subscribers.filter((s) => !s.status || s.status === 'active');
      if (activeSubs.length === 0) {
        return res.status(400).json({ error: 'No active subscribers found to send to.' });
      }
      targetEmails = activeSubs.map((s) => s.email);
    }

    let successCount = 0;
    let failCount = 0;

    // Send emails sequentially to target recipients
    for (const email of targetEmails) {
      try {
        await transporter.sendMail({
          from: smtp.from || smtp.user,
          to: email,
          subject: subject,
          html: htmlContent,
        });
        successCount++;
      } catch (sendErr) {
        console.error(`Failed to send to ${email}:`, sendErr.message);
        failCount++;
      }
    }

    res.json({
      success: true,
      message: `Email campaign complete! Successfully sent to ${successCount} recipient(s).${failCount > 0 ? ` (${failCount} failed)` : ''}`,
      sentCount: successCount,
      failedCount: failCount,
      totalTargeted: targetEmails.length,
    });
  } catch (err) {
    console.error('Email send error:', err);
    res.status(500).json({ error: 'Failed to send email: ' + err.message });
  }
});

// -------------------------------------------------------------
// 7. PATREON FREE MEMBERS MANAGEMENT & EMAIL DISPATCH
// -------------------------------------------------------------

// List Patreon Members with search, filters, pagination, and stats
app.get('/api/admin/patreon-members', requireAdmin, async (req, res) => {
  try {
    const { search, tier, status, page = 1, limit = 25 } = req.query;

    const query = {};
    if (search && search.trim()) {
      const s = search.trim();
      query.$or = [
        { name: { $regex: s, $options: 'i' } },
        { email: { $regex: s, $options: 'i' } },
        { userId: { $regex: s, $options: 'i' } },
      ];
    }

    if (tier && tier !== 'all') {
      query.tier = tier;
    }

    if (status && status !== 'all') {
      query.status = status;
    }

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.max(1, Math.min(200, parseInt(limit, 10) || 25));
    const skip = (pageNum - 1) * limitNum;

    const [total, members, totalAll, totalActive, totalEmailed] = await Promise.all([
      PatreonMember.countDocuments(query),
      PatreonMember.find(query).sort({ patronageSinceDate: -1, createdAt: -1 }).skip(skip).limit(limitNum),
      PatreonMember.countDocuments(),
      PatreonMember.countDocuments({ status: 'active' }),
      PatreonMember.countDocuments({ 'emailsSent.0': { $exists: true } }),
    ]);

    const totalPages = Math.max(1, Math.ceil(total / limitNum));

    res.json({
      success: true,
      total,
      page: pageNum,
      totalPages,
      members,
      stats: {
        totalAll,
        totalActive,
        totalEmailed,
      },
    });
  } catch (err) {
    console.error('Fetch Patreon members error:', err);
    res.status(500).json({ error: 'Failed to fetch Patreon members' });
  }
});

// Add a Single Patreon Member
app.post('/api/admin/patreon-members', requireAdmin, async (req, res) => {
  try {
    const { name, email, tier, patronStatus, notes } = req.body;
    if (!email || !email.includes('@')) {
      return res.status(400).json({ error: 'Valid email address is required.' });
    }

    const cleanEmail = email.trim().toLowerCase();
    const existing = await PatreonMember.findOne({ email: cleanEmail });
    if (existing) {
      return res.status(400).json({ error: `Member with email "${cleanEmail}" already exists.` });
    }

    const member = await PatreonMember.create({
      name: name?.trim() || 'Patreon Member',
      email: cleanEmail,
      tier: tier?.trim() || 'Free',
      patronStatus: patronStatus?.trim() || 'Free Member',
      notes: notes?.trim() || '',
      patronageSinceDate: new Date(),
      status: 'active',
    });

    res.json({ success: true, message: 'Patreon member created successfully!', member });
  } catch (err) {
    console.error('Create Patreon member error:', err);
    res.status(500).json({ error: err.message || 'Failed to create Patreon member' });
  }
});

// Update Patreon Member
app.put('/api/admin/patreon-members/:id', requireAdmin, async (req, res) => {
  try {
    const { name, email, tier, patronStatus, status, notes } = req.body;
    const member = await PatreonMember.findById(req.params.id);
    if (!member) {
      return res.status(404).json({ error: 'Patreon member not found.' });
    }

    if (email && email.trim().toLowerCase() !== member.email) {
      const cleanEmail = email.trim().toLowerCase();
      const existing = await PatreonMember.findOne({ email: cleanEmail });
      if (existing && existing._id.toString() !== member._id.toString()) {
        return res.status(400).json({ error: `Email "${cleanEmail}" is already used by another member.` });
      }
      member.email = cleanEmail;
    }

    if (name !== undefined) member.name = name.trim();
    if (tier !== undefined) member.tier = tier.trim();
    if (patronStatus !== undefined) member.patronStatus = patronStatus.trim();
    if (status !== undefined) member.status = status;
    if (notes !== undefined) member.notes = notes.trim();

    await member.save();
    res.json({ success: true, message: 'Member updated successfully!', member });
  } catch (err) {
    console.error('Update Patreon member error:', err);
    res.status(500).json({ error: 'Failed to update member' });
  }
});

// Delete Patreon Member
app.delete('/api/admin/patreon-members/:id', requireAdmin, async (req, res) => {
  try {
    await PatreonMember.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: 'Patreon member removed.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete Patreon member' });
  }
});

// Export Patreon Members to CSV
app.get('/api/admin/patreon-members/export', requireAdmin, async (req, res) => {
  try {
    const members = await PatreonMember.find().sort({ patronageSinceDate: -1, createdAt: -1 });
    let csv = 'Name,Email,Tier,PatronStatus,PatronageSinceDate,Status,LastEmailedTemplate,LastEmailedAt\n';

    members.forEach((m) => {
      const lastEmail = m.emailsSent && m.emailsSent.length > 0 ? m.emailsSent[m.emailsSent.length - 1] : null;
      const lastTpl = lastEmail ? (lastEmail.templateKey || lastEmail.subject) : '';
      const lastSent = lastEmail && lastEmail.sentAt ? new Date(lastEmail.sentAt).toISOString() : '';
      const since = m.patronageSinceDate ? new Date(m.patronageSinceDate).toISOString() : '';

      csv += `"${(m.name || '').replace(/"/g, '""')}","${m.email}","${m.tier || 'Free'}","${m.patronStatus || 'Free Member'}","${since}","${m.status || 'active'}","${lastTpl}","${lastSent}"\n`;
    });

    res.header('Content-Type', 'text/csv');
    res.attachment(`chibiflex-patreon-members-${Date.now()}.csv`);
    return res.send(csv);
  } catch (err) {
    res.status(500).json({ error: 'Failed to export Patreon members' });
  }
});

// Bulk Import Patreon Members via CSV text
app.post('/api/admin/patreon-members/import-csv', requireAdmin, async (req, res) => {
  try {
    const { csvText } = req.body;
    if (!csvText || !csvText.trim()) {
      return res.status(400).json({ error: 'CSV text is required.' });
    }

    const lines = csvText.split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (lines.length === 0) {
      return res.status(400).json({ error: 'No data rows found in CSV.' });
    }

    const headerParts = lines[0].split(',').map((h) => h.trim().toLowerCase());
    const nameIdx = headerParts.indexOf('name') !== -1 ? headerParts.indexOf('name') : 0;
    const emailIdx = headerParts.indexOf('email') !== -1 ? headerParts.indexOf('email') : 1;
    const tierIdx = headerParts.indexOf('tier') !== -1 ? headerParts.indexOf('tier') : 10;
    const statusIdx = headerParts.indexOf('patron status') !== -1 ? headerParts.indexOf('patron status') : 3;

    const startRow = lines[0].toLowerCase().includes('email') ? 1 : 0;
    const bulkOps = [];

    for (let i = startRow; i < lines.length; i++) {
      const parts = lines[i].split(',');
      const email = parts[emailIdx]?.trim().toLowerCase();
      if (email && email.includes('@')) {
        const name = parts[nameIdx]?.trim() || 'Patreon Member';
        const tier = parts[tierIdx]?.trim() || 'Free';
        const patronStatus = parts[statusIdx]?.trim() || 'Free Member';

        bulkOps.push({
          updateOne: {
            filter: { email },
            update: {
              $setOnInsert: {
                name,
                email,
                tier,
                patronStatus,
                status: 'active',
                patronageSinceDate: new Date(),
              },
            },
            upsert: true,
          },
        });
      }
    }

    if (bulkOps.length === 0) {
      return res.status(400).json({ error: 'No valid rows with emails found.' });
    }

    const result = await PatreonMember.bulkWrite(bulkOps);
    res.json({
      success: true,
      message: `Processed ${bulkOps.length} row(s). Inserted ${result.upsertedCount} new member(s).`,
      importedCount: result.upsertedCount,
      totalProcessed: bulkOps.length,
    });
  } catch (err) {
    console.error('Patreon CSV import error:', err);
    res.status(500).json({ error: err.message || 'Failed to import CSV' });
  }
});

// Get Email Templates metadata
app.get('/api/admin/patreon-members/templates', requireAdmin, async (req, res) => {
  try {
    const driveSetting = await Setting.findOne({ key: 'googleDriveLink' });
    const driveLink = driveSetting ? driveSetting.value : 'https://drive.google.com';

    res.json({
      templates: PATREON_TEMPLATES,
      driveLink,
      patreonLink: 'https://www.patreon.com/ChibiFlex',
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch templates' });
  }
});

// Preview Patreon Email HTML
app.post('/api/admin/patreon-members/preview-email', requireAdmin, async (req, res) => {
  try {
    const { templateKey = 'try-free-models', heading, message, customNote, ctaText, sampleName = 'Alex' } = req.body;
    const driveSetting = await Setting.findOne({ key: 'googleDriveLink' });
    const driveLink = driveSetting ? driveSetting.value : 'https://drive.google.com';

    const tpl = PATREON_TEMPLATES[templateKey] || PATREON_TEMPLATES['try-free-models'];
    const html = renderPatreonEmail(templateKey, {
      memberName: sampleName,
      driveLink,
      heading,
      message,
      customNote,
      ctaText,
    });

    res.json({ success: true, html, subject: tpl.subject });
  } catch (err) {
    console.error('Preview error:', err);
    res.status(500).json({ error: 'Failed to generate preview' });
  }
});

// Send Email Campaign to Selected or All Patreon Members
app.post('/api/admin/patreon-members/send-email', requireAdmin, async (req, res) => {
  try {
    const {
      templateKey = 'try-free-models',
      subject,
      heading,
      message,
      customNote,
      ctaText,
      isTest,
      testEmail,
      recipientEmails,
    } = req.body;

    const tpl = PATREON_TEMPLATES[templateKey] || PATREON_TEMPLATES['try-free-models'];
    const finalSubject = (subject && subject.trim()) ? subject.trim() : tpl.subject;

    const driveSetting = await Setting.findOne({ key: 'googleDriveLink' });
    const driveLink = driveSetting ? driveSetting.value : 'https://drive.google.com';

    const { transporter, from } = await getMailTransporter();

    // 1. Test Email flow
    if (isTest) {
      if (!testEmail || !testEmail.includes('@')) {
        return res.status(400).json({ error: 'Valid test email address is required.' });
      }

      const testHtml = renderPatreonEmail(templateKey, {
        memberName: 'Tester',
        driveLink,
        heading,
        message,
        customNote,
        ctaText,
      });

      await transporter.sendMail({
        from,
        to: testEmail.trim(),
        subject: `[TEST] ${finalSubject}`,
        html: testHtml,
      });

      return res.json({
        success: true,
        message: `Test email sent successfully to ${testEmail}!`,
      });
    }

    // 2. Real Campaign Flow
    let targetMembers = [];
    if (Array.isArray(recipientEmails) && recipientEmails.length > 0) {
      const cleanList = recipientEmails.map((e) => (typeof e === 'string' ? e.trim().toLowerCase() : '')).filter((e) => e && e.includes('@'));
      targetMembers = await PatreonMember.find({ email: { $in: cleanList }, status: 'active' });
      const foundEmails = new Set(targetMembers.map((m) => m.email));
      for (const e of cleanList) {
        if (!foundEmails.has(e)) {
          targetMembers.push({ name: 'Patreon Member', email: e });
        }
      }
    } else {
      targetMembers = await PatreonMember.find({ status: 'active' });
    }

    if (targetMembers.length === 0) {
      return res.status(400).json({ error: 'No active Patreon recipients found to send to.' });
    }

    let successCount = 0;
    let failCount = 0;

    for (const member of targetMembers) {
      try {
        const personalizedHtml = renderPatreonEmail(templateKey, {
          memberName: member.name || 'Patreon Member',
          driveLink,
          heading,
          message,
          customNote,
          ctaText,
        });

        await transporter.sendMail({
          from,
          to: member.email,
          subject: finalSubject,
          html: personalizedHtml,
        });

        successCount++;

        // Record in emailsSent if member is in DB
        if (member._id) {
          await PatreonMember.findByIdAndUpdate(member._id, {
            $push: {
              emailsSent: {
                templateKey,
                subject: finalSubject,
                sentAt: new Date(),
              },
            },
          });
        }
      } catch (sendErr) {
        console.error(`[Patreon Email] Failed to send to ${member.email}:`, sendErr.message);
        failCount++;
      }
    }

    res.json({
      success: true,
      message: `Patreon campaign complete! Sent to ${successCount} member(s).${failCount > 0 ? ` (${failCount} failed)` : ''}`,
      sentCount: successCount,
      failedCount: failCount,
      totalTargeted: targetMembers.length,
    });
  } catch (err) {
    console.error('Patreon campaign dispatch error:', err);
    res.status(500).json({ error: err.message || 'Failed to dispatch Patreon emails.' });
  }
});

// -------------------------------------------------------------
// Connect Database & Start Server
// -------------------------------------------------------------
async function startServer() {
  try {
    const mongoUri = process.env.MONGODB_URI;
    if (!mongoUri) {
      throw new Error('MONGODB_URI is not defined in .env');
    }

    await mongoose.connect(mongoUri);
    console.log('✅ Connected to MongoDB Atlas');

    await initDefaults();
    console.log('✅ Default settings initialized');

    app.listen(PORT, () => {
      console.log(`🚀 ChibiFlex API Server running on port ${PORT}`);
      // Launch automated follow-up check (initial check in 15 seconds, then recurring every 30 minutes)
      setTimeout(processFollowUpEmails, 15000);
      setInterval(processFollowUpEmails, 30 * 60 * 1000);
    });
  } catch (err) {
    console.error('❌ Server startup error:', err);
    process.exit(1);
  }
}

startServer();
