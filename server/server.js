import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import multer from 'multer';
import jwt from 'jsonwebtoken';
import nodemailer from 'nodemailer';
import dns from 'dns/promises';
import { ModelItem } from './models/ModelItem.js';
import { Subscriber } from './models/Subscriber.js';
import { Setting } from './models/Setting.js';
import { Category } from './models/Category.js';
import { OtpVerification } from './models/OtpVerification.js';
import { uploadToR2, deleteFromR2 } from './r2.js';

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
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized. Please login.' });
  }
  const token = authHeader.split(' ')[1];
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
    { name: 'Free Models', slug: 'free-models', order: 4, description: 'Complimentary STL designs for newcomers' },
  ];

  for (const cat of officialCategories) {
    const exists = await Category.findOne({ slug: cat.slug });
    if (!exists) {
      await Category.create(cat);
    }
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

    const models = await ModelItem.find(filter).sort({ order: 1, createdAt: -1 });
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

    const currentModels = await ModelItem.find({ isCurrentMonthly: true }).sort({ order: 1, createdAt: -1 });
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

// List Subscribers
app.get('/api/subscribers', requireAdmin, async (req, res) => {
  try {
    const subscribers = await Subscriber.find().sort({ subscribedAt: -1 });
    res.json({
      total: subscribers.length,
      subscribers,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch subscribers' });
  }
});

// Export Subscribers to CSV
app.get('/api/subscribers/export', requireAdmin, async (req, res) => {
  try {
    const subscribers = await Subscriber.find().sort({ subscribedAt: -1 });
    let csv = 'Email,SubscribedAt,Status\n';
    subscribers.forEach((s) => {
      csv += `"${s.email}","${new Date(s.subscribedAt).toISOString()}","${s.status}"\n`;
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

    res.json({
      googleDriveLink: driveSetting ? driveSetting.value : '',
      smtpSettings: smtpSetting ? smtpSetting.value : {},
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch settings' });
  }
});

app.put('/api/settings', requireAdmin, async (req, res) => {
  try {
    const { googleDriveLink, smtpSettings, newPassword } = req.body;

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
      const subscribers = await Subscriber.find({ status: 'active' });
      if (subscribers.length === 0) {
        return res.status(400).json({ error: 'No active subscribers found to send to.' });
      }
      targetEmails = subscribers.map((s) => s.email);
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
    });
  } catch (err) {
    console.error('❌ Server startup error:', err);
    process.exit(1);
  }
}

startServer();
