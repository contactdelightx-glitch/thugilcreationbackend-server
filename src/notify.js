// The emails the shop sends, one function per event. Every function is safe to call without awaiting: it looks up what
// it needs, sends, and swallows its own errors (a failed email must never fail the request that triggered it).
const pool = require('./db');
const { sendMail, layout, esc, adminEmails, siteUrl } = require('./mailer');

const money = (n) => `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const paiseToMoney = (p) => money(Number(p) / 100);
const day = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' }) : '');
const safe = (name, fn) => (...args) => Promise.resolve().then(() => fn(...args)).catch((err) => console.error(`[mail] ${name} failed:`, err.message));
const toAdmin = (subject, html, tags) => { const to = adminEmails(); return to.length ? sendMail({ to, subject, html, tags }) : false; };
const customerOf = async (customerId) => (await pool.query('SELECT full_name, email FROM users WHERE customer_id = $1', [customerId])).rows[0] || null;
const first = (name) => String(name || '').trim().split(/\s+/)[0] || 'there';

const greet = (name) => `Greetings, ${first(name)}!`;
const link = (path) => `${siteUrl()}/${path}`;

/** 1 + 6: a design order was paid and saved */
const orderPaid = safe('orderPaid', async ({ customerId, orderId, total, items, paymentId }) => {
  const user = await customerOf(customerId);
  const rows = [['Order', `#${orderId}`], ['Amount paid', money(total)], ['Payment id', paymentId], ...items.map((i) => ['Design', `${i.name} (${Number(i.final_price) === 0 ? 'Free' : money(i.final_price)})`])];
  if (user?.email) {
    await sendMail({
      to: [{ email: user.email, name: user.full_name }], tags: ['order'],
      subject: `Payment confirmed: order #${orderId}`,
      html: layout({
        topLink: { label: 'Download my designs', url: link('#Purchases') },
        eyebrow: greet(user.full_name), title: ['Payment', 'confirmed'],
        intro: `Thank you for your order. Your payment was received and your ${items.length === 1 ? 'design is' : 'designs are'} ready to download in full quality.`,
        button: { label: 'Download my designs', url: link('#Purchases') },
        detailsTitle: 'Your order:', rows,
        nextTitle: ['Your designs are ', 'ready to download:'],
        nextPoints: ['Open Profile, then Purchases in the app', 'Download the original full-quality file of each design', 'Leave a rating once you have used a design'],
        note: 'Keep this email as your receipt. Questions? Reply to this email.',
      }),
    });
  }
  await toAdmin(`New order #${orderId} (${money(total)})`, layout({ eyebrow: 'Admin alert', title: ['New', 'order'], intro: `${esc(user?.full_name || 'A customer')} just paid ${esc(money(total))}.`, detailsTitle: 'Order details:', rows: [['Customer', `${user?.full_name || 'Unknown'} <${user?.email || 'no email'}>`], ...rows] }), ['admin', 'order']);
});

/** 2 + 7: a course was bought */
const coursePurchased = safe('coursePurchased', async ({ customerId, enrollmentId, courseId, packageKey, amount, paymentId }) => {
  const user = await customerOf(customerId);
  const e = (await pool.query('SELECT c.title, e.expires_at FROM enrollments e JOIN courses c ON c.id = e.course_id WHERE e.id = $1', [enrollmentId])).rows[0] || {};
  const pack = packageKey ? packageKey[0].toUpperCase() + packageKey.slice(1) : '';
  const rows = [['Course', e.title || `#${courseId}`], ...(pack ? [['Package', pack]] : []), ['Amount paid', money(amount)], ['Access until', day(e.expires_at)], ['Enrolment', `#${enrollmentId}`], ['Payment id', paymentId]];
  if (user?.email) {
    await sendMail({
      to: [{ email: user.email, name: user.full_name }], tags: ['enrolment'],
      subject: `You are enrolled: ${e.title || 'your course'}`,
      html: layout({
        topLink: { label: 'Start learning', url: link(`#Learn/${courseId}`) },
        eyebrow: greet(user.full_name), title: ['Welcome to', 'your course'],
        intro: `Your payment was successful and <strong>${esc(e.title || 'your course')}</strong> is open. Learn at your own pace, any time before your access ends.`,
        button: { label: 'Start learning', url: link(`#Learn/${courseId}`) },
        detailsTitle: 'Your enrolment:', rows,
        nextTitle: ['Getting started ', 'is simple:'],
        nextPoints: ['Open Profile, then My learning in the app', 'Watch 60% of a lesson to unlock the next one', 'Finish 80% of the course to request your certificate (certificate packages)', 'Ask your instructor in the Doubt chat (doubt support packages)'],
        note: 'Keep this email as your receipt.',
      }),
    });
  }
  await toAdmin(`New course purchase: ${e.title || courseId} (${money(amount)})`, layout({ eyebrow: 'Admin alert', title: ['New course', 'purchase'], intro: `${esc(user?.full_name || 'A student')} enrolled and paid ${esc(money(amount))}.`, detailsTitle: 'Enrolment details:', rows: [['Student', `${user?.full_name || 'Unknown'} <${user?.email || 'no email'}>`], ...rows] }), ['admin', 'enrolment']);
});

