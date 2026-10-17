/**
 * Patreon Email Templates for ChibiFlex Free Members
 */

export const PATREON_TEMPLATES = {
  'try-free-models': {
    key: 'try-free-models',
    name: '🎁 Template 1: Try Our Free Models (Google Drive Link)',
    subject: '🎁 Special Gift: Download Free Exclusive Chibi Flex 3D Models!',
    badge: 'Try Free Models',
    badgeColor: '#00d2ff',
    defaultHeading: 'A Special Gift for Our Patreon Community! 🎁✨',
    defaultMessage: `Hey {NAME}!

Thank you so much for following Chibi Flex on Patreon! As a token of our appreciation, we want to invite you to try out our curated collection of print-in-place articulated 3D models — 100% FREE!

Every model is specially optimized in 3MF format for smooth printing with built-in color profiles for Bambu Lab printers, as well as single-color printing for any standard FDM machine. No supports needed, just slice, print, and watch them flex!`,
    ctaText: '📥 Download Free 3D Models Now &rarr;',
    ctaType: 'drive',
    secondaryHeading: 'What makes Chibi Flex models special?',
    secondaryPoints: [
      '⚡ 100% Print-in-Place & Pre-supported (no messy support removal)',
      '🎨 Multi-color 3MF profiles included (Bambu Studio / OrcaSlicer ready)',
      '🧸 Fun, smooth articulating joints that kids and collectors adore',
      '🌟 Perfect test prints for tuning your 3D printer calibration',
    ],
  },

  'printed-free-models-join': {
    key: 'printed-free-models-join',
    name: '🖨️ Template 2: Printed Free Models? Join Our Paid Patreon Tiers!',
    subject: '🖨️ Loved the free prints? Unlock 20+ Welcome Pack Designs on Patreon!',
    badge: 'Upgrade to Paid Tier',
    badgeColor: '#ec4899',
    defaultHeading: 'How Did Your 3D Prints Turn Out? 🖨️✨',
    defaultMessage: `Hey {NAME}!

We hope you've had a blast 3D printing our flexi models! Did your joints move smoothly right off the build plate?

If you enjoyed printing those free designs, you're going to fall in love with our full Patreon library! When you upgrade to our paid supporter tiers, you unlock an entire universe of premium articulated creatures and collectible toys every single month.`,
    ctaText: '🌟 Join Chibi Flex Patreon & Unlock 20+ Models &rarr;',
    ctaType: 'patreon',
    secondaryHeading: 'What you unlock as an active Patreon member:',
    secondaryPoints: [
      '🎁 Instant Giant Welcome Pack — 20+ exclusive premium articulated models right away',
      '🚀 Monthly Fresh Drops — 5+ brand-new articulated designs every single month',
      '💼 Commercial License Option — Legally sell physical 3D prints of all our designs',
      '🗳️ Community Polls — Help choose and vote on what cute models we sculpt next',
      '💬 Exclusive Member Discord — Chat directly with the creators & fellow 3D makers',
    ],
  },
};

