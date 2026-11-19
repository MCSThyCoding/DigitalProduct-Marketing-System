const nodemailer = require('nodemailer');

const hasSmtp = Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);

const transporter = hasSmtp
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: Number(process.env.SMTP_PORT || 587) === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    })
  : null;

async function sendOtpEmail(to, code) {
  if (!transporter) {
    if (process.env.OTP_DEV_ECHO === 'true') {
      console.log(`[OTP DEV] Code for ${to}: ${code}`);
      return { delivered: false, devCode: code };
    }
    console.error(`[OTP] SMTP not configured - cannot send code to ${to}`);
    return { delivered: false };
  }

  await transporter.sendMail({
    from: process.env.MAIL_FROM || process.env.SMTP_USER,
    to,
    subject: 'Your Digital Market verification code',
    text: `Your verification code is ${code}. It expires in 10 minutes.`,
    html: `<p>Your verification code is <strong>${code}</strong>.</p><p>It expires in 10 minutes.</p>`
  });
  return { delivered: true };
}

module.exports = { sendOtpEmail };