/** 8: a student asked a doubt */
const doubtAsked = safe('doubtAsked', async ({ doubtId, courseId, studentName, studentEmail, lesson, question }) => {
  const c = (await pool.query('SELECT title FROM courses WHERE id = $1', [courseId])).rows[0] || {};
  await toAdmin(`New doubt from ${studentName || studentEmail}`, layout({
    eyebrow: 'Admin alert', title: ['New', 'doubt'],
    intro: `<span style="background:#F2DDA8">${esc(question).replace(/\n/g, '<br>')}</span>`,
    detailsTitle: 'Doubt details:',
    rows: [['Student', `${studentName || 'Unknown'} <${studentEmail}>`], ['Course', c.title || `#${courseId}`], ...(lesson ? [['Lesson', lesson]] : []), ['Doubt', `#${doubtId}`]],
    note: 'Answer it from the admin: Doubts. The student is emailed when you reply.',
  }), ['admin', 'doubt']);
});

/** 3: the instructor answered a doubt */
const doubtAnswered = safe('doubtAnswered', async (doubtId) => {
  const d = (await pool.query(
    `SELECT d.question, d.answer, d.student_name, d.student_email, d.course_id, c.title AS course, v.title AS lesson
       FROM course_doubts d JOIN courses c ON c.id = d.course_id LEFT JOIN course_videos v ON v.id = d.video_id WHERE d.id = $1`, [doubtId])).rows[0];
  if (!d || !d.student_email) return;
  await sendMail({
    to: [{ email: d.student_email, name: d.student_name }], tags: ['doubt-answer'],
    subject: `Your doubt was answered: ${d.course}`,
    html: layout({
      topLink: { label: 'Open the course', url: link(`#Learn/${d.course_id}`) },
      eyebrow: greet(d.student_name), title: ['Your instructor', 'replied'],
      intro: `<span style="background:#F2DDA8">${esc(d.answer).replace(/\n/g, '<br>')}</span>`,
      button: { label: 'Back to my course', url: link(`#Learn/${d.course_id}`) },
      detailsTitle: 'Your question:', rows: [['Course', d.course], ...(d.lesson ? [['Lesson', d.lesson]] : []), ['You asked', d.question]],
      nextTitle: ['Still stuck? ', 'Ask again:'], nextPoints: ['Open the course, then the Doubt chat', 'Your instructor answers here and by email'],
    }),
  });
});

/** 5 + 9: a certificate was requested */
const certificateRequested = safe('certificateRequested', async (enrollmentId) => {
  const r = (await pool.query(
    `SELECT cert.full_name, cert.title, cert.delivery_email, c.title AS course, e.student_email
       FROM certificates cert JOIN enrollments e ON e.id = cert.enrollment_id JOIN courses c ON c.id = e.course_id WHERE cert.enrollment_id = $1`, [enrollmentId])).rows[0];
  if (!r) return;
  const to = r.delivery_email || r.student_email;
  await sendMail({
    to: [{ email: to, name: r.full_name }], tags: ['certificate-request'],
    subject: `We got your certificate request: ${r.course}`,
    html: layout({
      eyebrow: greet(r.full_name), title: ['Certificate request', 'received'],
      intro: 'Congratulations on finishing enough of your course! Your instructor will check your request and approve your certificate. We will email you the moment it is ready.',
      detailsTitle: 'Your request:', rows: [['Course', r.course], ['Name on certificate', `${r.title} ${r.full_name}`]],
      nextTitle: ['What happens ', 'next:'], nextPoints: ['Your instructor reviews the request', 'We email you when the certificate is issued', 'You download it in the app: Profile, then Certificates'],
    }),
  });
  await toAdmin(`Certificate requested: ${r.title} ${r.full_name}`, layout({ eyebrow: 'Admin alert', title: ['Certificate', 'requested'], intro: `${esc(r.title)} ${esc(r.full_name)} asked for a certificate.`, detailsTitle: 'Request details:', rows: [['Student', `${r.title} ${r.full_name} <${to}>`], ['Course', r.course], ['Enrolment', `#${enrollmentId}`]], note: 'Approve it from the admin: Certificates, then upload the certificate file.' }), ['admin', 'certificate']);
});

