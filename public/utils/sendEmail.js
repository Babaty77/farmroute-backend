const nodemailer = require('nodemailer');

const sendEmail = async (options) => {
  // Create transporter using a free SMTP service like Gmail or SendGrid
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS, // App Password from Google
    },
  });

  const mailOptions = {
    from: `"FarmRoute Support" <${process.env.EMAIL_USER}>`,
    to: options.email,
    subject: options.subject,
    text: options.message,
  };

  await transporter.sendMail(mailOptions);
};

module.exports = sendEmail;