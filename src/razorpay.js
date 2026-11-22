// Razorpay helpers shared by the design checkout and the course checkout.
const razorpayBase = () => process.env.RAZORPAY_API_BASE || 'https://api.razorpay.com';

function razorpayKeys() {
  const id = process.env.RAZORPAY_KEY_ID;
  const secret = process.env.RAZORPAY_KEY_SECRET;
  if (!id || !secret) throw new Error('Razorpay keys are not set (RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET)');
  return { id, secret };
}

async function razorpayCreateOrder({ amountPaise, receipt }) {
  const { id, secret } = razorpayKeys();
  const res = await fetch(`${razorpayBase()}/v1/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}` },
    body: JSON.stringify({ amount: amountPaise, currency: 'INR', receipt }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Razorpay refused the order (${res.status}): ${body?.error?.description || 'no details'}`);
  return body;
}

const crypto = require('crypto');

/** Razorpay signs "order_id|payment_id" with the key secret; only a real payment has a matching signature */
function verifyPaymentSignature(orderId, paymentId, signature) {
  const { secret } = razorpayKeys();
  const expected = Buffer.from(crypto.createHmac('sha256', secret).update(`${orderId}|${paymentId}`).digest('hex'));
  const given = Buffer.from(String(signature || ''));
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

module.exports = { razorpayKeys, razorpayCreateOrder, verifyPaymentSignature };