/** 4: the certificate was issued */
const certificateIssued = safe('certificateIssued', async (enrollmentId) => {
  const r = (await pool.query(
    `SELECT cert.full_name, cert.title, cert.certificate_number, cert.issued_at, cert.delivery_email, e.course_id, c.title AS course, e.student_email
       FROM certificates cert JOIN enrollments e ON e.id = cert.enrollment_id JOIN courses c ON c.id = e.course_id WHERE cert.enrollment_id = $1`, [enrollmentId])).rows[0];
  if (!r) return;
  await sendMail({
    to: [{ email: r.delivery_email || r.student_email, name: r.full_name }], tags: ['certificate-issued'],
    subject: `Your certificate is ready: ${r.course}`,
    html: layout({
      topLink: { label: 'Download my certificate', url: link(`#Learn/${r.course_id}`) },
      eyebrow: greet(r.full_name), title: ['Your certificate', 'is ready'],
      intro: `Congratulations! Your instructor approved your certificate for <strong>${esc(r.course)}</strong>. You can download it now.`,
      button: { label: 'Download my certificate', url: link(`#Learn/${r.course_id}`) },
      detailsTitle: 'Your certificate:', rows: [['Course', r.course], ['Certificate number', r.certificate_number], ['Issued on', day(r.issued_at)]],
      nextTitle: ['Find it ', 'any time:'], nextPoints: ['In the app: Profile, then Certificates', 'On the website: open your course, then Certificate'],
    }),
  });
});

/** 10: a review was written */
const reviewPosted = safe('reviewPosted', async ({ kind, reviewer, subject, rating, text }) => {
  await toAdmin(`New ${kind} review: ${rating}/5 for ${subject}`, layout({
    eyebrow: 'Admin alert', title: [`New ${kind}`, 'review'],
    intro: text ? `<span style="background:#F2DDA8">${esc(text).replace(/\n/g, '<br>')}</span>` : 'They left a rating without a comment.',
    detailsTitle: 'Review details:',
    rows: [['Reviewer', reviewer || 'A customer'], [kind === 'course' ? 'Course' : 'Design', subject], ['Rating', `${'★'.repeat(rating)}${'☆'.repeat(5 - rating)} (${rating}/5)`]],
  }), ['admin', 'review']);
});

/** a payment failed (told to us by the Razorpay webhook) */
const paymentFailed = safe('paymentFailed', async ({ orderId, paymentId, amountPaise, reason }) => {
  const s = (await pool.query('SELECT customer_id, items FROM checkout_sessions WHERE razorpay_order_id = $1', [orderId])).rows[0];
  const user = s ? await customerOf(s.customer_id) : null;
  const what = s && !Array.isArray(s.items) && s.items?.kind === 'course' ? 'your course' : 'your designs';
  const rows = [['Amount', paiseToMoney(amountPaise)], ['Reason', reason || 'The bank or payment app did not accept it'], ['Payment id', paymentId || ''], ['Order', orderId]];
  if (user?.email) {
    await sendMail({
      to: [{ email: user.email, name: user.full_name }], tags: ['payment-failed'],
      subject: 'Your payment did not go through',
      html: layout({
        topLink: { label: 'Try the payment again', url: siteUrl() },
        eyebrow: greet(user.full_name), title: ['Payment', 'did not go through'],
        intro: `Your payment for ${what} could not be completed. <strong>You have not been charged</strong>. If any amount was deducted, your bank returns it within a few days.`,
        button: { label: 'Try again', url: siteUrl() },
        detailsTitle: 'What we know:', rows,
        nextTitle: ['To finish your ', 'purchase:'], nextPoints: ['Try again, or pick another card, UPI app or bank', 'Check that your card or UPI limit allows the amount', 'Still stuck? Reply to this email and we will help'],
      }),
    });
  }
  await toAdmin(`Payment failed${user ? `: ${user.full_name || user.email}` : ''} (${paiseToMoney(amountPaise)})`, layout({ eyebrow: 'Admin alert', title: ['Payment', 'failed'], intro: 'A shopper tried to pay and it did not go through. They have been told they were not charged.', detailsTitle: 'Payment details:', rows: [['Customer', user ? `${user.full_name || ''} <${user.email}>` : 'Not known (no checkout found)'], ...rows] }), ['admin', 'payment-failed']);
});