export function renderPatreonEmail(templateKey, options = {}) {
  const tpl = PATREON_TEMPLATES[templateKey] || PATREON_TEMPLATES['try-free-models'];

  const memberName = (options.memberName && options.memberName.trim()) ? options.memberName.trim() : 'there';
  const driveLink = options.driveLink || 'https://drive.google.com';
  const patreonLink = options.patreonLink || 'https://www.patreon.com/ChibiFlex';
  const websiteLink = options.websiteLink || 'https://chibiflex.com';
  const currentYear = new Date().getFullYear();

  const heading = options.heading || tpl.defaultHeading;
  const rawMessage = options.message || tpl.defaultMessage;
  const messageWithPersonalization = rawMessage.replace(/\{NAME\}/g, memberName);

  const customNote = options.customNote || '';
  const customNoteHtml = customNote && customNote.trim()
    ? `
      <div style="background: rgba(236, 72, 153, 0.08); border-left: 4px solid #ec4899; padding: 14px 18px; border-radius: 8px; margin: 20px 0; text-align: left;">
        <p style="margin: 0; font-size: 14px; line-height: 1.6; color: #f1f5f9; font-style: italic;">
          "${customNote.trim().replace(/</g, '&lt;').replace(/>/g, '&gt;')}"
        </p>
      </div>
    `
    : '';

  const paragraphsHtml = messageWithPersonalization
    .split('\n\n')
    .filter((p) => p.trim())
    .map((p) => `<p style="margin: 0 0 16px 0; font-size: 15px; line-height: 1.65; color: #cbd5e1;">${p.replace(/\n/g, '<br>').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/&lt;br&gt;/g, '<br>')}</p>`)
    .join('');

  const pointsList = options.secondaryPoints || tpl.secondaryPoints;
  const pointsHtml = pointsList
    .map((pt) => `
      <tr>
        <td style="padding: 7px 0; font-size: 14px; color: #f1f5f9; line-height: 1.5;">
          ${pt.replace(/</g, '&lt;').replace(/>/g, '&gt;')}
        </td>
      </tr>
    `)
    .join('');

  const primaryBtnLink = tpl.ctaType === 'patreon' ? patreonLink : driveLink;
  const primaryBtnText = options.ctaText || tpl.ctaText;

  return `
  <!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${tpl.name}</title>
  </head>
  <body style="margin: 0; padding: 0; background-color: #0b0c10; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #ffffff;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color: #0b0c10; padding: 40px 15px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width: 620px; background: #161922; border-radius: 18px; overflow: hidden; border: 1px solid rgba(255, 255, 255, 0.1); box-shadow: 0 20px 40px rgba(0,0,0,0.5);">
            
            <!-- Header Brand -->
            <tr>
              <td style="padding: 35px 35px 25px 35px; text-align: center; background: linear-gradient(135deg, rgba(236, 72, 153, 0.15) 0%, rgba(0, 210, 255, 0.15) 100%); border-bottom: 1px solid rgba(255, 255, 255, 0.08);">
                <div style="display: inline-block; padding: 10px 18px; border-radius: 30px; background: rgba(0, 0, 0, 0.4); border: 1px solid rgba(255, 255, 255, 0.12); margin-bottom: 14px;">
                  <span style="font-size: 13px; font-weight: 700; letter-spacing: 1.5px; text-transform: uppercase; color: ${tpl.badgeColor};">
                    ${tpl.badge}
                  </span>
                </div>
                <h1 style="margin: 0; font-size: 26px; font-weight: 800; color: #ffffff; letter-spacing: -0.5px;">
                  Chibi <span style="color: #ec4899;">Flex</span>
                </h1>
                <p style="margin: 6px 0 0 0; font-size: 13px; color: #94a3b8; font-weight: 500;">
                  Ultra-Cute Articulated 3D Printables
                </p>
              </td>
            </tr>

            <!-- Body Content -->
            <tr>
              <td style="padding: 35px 35px 25px 35px;">
                <h2 style="margin: 0 0 18px 0; font-size: 21px; font-weight: 700; color: #f8fafc; line-height: 1.35;">
                  ${heading}
                </h2>

                ${paragraphsHtml}

                ${customNoteHtml}

                <!-- Primary CTA Button -->
                <div style="text-align: center; margin: 30px 0 25px 0;">
                  <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin: 0 auto;">
                    <tr>
                      <td style="border-radius: 12px; background: linear-gradient(135deg, #ec4899 0%, #db2777 50%, #f43f5e 100%); box-shadow: 0 8px 24px rgba(236, 72, 153, 0.4);">
                        <a href="${primaryBtnLink}" target="_blank" style="padding: 16px 36px; border-radius: 12px; font-size: 15px; font-weight: 800; color: #ffffff; text-decoration: none; display: inline-block; letter-spacing: 0.3px;">
                          ${primaryBtnText}
                        </a>
                      </td>
                    </tr>
                  </table>
                </div>

                <!-- Secondary Perks Box -->
                <div style="background: rgba(255, 255, 255, 0.03); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 14px; padding: 22px 24px; margin: 28px 0 20px 0;">
                  <h3 style="margin: 0 0 14px 0; font-size: 15px; font-weight: 700; color: #00d2ff; text-transform: uppercase; letter-spacing: 0.5px;">
                    ${tpl.secondaryHeading}
                  </h3>
                  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                    ${pointsHtml}
                  </table>
                </div>

                <!-- Secondary Patreon/Website Links -->
                <div style="margin-top: 25px; padding-top: 20px; border-top: 1px dashed rgba(255, 255, 255, 0.1); text-align: center;">
                  <p style="margin: 0 0 12px 0; font-size: 13px; color: #94a3b8;">
                    Explore more on our official channels:
                  </p>
                  <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin: 0 auto;">
                    <tr>
                      <td style="padding: 0 8px;">
                        <a href="${patreonLink}" target="_blank" style="display: inline-block; padding: 9px 18px; border-radius: 8px; font-size: 13px; font-weight: 600; color: #f43f5e; background: rgba(244, 63, 94, 0.12); border: 1px solid rgba(244, 63, 94, 0.3); text-decoration: none;">
                          🧸 Patreon Page
                        </a>
                      </td>
                      <td style="padding: 0 8px;">
                        <a href="${websiteLink}" target="_blank" style="display: inline-block; padding: 9px 18px; border-radius: 8px; font-size: 13px; font-weight: 600; color: #00d2ff; background: rgba(0, 210, 255, 0.12); border: 1px solid rgba(0, 210, 255, 0.3); text-decoration: none;">
                          🌐 ChibiFlex.com
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
                  You received this email because you are a member of Chibi Flex on Patreon.
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