/** a payment was refunded (told to us by the Razorpay webhook) */
const paymentRefunded = safe('paymentRefunded', async ({ paymentId, refundId, amountPaise }) => {
  let user = null; let what = 'your payment';
  const o = (await pool.query('SELECT id, customer_id FROM orders WHERE razorpay_payment_id = $1', [paymentId])).rows[0];
  if (o) { user = await customerOf(o.customer_id); what = `order #${o.id}`; }
  else {
    const e = (await pool.query('SELECT e.customer_id, c.title FROM enrollments e JOIN courses c ON c.id = e.course_id WHERE e.razorpay_payment_id = $1', [paymentId])).rows[0];
    if (e) { user = await customerOf(e.customer_id); what = e.title; }
  }
  const rows = [['For', what], ['Refund amount', paiseToMoney(amountPaise)], ['Refund id', refundId || ''], ['Payment id', paymentId]];
  if (user?.email) {
    await sendMail({
      to: [{ email: user.email, name: user.full_name }], tags: ['refund'],
      subject: 'Your refund has been processed',
      html: layout({
        eyebrow: greet(user.full_name), title: ['Refund', 'processed'],
        intro: `We have refunded <strong>${esc(paiseToMoney(amountPaise))}</strong> for ${esc(what)}. It usually shows in your account within 5 to 7 working days, depending on your bank.`,
        detailsTitle: 'Refund details:', rows,
        nextTitle: ['When will it ', 'arrive:'], nextPoints: ['Cards: 5 to 7 working days', 'UPI and wallets: usually 1 to 3 working days', 'Not there after 10 days? Reply to this email'],
      }),
    });
  }
  await toAdmin(`Refund processed (${paiseToMoney(amountPaise)})`, layout({ eyebrow: 'Admin alert', title: ['Refund', 'processed'], intro: 'Razorpay confirmed a refund. Access to the designs or course is not removed automatically.', detailsTitle: 'Refund details:', rows: [['Customer', user ? `${user.full_name || ''} <${user.email}>` : 'Not known'], ...rows] }), ['admin', 'refund']);
});

/** a visitor sent a "contact designer" request: thank them, and tell the admin */
const designRequestReceived = safe('designRequestReceived', async ({ id, name, email, phone, requirement, notes, imageCount, source }) => {
  await sendMail({
    to: [{ email, name }], tags: ['design-request'],
    subject: 'We got your design request',
    html: layout({
      eyebrow: greet(name), title: ['Request', 'received'],
      intro: 'Thank you for contacting our designers. We have your request and will call or write to you soon.',
      detailsTitle: 'Your request:', rows: [['Request', `#${id}`], ['What you need', requirement], ...(notes ? [['Notes', notes]] : []), ['Phone', phone], ['Pictures attached', String(imageCount)]],
      nextTitle: ['What happens ', 'next:'], nextPoints: ['Our designer reads your requirement and pictures', 'We contact you on the phone number or email you gave', 'We agree the work and the price with you'],
    }),
  });
  await toAdmin(`New design request from ${name}`, layout({
    eyebrow: 'Admin alert', title: ['New design', 'request'],
    intro: `<span style="background:#F2DDA8">${esc(requirement).replace(/\n/g, '<br>')}</span>`,
    detailsTitle: 'Request details:', rows: [['Name', name], ['Phone', phone], ['Email', email], ...(notes ? [['Notes', notes]] : []), ['Pictures', String(imageCount)], ['Sent from', source === 'app' ? 'the mobile app' : 'the website'], ['Request', `#${id}`]],
    note: 'See the pictures and update the status in the admin: Design Requests.',
  }), ['admin', 'design-request']);
});

module.exports = { designRequestReceived, orderPaid, coursePurchased, doubtAsked, doubtAnswered, certificateRequested, certificateIssued, reviewPosted, paymentFailed, paymentRefunded };
